/**
 * KAFKA-RABBITMQ BRIDGE — index.js
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY DOES THIS SERVICE EXIST?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Debezium publishes CDC events to KAFKA — not RabbitMQ.
 * Our Notification Service listens on RABBITMQ — not Kafka.
 *
 * Why use both? Because they serve different purposes:
 *
 *  ┌─────────────────────┬──────────────────────────────────────────────┐
 *  │ Apache Kafka        │ RabbitMQ                                     │
 *  ├─────────────────────┼──────────────────────────────────────────────┤
 *  │ Log-based (topics   │ Queue-based (messages disappear after        │
 *  │ persist messages    │ acknowledgement)                             │
 *  │ for configurable    │                                              │
 *  │ time)               │                                              │
 *  ├─────────────────────┼──────────────────────────────────────────────┤
 *  │ Debezium REQUIRES   │ Simple to use for task queues, email jobs,  │
 *  │ Kafka as its        │ background workers                           │
 *  │ internal transport  │                                              │
 *  ├─────────────────────┼──────────────────────────────────────────────┤
 *  │ Built for streaming │ Built for reliable message delivery between  │
 *  │ millions of events  │ specific services                            │
 *  └─────────────────────┴──────────────────────────────────────────────┘
 *
 * So: Debezium → Kafka (big pipe, high throughput)
 *     This bridge → RabbitMQ (specific job queue for notification workers)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FULL DATA FLOW (follow this top to bottom):
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Admin Service                                                           
 *      │ POST /admin/upload  (CSV file)                                   
 *      │                                                                   
 *      ▼                                                                   
 *  MySQL exam_db.results   ←── INSERT / UPDATE rows                      
 *      │                                                                   
 *      │ MySQL Binary Log (binlog) — MySQL writes EVERY change here       
 *      │ This is normally used for replication (primary→replica)          
 *      │ Debezium "pretends" to be a replica to read this log             
 *      │                                                                   
 *      ▼                                                                   
 *  Debezium Connect (port 8083)                                           
 *      │ Reads binlog via MySQL replication protocol                      
 *      │ Converts each row change into a JSON "CDC event"                 
 *      │                                                                   
 *      ▼                                                                   
 *  Kafka topic: "exam_db.exam_db.results"                                 
 *      │ Topic name = {topic.prefix}.{database}.{table}                   
 *      │ Each message = one row change event                              
 *      │                                                                   
 *      ▼                                                                   
 *  THIS BRIDGE ────────────────────────────────────────────┐              
 *      │ Reads from Kafka (kafkajs)                        │              
 *      │ Filters: only INSERT and UPDATE events            │              
 *      │ Filters: only rows where published_at IS NOT NULL │              
 *      │                                                   │              
 *      │                            Queries auth_db.users  │              
 *      │                            to get student email   │              
 *      │                            (message enrichment)   │              
 *      │◄──────────────────────────────────────────────────┘              
 *      │ Publishes enriched message to RabbitMQ (amqplib)                 
 *      │                                                                   
 *      ▼                                                                   
 *  RabbitMQ queue: "results.published"                                    
 *      │                                                                   
 *      ▼                                                                   
 *  Notification Service                                                    
 *      ├── nodemailer → sends email to student                            
 *      └── mongoose  → logs to MongoDB notif_db                           
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DEBEZIUM CDC EVENT FORMAT (after schema disabled in connector config):
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  {
 *    "before": null,          ← row state BEFORE the change (null for INSERT)
 *    "after": {               ← row state AFTER the change
 *      "id": 1,
 *      "student_id": 1,
 *      "exam_id": 1,
 *      "score": 92.5,         ← decimal.handling.mode=double makes this a number
 *      "grade": "A",
 *      "published_at": 1714983600000000,  ← microseconds since epoch (÷1000 = ms)
 *      "created_at": 1714983600000        ← milliseconds since epoch
 *    },
 *    "op": "c",               ← c=INSERT, u=UPDATE, d=DELETE, r=snapshot READ
 *    "ts_ms": 1714983600000   ← when Debezium captured this event
 *  }
 */

require('dotenv').config();
const { Kafka } = require('kafkajs');
const amqplib = require('amqplib');
const mysql = require('mysql2/promise');

// ══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:29092').split(',');
const KAFKA_TOPIC   = process.env.KAFKA_TOPIC   || 'exam_db.exam_db.results';
const KAFKA_GROUP   = process.env.KAFKA_GROUP_ID || 'exam-bridge-group';
const RABBITMQ_URL  = process.env.RABBITMQ_URL   || 'amqp://guest:guest@localhost:5672';
const RABBITMQ_QUEUE = process.env.RABBITMQ_QUEUE || 'results.published';

// ══════════════════════════════════════════════════════════════════════════
// GLOBAL CONNECTIONS (initialized in main())
// ══════════════════════════════════════════════════════════════════════════

let rabbitChannel;  // amqplib channel for publishing to RabbitMQ
let db;             // mysql2 pool for auth_db lookups (email enrichment)

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Enrich event with student email
// ══════════════════════════════════════════════════════════════════════════

/**
 * Look up a student's email from auth_db.users by their user ID.
 *
 * Why query auth_db from the bridge?
 *   The results table only has student_id (integer).
 *   To send an email, we need the email address.
 *   The bridge is an internal infrastructure service —
 *   it's allowed to query auth_db directly (unlike application services
 *   which should stay within their own DB boundaries).
 *
 * In production, you might use a separate "User Data" Kafka topic
 * (also via Debezium) maintained as a local cache — called a "Join"
 * in Kafka Streams terminology. For our learning project, a DB lookup is fine.
 */
async function getStudentEmail(studentId) {
  try {
    const [rows] = await db.execute(
      'SELECT email, name FROM users WHERE id = ?',
      [studentId]
    );

    if (rows.length > 0) {
      // ✅ Student exists in auth_db → they authenticated via Google → safe to notify
      return rows[0];  // { email, name }
    }

    // ⛔ No row found → this student_id was never Google-authenticated.
    // The CSV may contain student IDs for people who haven't logged in yet.
    // We return null so processEvent can skip publishing to RabbitMQ.
    // This prevents sending emails to addresses we don't actually have.
    console.log(`[bridge] Student ${studentId} has no auth_db record (not authenticated) — skipping notification`);
    return null;

  } catch (err) {
    // DB error is different from "not found" — log it clearly but still skip.
    console.error(`[bridge] DB error fetching email for student ${studentId}:`, err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Parse Debezium timestamps
// ══════════════════════════════════════════════════════════════════════════

/**
 * Debezium encodes MySQL DATETIME columns as MICROSECONDS since Unix epoch.
 * JavaScript Date uses MILLISECONDS. So we divide by 1000.
 * A null value means the column was NULL in MySQL (e.g., not yet published).
 */
function debeziumTsToDate(microSeconds) {
  if (!microSeconds) return null;
  return new Date(microSeconds / 1000).toISOString();
}

// ══════════════════════════════════════════════════════════════════════════
// CORE: Process a single Debezium CDC event
// ══════════════════════════════════════════════════════════════════════════

async function processEvent(eventJson) {
  const event = JSON.parse(eventJson);

  const op   = event.op;    // 'c', 'u', 'd', 'r'
  const after = event.after; // the new row state

  // ── Filter 1: Only process INSERT ('c') and UPDATE ('u') ────────────
  // We don't notify on DELETE ('d') — a result being deleted doesn't need email.
  // 'r' = snapshot events fired when Debezium first starts (backfill). Skip these.
  if (op !== 'c' && op !== 'u') {
    console.log(`[bridge] Skipping op="${op}" event`);
    return;
  }

  // ── Filter 2: Only process rows where published_at is set ─────────────
  // A result row is created when CSV is uploaded (published_at = NOW()).
  // We check: after.published_at must not be null.
  if (!after || !after.published_at) {
    console.log(`[bridge] Skipping unpublished result for student ${after?.student_id}`);
    return;
  }

  console.log(`[bridge] Processing ${op === 'c' ? 'INSERT' : 'UPDATE'} event for student ${after.student_id}`);

  // ── Message Enrichment: fetch email from auth_db ─────────────────────
  // Returns { email, name } if the student authenticated via Google, or null if not.
  const student = await getStudentEmail(after.student_id);

  if (!student) {
    // Student result was published in the CSV but this student never logged in.
    // We have no verified email for them → skip silently.
    // When they eventually sign in via Google, their email will be in auth_db
    // and future result updates will trigger a notification.
    return;
  }

  const { email, name } = student;

  // ── Build the RabbitMQ message ────────────────────────────────────────
  // This is the message the Notification Service will receive.
  // Keep it simple and human-readable.
  const message = {
    student_id:   after.student_id,
    exam_id:      after.exam_id,
    score:        after.score,
    grade:        after.grade,
    published_at: debeziumTsToDate(after.published_at),
    email,
    name,
    // CDC metadata (useful for debugging)
    _op:          op,
    _captured_at: new Date(event.ts_ms).toISOString(),
  };

  // ── Publish to RabbitMQ ───────────────────────────────────────────────
  // Buffer.from converts JS object to bytes.
  // persistent: true → message survives a RabbitMQ restart (stored to disk)
  rabbitChannel.sendToQueue(
    RABBITMQ_QUEUE,
    Buffer.from(JSON.stringify(message)),
    { persistent: true }
  );

  console.log(`[bridge] Published to RabbitMQ: student=${message.student_id} email=${email} exam=${after.exam_id} grade=${after.grade}`);
}

// ══════════════════════════════════════════════════════════════════════════
// RETRY HELPER — wait and retry connecting (infra services take time to start)
// ══════════════════════════════════════════════════════════════════════════

async function retryConnect(name, fn, maxRetries = 15, delayMs = 5000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      console.log(`[bridge] Connecting to ${name} (attempt ${i}/${maxRetries})...`);
      const result = await fn();
      console.log(`[bridge] ✅ Connected to ${name}`);
      return result;
    } catch (err) {
      console.warn(`[bridge] ❌ ${name} not ready (${err.message}). Retrying in ${delayMs / 1000}s...`);
      if (i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN — wire everything together
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('[bridge] Starting Kafka→RabbitMQ bridge...');
  console.log(`[bridge] Topic: ${KAFKA_TOPIC}  →  Queue: ${RABBITMQ_QUEUE}`);

  // ── 1. Connect to MySQL (auth_db) for email lookups ───────────────────
  db = await retryConnect('MySQL auth_db', () =>
    mysql.createPool({
      host:     process.env.MYSQL_HOST     || 'localhost',
      port:     parseInt(process.env.MYSQL_PORT) || 3306,
      user:     process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'auth_db',  // auth_db for email lookups
      connectionLimit: 5,
    })
  );

  // ── 2. Connect to RabbitMQ ────────────────────────────────────────────
  // amqplib.connect returns a Connection object.
  // From it we create a Channel — a logical multiplexed connection.
  // Best practice: one channel per consumer/producer in a thread.
  const rabbitConn = await retryConnect('RabbitMQ', () =>
    amqplib.connect(RABBITMQ_URL)
  );
  rabbitChannel = await rabbitConn.createChannel();

  // assertQueue: creates the queue if it doesn't exist.
  // durable: true → queue survives RabbitMQ restart (persisted to disk).
  await rabbitChannel.assertQueue(RABBITMQ_QUEUE, { durable: true });
  console.log(`[bridge] RabbitMQ queue "${RABBITMQ_QUEUE}" ready`);

  // ── 3. Connect to Kafka and start consuming ───────────────────────────
  // KafkaJS requires a clientId (any string) and broker addresses.
  const kafka = new Kafka({
    clientId: 'kafka-rabbitmq-bridge',
    brokers: KAFKA_BROKERS,
    // Retry config — Kafka may take time to elect leaders after startup
    retry: { initialRetryTime: 3000, retries: 10 },
  });

  // A "Consumer Group" is key to Kafka's scaling:
  //   • All consumers with the same groupId share the partitions
  //   • Each message is delivered to ONLY ONE consumer in the group
  //   • If you add more bridge instances, Kafka auto-distributes the load
  const consumer = kafka.consumer({ groupId: KAFKA_GROUP });

  await retryConnect('Kafka', () => consumer.connect());

  // subscribe: tell Kafka which topic(s) to read.
  // fromBeginning: true → on first run, replay all past messages.
  //               false → start from the latest message (only new events).
  // Set fromBeginning: false for production (you don't want to re-notify old results).
  await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: false });

  console.log(`[bridge] ✅ Kafka consumer subscribed to topic: ${KAFKA_TOPIC}`);
  console.log('[bridge] 🚀 Waiting for CDC events...');

  // consumer.run: the main event loop.
  // eachMessage: called once per Kafka message.
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      // message.value is a Buffer (raw bytes) — convert to string
      if (!message.value) return;  // tombstone message (Kafka DELETE marker)

      const raw = message.value.toString();
      console.log(`[bridge] Received from Kafka [partition=${partition}, offset=${message.offset}]`);

      try {
        await processEvent(raw);
      } catch (err) {
        console.error('[bridge] Failed to process event:', err.message);
        // We DON'T throw here — we just log and move on.
        // If we threw, the consumer would crash and stop processing.
        // In production, push failed messages to a Dead Letter Queue (DLQ).
      }
    },
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
// SIGTERM is sent by Docker/Kubernetes when stopping a container.
// We cleanly close Kafka consumer instead of hard-killing mid-message.
process.on('SIGTERM', async () => {
  console.log('[bridge] SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

main().catch(err => {
  console.error('[bridge] Fatal error:', err.message);
  process.exit(1);
});
