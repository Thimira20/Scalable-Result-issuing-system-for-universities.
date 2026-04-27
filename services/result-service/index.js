/**
 * RESULT SERVICE — index.js
 * Port: 4002
 *
 * Responsibility:
 *   Query exam results for a student, with a Redis cache layer in front of MySQL.
 *
 * Cache-Aside Pattern (the most common cache pattern):
 *   1. Check Redis first (fast, in-memory, O(1))
 *   2a. Cache HIT  → return data immediately, no DB query
 *   2b. Cache MISS → query MySQL, store result in Redis with TTL, return data
 *
 * Why cache results?
 *   • Exam results are read-heavy (many students refresh the page repeatedly)
 *   • They rarely change (only when admin publishes/updates)
 *   • Redis response: ~1ms.  MySQL query: ~5-50ms.  At scale, this matters enormously.
 *
 * Cache Invalidation:
 *   When Admin Service publishes new results, it calls Redis DEL on the affected keys.
 *   This service will then get a miss on the next request and re-populate from MySQL.
 *   Implemented in Admin Service (Part 3's SAGA step 2).
 */

require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { verifyJWT } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());

// ── Redis client ───────────────────────────────────────────────────────────
// ioredis automatically reconnects on connection loss.
// REDIS_URL format: redis://host:port
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('connect', () => console.log('[result-service] Connected to Redis'));
redis.on('error', (err) => console.error('[result-service] Redis error:', err.message));

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
  console.log('[result-service] Connected to MySQL (exam_db)');
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/results/health', (req, res) => {
  res.json({ status: 'ok', service: 'result-service' });
});

/**
 * GET /results/:studentId
 * Returns all published exam results for a student.
 *
 * Protected: requires a valid JWT (any role).
 * A student can only view their OWN results — we enforce this by comparing
 * studentId in the URL against user_id in the JWT payload.
 * Admins can view any student's results.
 *
 * Cache key: result:{studentId}
 * TTL: 3600 seconds (1 hour)
 */
app.get('/results/:studentId', verifyJWT, async (req, res) => {
  const { studentId } = req.params;
  const parsedId = parseInt(studentId);

  // Authorization check:
  // JWT contains user_id. A student can only see their own results.
  // Admins bypass this check.
  if (req.user.role === 'student' && req.user.user_id !== parsedId) {
    return res.status(403).json({ error: 'You can only view your own results' });
  }

  const cacheKey = `result:${parsedId}`;

  try {
    // ── Step 1: Try Redis cache ────────────────────────────────────────
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`[result-service] Cache HIT for key: ${cacheKey}`);
      return res.json({
        source: 'cache',                    // tells you where the data came from
        results: JSON.parse(cached),
      });
    }

    // ── Step 2: Cache MISS — query MySQL ──────────────────────────────
    console.log(`[result-service] Cache MISS for key: ${cacheKey} — querying MySQL`);

    const [rows] = await db.execute(
      `SELECT
         r.id,
         r.student_id,
         e.name   AS exam_name,
         e.exam_date,
         r.score,
         r.grade,
         r.published_at
       FROM results r
       LEFT JOIN exams e ON r.exam_id = e.id
       WHERE r.student_id = ?
         AND r.published_at IS NOT NULL
       ORDER BY r.published_at DESC`,
      [parsedId]
    );

    // ── Step 3: Store in Redis with TTL ───────────────────────────────
    // SETEX key seconds value: atomically SET + EXpire
    // After 3600s, Redis automatically deletes the key.
    await redis.setex(cacheKey, 3600, JSON.stringify(rows));
    console.log(`[result-service] Cached ${rows.length} results for student ${parsedId}`);

    return res.json({
      source: 'database',
      results: rows,
    });

  } catch (err) {
    console.error('[result-service] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /results/exam/:examId
 * Admin-only: list all results for a specific exam (for monitoring).
 */
app.get('/results/exam/:examId', verifyJWT, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { examId } = req.params;
  try {
    const [rows] = await db.execute(
      `SELECT r.*, e.name AS exam_name FROM results r
       LEFT JOIN exams e ON r.exam_id = e.id
       WHERE r.exam_id = ?`,
      [parseInt(examId)]
    );
    res.json({ results: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4002;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[result-service] Running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[result-service] Failed to connect to MySQL:', err.message);
  process.exit(1);
});
