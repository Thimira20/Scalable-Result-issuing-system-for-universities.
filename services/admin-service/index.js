/**
 * ADMIN SERVICE — index.js
 * Port: 4003
 *
 * Responsibility:
 *   • Accept CSV file uploads from admin users
 *   • Parse CSV and upsert results into MySQL exam_db
 *   • Invalidate Redis cache for affected students
 *   • Expose SAGA status endpoint (full SAGA orchestrator added in Part 3)
 *
 * CSV Format expected:
 *   student_id,exam_id,score,grade
 *   1,1,88.5,A
 *   2,1,72.0,B
 *
 * Multer:
 *   multer is Express middleware for handling multipart/form-data (file uploads).
 *   We use memoryStorage() — the file lives in RAM as a Buffer, never touches disk.
 *   This is fine for CSVs (small files). For large files, use diskStorage instead.
 *
 * SAGA Note:
 *   In Part 3, we'll wrap the upload logic in a SAGA Orchestrator.
 *   For now, it does a simple upsert + cache invalidation without formal saga tracking.
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');  // synchronous CSV parser
const Redis = require('ioredis');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { verifyJWT, requireAdmin } = require('./middleware/auth');

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
 * Steps (simplified — SAGA wrapper added in Part 3):
 *   1. Parse CSV bytes → array of result objects
 *   2. Bulk upsert into MySQL exam_db.results
 *   3. Invalidate Redis cache for each unique student_id in the CSV
 *   4. Mark published_at = NOW() for all upserted rows
 *
 * Body (form-data):
 *   file: <csv file>
 *
 * Auth: Bearer token with role=admin
 */
app.post('/admin/upload', verifyJWT, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  let records;
  try {
    // csv-parse/sync parses synchronously and returns an array of objects.
    // columns: true → uses the first row as property names
    // skip_empty_lines: true → ignores blank lines
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

  // Validate required columns
  const requiredCols = ['student_id', 'exam_id', 'score', 'grade'];
  const csvCols = Object.keys(records[0]);
  const missing = requiredCols.filter(c => !csvCols.includes(c));
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing columns: ${missing.join(', ')}` });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // ── Step 1: Bulk upsert ──────────────────────────────────────────
    // INSERT ... ON DUPLICATE KEY UPDATE handles re-uploads:
    //   If (student_id, exam_id) already exists → update score, grade, published_at
    //   If not → insert a new row
    // This is safe to call multiple times with the same data (idempotent).
    const affectedStudentIds = new Set();

    for (const row of records) {
      const studentId = parseInt(row.student_id);
      const examId = parseInt(row.exam_id);
      const score = parseFloat(row.score);
      const grade = row.grade.trim().toUpperCase();

      await conn.execute(
        `INSERT INTO results (student_id, exam_id, score, grade, published_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           score = VALUES(score),
           grade = VALUES(grade),
           published_at = NOW()`,
        [studentId, examId, score, grade]
      );

      affectedStudentIds.add(studentId);
    }

    await conn.commit();
    console.log(`[admin-service] Upserted ${records.length} results, affecting students: [${[...affectedStudentIds].join(', ')}]`);

    // ── Step 2: Invalidate Redis cache ───────────────────────────────
    // For each student whose results changed, delete their cache key.
    // Next time they query Result Service, it will be a cache miss
    // and fresh data will be fetched from MySQL.
    const cacheKeys = [...affectedStudentIds].map(id => `result:${id}`);
    if (cacheKeys.length > 0) {
      await redis.del(...cacheKeys);  // redis.del accepts multiple keys
      console.log(`[admin-service] Invalidated Redis cache keys: ${cacheKeys.join(', ')}`);
    }

    // Step 3: Debezium (Part 2) will automatically detect the MySQL binlog
    // changes and publish events to Kafka → RabbitMQ → Notification Service.

    res.json({
      message: 'Results published successfully',
      rowsProcessed: records.length,
      studentsAffected: [...affectedStudentIds],
    });

  } catch (err) {
    await conn.rollback();
    console.error('[admin-service] Upload failed, transaction rolled back:', err.message);
    res.status(500).json({ error: 'Upload failed', detail: err.message });
  } finally {
    conn.release();
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
       JOIN exams e ON r.exam_id = e.id
       ORDER BY r.published_at DESC`
    );
    res.json({ results: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/saga/:sagaId
 * Returns the current state of a SAGA workflow.
 * Full SAGA implementation added in Part 3.
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
    res.json(rows[0]);
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
