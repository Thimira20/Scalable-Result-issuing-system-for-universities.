/**
 * NOTIFICATION SERVICE — index.js
 * Port: 4004
 *
 * Responsibility:
 *   • In Part 1: Connect to MongoDB, expose health check endpoint
 *   • In Part 2: Add RabbitMQ consumer + nodemailer email sending
 *
 * Why MongoDB for notification logs?
 *   • Notifications benefit from schema flexibility:
 *     - Email notifications might have 'to', 'subject', 'body' fields
 *     - SMS might have 'phone', 'message' fields
 *     - Push notifications have different structures entirely
 *   • MongoDB stores them all in the same collection without
 *     requiring ALTER TABLE every time the format changes.
 *   • Notifications are write-heavy and query patterns are simple
 *     (list-by-status, list-by-student) — MongoDB handles these well.
 *
 * RabbitMQ Consumer (added in Part 2):
 *   Queue: results.published
 *   Message format: { student_id, email, exam_id, score, grade }
 *   On receive: send email → log to MongoDB
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── MongoDB Schema ─────────────────────────────────────────────────────────
// Mongoose Schema defines the shape of documents in the collection.
// Unlike MySQL tables, MongoDB documents don't require a schema —
// but Mongoose lets us add structure and validation when we want it.
const notificationSchema = new mongoose.Schema({
  student_id: { type: Number, required: true },
  email: { type: String, required: true },
  exam_id: { type: Number },
  score: { type: Number },
  grade: { type: String },
  channel: { type: String, enum: ['email', 'sms', 'push'], default: 'email' },
  status: { type: String, enum: ['sent', 'failed', 'pending'], default: 'pending' },
  error: { type: String },           // stores error message if status='failed'
  sent_at: { type: Date, default: Date.now },
}, {
  // timestamps: true auto-adds createdAt and updatedAt fields
  timestamps: true,
});

const Notification = mongoose.model('Notification', notificationSchema);

// ── MongoDB connection ──────────────────────────────────────────────────────
async function connectMongoDB() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/?directConnection=true/notif_db');
  console.log('[notification-service] Connected to MongoDB (notif_db)');
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/notifications/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'notification-service',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    rabbitMQ: 'not connected (Part 2)',
  });
});

/**
 * GET /notifications
 * Returns recent notification logs (admin debugging tool).
 */
app.get('/notifications', async (req, res) => {
  try {
    const logs = await Notification.find()
      .sort({ sent_at: -1 })
      .limit(50)
      .lean();                     // .lean() returns plain JS objects (faster than full Mongoose docs)
    res.json({ notifications: logs, count: logs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /notifications/student/:studentId
 * Returns notification history for a specific student.
 */
app.get('/notifications/student/:studentId', async (req, res) => {
  try {
    const logs = await Notification.find({ student_id: parseInt(req.params.studentId) })
      .sort({ sent_at: -1 })
      .lean();
    res.json({ notifications: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /notifications/test
 * Manually trigger a test notification log entry (for development/testing).
 * Part 2 replaces this with the RabbitMQ consumer as the real trigger.
 */
app.post('/notifications/test', async (req, res) => {
  try {
    const { student_id, email, exam_id, score, grade } = req.body;
    const log = await Notification.create({
      student_id,
      email,
      exam_id,
      score,
      grade,
      status: 'sent',
      channel: 'email',
    });
    console.log(`[notification-service] Test notification logged: student ${student_id}`);
    res.json({ message: 'Test notification logged', log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RabbitMQ Consumer placeholder ──────────────────────────────────────────
// This will be replaced with a real consumer in Part 2.
// The consumer will:
//   1. Connect to RabbitMQ (amqplib)
//   2. Assert queue 'results.published'
//   3. For each message: send email via nodemailer + log to MongoDB
// See: services/notification-service/consumer.js (added in Part 2)
console.log('[notification-service] RabbitMQ consumer: will be connected in Part 2');

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4004;
connectMongoDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[notification-service] Running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[notification-service] Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
