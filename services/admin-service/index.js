/**
 * ADMIN SERVICE — index.js  (Part 3: SAGA Orchestrator integrated)
 * Port: 4003
 *
 * What changed from Part 1/2:
 *   ✅ POST /admin/upload now delegates to runPublishSAGA() instead of
 *      doing inline MySQL + Redis work. The SAGA tracks every step in the
 *      saga_state table and runs compensations if anything fails.
 *
 * How the SAGA fits into the upload flow:
 *
 *   Browser/curl                Admin Service              saga_state table
 *       │                           │                            │
 *       │── POST /admin/upload ────►│                            │
 *       │   (CSV file + JWT)        │── INSERT saga row ────────►│
 *       │                           │   { status: STARTED }      │
 *       │                           │── Step 1: MySQL upsert     │
 *       │                           │── UPDATE saga ────────────►│
 *       │                           │   { status: IN_PROGRESS }  │
 *       │                           │── Step 2: Redis DEL        │
 *       │                           │── UPDATE saga ────────────►│
 *       │                           │   { status: COMPLETED }    │
 *       │◄── 200 { sagaId } ────────│                            │
 *       │                           │                            │
 *       │── GET /admin/saga/:id ───►│── SELECT saga_state ──────►│
 *       │◄── { status, step, ... }──│                            │
 */

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const Redis   = require('ioredis');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const { verifyJWT, requireAdmin } = require('./middleware/auth');
// NEW in Part 3: the SAGA orchestrator
const { runPublishSAGA } = require('./saga/orchestrator');

const app = express();
app.use(cors());
app.use(express.json());

// ── Multer: in-memory file storage ────────────────────────────────────────
// memoryStorage() keeps the uploaded file in req.file.buffer (a Node.js Buffer).
// We'll convert it to a string and feed it to csv-parse.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },           // 5 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
});

// ── Redis client ───────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('connect', () => console.log('[admin-service] Connected to Redis'));
redis.on('error', (err) => console.error('[admin-service] Redis error:', err.message));

// ── MySQL connection pool ──────────────────────────────────────────────────
let db;
async function initDB() {
  db = await mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,  // exam_db
    waitForConnections: true,
    connectionLimit: 10,
  });
  console.log('[admin-service] Connected to MySQL (exam_db)');
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/admin/health', (req, res) => {
  res.json({ status: 'ok', service: 'admin-service' });
});

/**
 * GET /admin/exams
 * Returns list of all exams.
 * Admin only.
 */
app.get('/admin/exams', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM exams ORDER BY exam_date DESC');
    res.json({ exams: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/upload
 * Accepts a multipart form with a 'file' field (CSV).
 *
 * Flow (Part 3 — SAGA-wrapped):
 *   1. Parse + validate the CSV (before SAGA starts — fast-fail on bad input)
 *   2. Hand records to runPublishSAGA() which orchestrates:
 *        Step 1 → bulk upsert to MySQL
 *        Step 2 → delete Redis cache keys
 *        (Step 3 fires automatically via Debezium)
 *   3. Return 200 with sagaId so admin can poll GET /admin/saga/:sagaId
 */
app.post('/admin/upload', verifyJWT, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Parse CSV before starting SAGA — reject bad input without touching DB
  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (parseErr) {
    return res.status(400).json({ error: 'Invalid CSV format', detail: parseErr.message });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: 'CSV file is empty' });
  }

  const requiredCols = ['student_id', 'exam_id', 'score', 'grade'];
  const csvCols = Object.keys(records[0]);
  const missing = requiredCols.filter(c => !csvCols.includes(c));
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing CSV columns: ${missing.join(', ')}` });
  }

  // Delegate all DB + cache work to the SAGA orchestrator.
  // If any step fails, compensations run automatically inside runPublishSAGA.
  try {
    const result = await runPublishSAGA(db, redis, records);

    return res.status(200).json({
      message: 'Results published successfully',
      sagaId: result.sagaId,
      status: result.status,
      rowsProcessed: records.length,
      studentsAffected: result.payload.affectedStudentIds,
      cacheKeysInvalidated: result.payload.deletedCacheKeys,
    });

  } catch (sagaErr) {
    // SAGA failed — compensations already ran inside runPublishSAGA.
    console.error('[admin-service] SAGA failed:', sagaErr.message);
    return res.status(500).json({
      error: 'Upload failed — SAGA rolled back all changes',
      detail: sagaErr.message,
    });
  }
});

/**
 * GET /admin/results
 * Returns all results in the system (admin monitoring).
 */
app.get('/admin/results', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT r.*, e.name AS exam_name FROM results r
       LEFT JOIN exams e ON r.exam_id = e.id
       ORDER BY r.published_at DESC`
    );
    res.json({ results: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/saga/:sagaId
 * Returns the current state of a specific SAGA run.
 *
 * Poll this after POST /admin/upload gives you a sagaId.
 * status field tells you exactly what happened:
 *   STARTED      → SAGA created, no steps done yet
 *   IN_PROGRESS  → Step 1 (MySQL) done, Step 2 in progress
 *   COMPLETED    → Both steps done, Debezium handling Step 3
 *   FAILED       → Step 1 failed, nothing written
 *   COMPENSATING → Step 2 failed, running undo operations
 *   COMPENSATED  → All changes rolled back successfully
 */
app.get('/admin/saga/:sagaId', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM saga_state WHERE saga_id = ?',
      [req.params.sagaId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'SAGA not found' });
    }
    const saga = rows[0];
    // payload is stored as a JSON string in MySQL — parse it for a clean response
    if (typeof saga.payload === 'string') {
      saga.payload = JSON.parse(saga.payload);
    }
    res.json(saga);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/sagas
 * Returns the 20 most recent SAGA runs.
 * Admin dashboard uses this to show upload history.
 */
app.get('/admin/sagas', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT saga_id, type, step, status, created_at, updated_at
       FROM saga_state
       ORDER BY created_at DESC
       LIMIT 20`
    );
    res.json({ sagas: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4003;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[admin-service] Running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[admin-service] Failed to connect to MySQL:', err.message);
  process.exit(1);
});
