/**
 * SAGA ORCHESTRATOR — saga/orchestrator.js
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS A SAGA? (Start here if you're new to this)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Problem:
 *   In a microservice system, a single business operation (like "publish
 *   exam results") touches MULTIPLE resources:
 *     • MySQL (write results)
 *     • Redis  (delete cache)
 *     • Debezium fires automatically (Step 3)
 *
 *   You CANNOT wrap all of these in a single database ACID transaction
 *   because Redis and MySQL are separate systems with no shared transaction
 *   coordinator. If MySQL succeeds but Redis fails, your data is inconsistent.
 *
 * Solution — SAGA Pattern:
 *   Break the operation into a SEQUENCE of local transactions.
 *   Each step has a "compensating action" — an undo operation.
 *   If any step fails, you run compensations IN REVERSE to roll back.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OUR 3-STEP SAGA: "PUBLISH_RESULTS"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │                     HAPPY PATH (no failures)                        │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 *  [START]
 *    │  Create saga_state row: { status: STARTED, step: 0 }
 *    │
 *    ▼  ═══ STEP 1 ═══════════════════════════════════════════════════════
 *  Bulk UPSERT CSV rows → MySQL exam_db.results
 *    │  ✅ Success → saga_state: { status: IN_PROGRESS, step: 1 }
 *    │              payload stores: which (student_id, exam_id) pairs were written
 *    │
 *    ▼  ═══ STEP 2 ═══════════════════════════════════════════════════════
 *  DEL Redis keys result:{student_id} for all affected students
 *    │  ✅ Success → saga_state: { status: COMPLETED, step: 2 }
 *    │
 *    ▼  ═══ STEP 3 ═══════════════════════════════════════════════════════
 *  Debezium reads MySQL binlog → Kafka → Bridge → RabbitMQ → Email
 *    │  (AUTOMATIC — we don't call any code here)
 *    │  (No compensation needed — if email fails, it's handled separately)
 *    │
 *    ▼
 *  Return 200 OK  { sagaId, status: COMPLETED }
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │                    FAILURE PATHS + COMPENSATIONS                    │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 *  Failure at Step 1 (MySQL upsert fails):
 *  ─────────────────────────────────────────
 *  [START] → Step 1 ❌
 *    Nothing was written → nothing to undo
 *    saga_state: { status: FAILED, step: 1 }
 *    Return 500
 *
 *  Failure at Step 2 (Redis DEL fails):
 *  ─────────────────────────────────────
 *  [START] → Step 1 ✅ → Step 2 ❌
 *    Compensation runs in REVERSE:
 *    ↩ Compensate Step 1: DELETE rows we just inserted from MySQL
 *    saga_state: { status: COMPENSATING } → { status: COMPENSATED }
 *    Return 500
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY TRACK STATE IN saga_state TABLE?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. DURABILITY: If the Node.js process crashes mid-SAGA, the DB still
 *     holds the last known state. An admin can query it and know exactly
 *     what happened. A future background job could retry/compensate.
 *
 *  2. OBSERVABILITY: GET /admin/saga/:sagaId shows exactly which step
 *     succeeded, what was in the payload, and when it happened.
 *
 *  3. DEBUGGING: Instead of "the upload failed", you can say
 *     "SAGA abc-123 failed at step 2, compensation ran successfully".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * saga_state TABLE SCHEMA (reminder from 02-exam-db.sql):
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  saga_id    VARCHAR(36)  ← UUID generated at the start
 *  type       VARCHAR(100) ← 'PUBLISH_RESULTS'
 *  step       INT          ← 0=started, 1=after MySQL, 2=after Redis
 *  status     ENUM         ← STARTED | IN_PROGRESS | COMPLETED |
 *                            FAILED | COMPENSATING | COMPENSATED
 *  payload    JSON         ← stores context needed by compensating actions
 *  created_at DATETIME
 *  updated_at DATETIME      ← auto-updated on every row change
 */

const { v4: uuidv4 } = require('uuid');

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Update saga_state row after each step
// ══════════════════════════════════════════════════════════════════════════

/**
 * persistSagaState()
 * Writes the current SAGA progress to the database.
 * Called after EVERY step — both successes and failures.
 *
 * @param {Object} db        - mysql2 pool
 * @param {string} sagaId    - UUID of this SAGA run
 * @param {number} step      - Which step just completed (0, 1, 2)
 * @param {string} status    - STARTED | IN_PROGRESS | COMPLETED | FAILED | COMPENSATING | COMPENSATED
 * @param {Object} payload   - Context data (stored as JSON) for compensations
 */
async function persistSagaState(db, sagaId, step, status, payload) {
  await db.execute(
    `UPDATE saga_state
     SET step = ?, status = ?, payload = ?, updated_at = NOW()
     WHERE saga_id = ?`,
    [step, status, JSON.stringify(payload), sagaId]
  );
  console.log(`[SAGA ${sagaId}] State saved → step=${step}, status=${status}`);
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 1: Bulk upsert CSV results into MySQL
// ══════════════════════════════════════════════════════════════════════════

/**
 * step1_upsertResults()
 *
 * What it does:
 *   Takes the parsed CSV rows and bulk-inserts them into exam_db.results.
 *   Uses ON DUPLICATE KEY UPDATE so re-uploading the same CSV is safe (idempotent).
 *
 * Compensating action (compensate1):
 *   DELETE all rows that match the (student_id, exam_id) pairs from this upload.
 *   This undoes everything step 1 wrote.
 *
 * NOTE on "saga_id" column:
 *   In a production system, you'd add a `saga_id` column to the results table
 *   so you can cleanly DELETE WHERE saga_id = ? during compensation.
 *   Here, we store the pairs in payload and DELETE by (student_id, exam_id).
 *
 * @returns {{ affectedStudentIds: Set, affectedPairs: Array }}
 */
async function step1_upsertResults(db, records) {
  const affectedStudentIds = new Set();
  const affectedPairs = [];  // stored in payload for compensation

  // Use a single MySQL connection with a transaction for atomicity.
  // If ANY row in the batch fails, the whole batch rolls back.
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    for (const row of records) {
      const studentId = parseInt(row.student_id);
      const examId    = parseInt(row.exam_id);
      const score     = parseFloat(row.score);
      const grade     = row.grade.trim().toUpperCase();

      // INSERT ... ON DUPLICATE KEY UPDATE:
      //   The UNIQUE KEY on (student_id, exam_id) prevents duplicates.
      //   • If the pair is NEW       → INSERT a fresh row
      //   • If the pair EXISTS       → UPDATE score, grade, published_at
      //   This makes re-uploads idempotent (safe to call multiple times).
      await conn.execute(
        `INSERT INTO results (student_id, exam_id, score, grade, published_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           score        = VALUES(score),
           grade        = VALUES(grade),
           published_at = NOW()`,
        [studentId, examId, score, grade]
      );

      affectedStudentIds.add(studentId);
      affectedPairs.push({ student_id: studentId, exam_id: examId });
    }

    await conn.commit();
    console.log(`[SAGA] Step 1 ✅ Upserted ${records.length} rows for students: [${[...affectedStudentIds].join(', ')}]`);

  } catch (err) {
    await conn.rollback();
    throw new Error(`Step 1 failed (MySQL upsert): ${err.message}`);
  } finally {
    conn.release();
  }

  return { affectedStudentIds, affectedPairs };
}

// ══════════════════════════════════════════════════════════════════════════
// COMPENSATE STEP 1: Delete the rows we upserted
// ══════════════════════════════════════════════════════════════════════════

/**
 * compensate1_deleteResults()
 *
 * Runs when Step 2 fails AFTER Step 1 succeeded.
 * Deletes all (student_id, exam_id) pairs that were inserted/updated in Step 1.
 *
 * ⚠️  Known limitation for learning purposes:
 *   If a result row already existed BEFORE this upload (with different values),
 *   this compensation will delete it entirely instead of restoring the old values.
 *   In a production system you would:
 *     • Save the "before" state of each row in the saga payload before upserting
 *     • Restore the old values (or delete if it was a new insert)
 *   This is called "event sourcing" when taken further.
 */
async function compensate1_deleteResults(db, affectedPairs) {
  if (!affectedPairs || affectedPairs.length === 0) return;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    for (const { student_id, exam_id } of affectedPairs) {
      await conn.execute(
        'DELETE FROM results WHERE student_id = ? AND exam_id = ?',
        [student_id, exam_id]
      );
    }

    await conn.commit();
    console.log(`[SAGA] ↩ Compensate Step 1 ✅ Deleted ${affectedPairs.length} result rows`);
  } catch (err) {
    await conn.rollback();
    // Compensation itself failed — this is a critical situation.
    // Log loudly; a human needs to intervene.
    console.error(`[SAGA] ↩ Compensate Step 1 ❌ CRITICAL: ${err.message}`);
    console.error('[SAGA] Manual intervention required — DB may be inconsistent');
    throw err;
  } finally {
    conn.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// STEP 2: Invalidate Redis cache for affected students
// ══════════════════════════════════════════════════════════════════════════

/**
 * step2_invalidateCache()
 *
 * What it does:
 *   Deletes result:{studentId} keys from Redis for every student whose
 *   results were just updated in Step 1.
 *
 * Why is this needed?
 *   Result Service uses a Cache-Aside pattern. If the cache still holds
 *   old results after an upload, students would see stale data for up to 1 hour.
 *   Deleting the cache key forces a cache MISS on the next request, causing
 *   Result Service to fetch fresh data from MySQL.
 *
 * Compensating action (compensate2):
 *   If Step 2 fails partway through (e.g., some keys deleted, some not),
 *   we re-populate the cache with the data that's currently in MySQL.
 *   This ensures the cache reflects the DB state, even if Step 1 was rolled back.
 *
 * @returns {{ deletedKeys: string[] }}
 */
async function step2_invalidateCache(redis, affectedStudentIds) {
  const studentIdArray = [...affectedStudentIds];
  const cacheKeys = studentIdArray.map(id => `result:${id}`);

  if (cacheKeys.length === 0) return { deletedKeys: [] };

  try {
    // redis.del() accepts multiple keys and atomically deletes all of them.
    await redis.del(...cacheKeys);
    console.log(`[SAGA] Step 2 ✅ Invalidated Redis keys: [${cacheKeys.join(', ')}]`);
    return { deletedKeys: cacheKeys };
  } catch (err) {
    throw new Error(`Step 2 failed (Redis cache invalidation): ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// COMPENSATE STEP 2: Re-populate Redis cache from MySQL
// ══════════════════════════════════════════════════════════════════════════

/**
 * compensate2_recacheResults()
 *
 * Runs when Step 2 fails (but Step 1 was already compensated by then).
 *
 * Wait — if Step 1 was compensated (rows deleted from MySQL),
 * why do we re-cache? Because:
 *   • Some Redis keys may have already been deleted before Step 2 failed.
 *   • Those students now have NO cache entry at all.
 *   • Result Service will hit MySQL on the next request — that's fine!
 *     But MySQL now has their OLD results (Step 1 was rolled back).
 *   • So we re-cache their OLD results so the cache reflects reality.
 *
 * If MySQL has no results for a student, we just ensure the key is absent
 * (which it already is after DEL — so nothing to do).
 *
 * Cache key format and TTL must MATCH Result Service exactly:
 *   key: result:{studentId}
 *   TTL: 3600 seconds
 */
async function compensate2_recacheResults(db, redis, affectedStudentIds) {
  const studentIdArray = [...affectedStudentIds];

  for (const studentId of studentIdArray) {
    try {
      // Query the same way Result Service does (so cache format is identical)
      const [rows] = await db.execute(
        `SELECT r.id, r.student_id, e.name AS exam_name, e.exam_date,
                r.score, r.grade, r.published_at
         FROM results r
         JOIN exams e ON r.exam_id = e.id
         WHERE r.student_id = ? AND r.published_at IS NOT NULL
         ORDER BY r.published_at DESC`,
        [studentId]
      );

      if (rows.length > 0) {
        // Re-populate cache with current (post-compensation) MySQL state
        await redis.setex(`result:${studentId}`, 3600, JSON.stringify(rows));
        console.log(`[SAGA] ↩ Compensate Step 2 ✅ Re-cached ${rows.length} results for student ${studentId}`);
      } else {
        // No results in DB — ensure key is absent (nothing to cache)
        await redis.del(`result:${studentId}`);
        console.log(`[SAGA] ↩ Compensate Step 2 ✅ No results for student ${studentId}, key cleared`);
      }
    } catch (err) {
      // Log but continue — partial re-cache is better than no re-cache
      console.error(`[SAGA] ↩ Compensate Step 2 ❌ student ${studentId}: ${err.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN: runPublishSAGA()
// ══════════════════════════════════════════════════════════════════════════

/**
 * runPublishSAGA()
 *
 * The main SAGA runner. Orchestrates all steps and compensations.
 * Returns the sagaId so the caller can expose it to the admin.
 *
 * State machine:
 *
 *  STARTED
 *    │
 *    ├─ Step 1 ✅ ──► IN_PROGRESS (step=1)
 *    │                    │
 *    │                    ├─ Step 2 ✅ ──► COMPLETED (step=2)   ← return 200
 *    │                    │
 *    │                    └─ Step 2 ❌ ──► COMPENSATING
 *    │                                         │
 *    │                                         └─ Compensate 1 ──► COMPENSATED ← return 500
 *    │
 *    └─ Step 1 ❌ ──► FAILED (step=1)   ← return 500
 *
 * @param {Object} db      - mysql2 pool
 * @param {Object} redis   - ioredis client
 * @param {Array}  records - parsed CSV rows [{ student_id, exam_id, score, grade }]
 * @returns {Promise<{ sagaId, status, step, payload }>}
 */
async function runPublishSAGA(db, redis, records) {
  // Generate a unique ID for this SAGA run (UUID v4)
  const sagaId = uuidv4();

  // Payload accumulates context across steps.
  // Each step ADDS to it so compensations have what they need.
  let payload = {
    csvRowCount: records.length,
    affectedPairs: [],
    affectedStudentIds: [],
    deletedCacheKeys: [],
  };

  // ── Create the saga_state row ────────────────────────────────────────────
  // We persist this BEFORE doing any real work.
  // Reason: if the process crashes between creating the row and finishing step 1,
  // an admin can see the SAGA in STARTED state and investigate.
  await db.execute(
    `INSERT INTO saga_state (saga_id, type, step, status, payload)
     VALUES (?, 'PUBLISH_RESULTS', 0, 'STARTED', ?)`,
    [sagaId, JSON.stringify(payload)]
  );
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[SAGA ${sagaId}] ▶ STARTED — ${records.length} rows to process`);
  console.log(`${'═'.repeat(60)}`);

  // ── STEP 1: Upsert into MySQL ────────────────────────────────────────────
  console.log(`[SAGA ${sagaId}] ── Step 1: Upserting results into MySQL...`);
  let affectedStudentIds, affectedPairs;
  try {
    ({ affectedStudentIds, affectedPairs } = await step1_upsertResults(db, records));

    // Update payload with step 1 results (needed by compensate1)
    payload.affectedPairs = affectedPairs;
    payload.affectedStudentIds = [...affectedStudentIds];
    payload.step1CompletedAt = new Date().toISOString();

    await persistSagaState(db, sagaId, 1, 'IN_PROGRESS', payload);

  } catch (step1Err) {
    // Step 1 failed — nothing was written to MySQL, no compensation needed
    console.error(`[SAGA ${sagaId}] ── Step 1 ❌ FAILED:`, step1Err.message);
    await persistSagaState(db, sagaId, 1, 'FAILED', { ...payload, error: step1Err.message });
    throw step1Err;  // propagates to the route handler → returns 500
  }

  // ── STEP 2: Invalidate Redis cache ───────────────────────────────────────
  console.log(`[SAGA ${sagaId}] ── Step 2: Invalidating Redis cache...`);
  try {
    const { deletedKeys } = await step2_invalidateCache(redis, affectedStudentIds);

    payload.deletedCacheKeys = deletedKeys;
    payload.step2CompletedAt = new Date().toISOString();

    await persistSagaState(db, sagaId, 2, 'COMPLETED', payload);

    console.log(`[SAGA ${sagaId}] ✅ COMPLETED — returning 200`);
    console.log(`${'═'.repeat(60)}\n`);

    return { sagaId, status: 'COMPLETED', step: 2, payload };

  } catch (step2Err) {
    console.error(`[SAGA ${sagaId}] ── Step 2 ❌ FAILED:`, step2Err.message);
    console.log(`[SAGA ${sagaId}] ── Starting compensation (reverse order)...`);
    await persistSagaState(db, sagaId, 2, 'COMPENSATING', { ...payload, error: step2Err.message });

    // ── Compensation: Undo Step 2 (re-cache any keys that got deleted) ──
    // (runs even though step 1 is about to be compensated — ensures cache = DB truth)
    await compensate2_recacheResults(db, redis, affectedStudentIds);

    // ── Compensation: Undo Step 1 (delete rows we upserted) ─────────────
    await compensate1_deleteResults(db, affectedPairs);

    await persistSagaState(db, sagaId, 2, 'COMPENSATED', payload);
    console.log(`[SAGA ${sagaId}] ↩ COMPENSATED — all changes rolled back`);
    console.log(`${'═'.repeat(60)}\n`);

    throw step2Err;  // propagates to the route handler → returns 500
  }
}

module.exports = { runPublishSAGA };
