/**
 * NOTIFICATION SERVICE — index.js
 * Port: 4004
 *
 * Part 2 additions vs Part 1:
 *   ✅ RabbitMQ consumer started on boot (consumer.js)
 *   ✅ Fixed MongoDB URI (was broken in user edit)
 *   ✅ Mongoose model registered here (shared with consumer.js via mongoose.model())
 *
 * Startup order:
 *   1. Connect to MongoDB
 *   2. Register Mongoose model (Notification)
 *   3. Start Express HTTP server (for health checks + log queries)
 *   4. Start RabbitMQ consumer (background, auto-retries)
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { startConsumer } = require('./consumer');

const app = express();
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════════════════
// MONGOOSE MODEL
// Defined here (in index.js) and re-used in consumer.js via:
//   mongoose.model('Notification')   ← retrieves already-registered model
//
// Why here and not in consumer.js?
//   mongoose.model() throws if you register the same model name twice.
//   By registering once in index.js (which always runs first), consumer.js
//   can safely call mongoose.model('Notification') to retrieve it.
// ══════════════════════════════════════════════════════════════════════════

const notificationSchema = new mongoose.Schema({
  student_id:  { type: Number, required: true },
  email:       { type: String, required: true },
  exam_id:     { type: Number },
  score:       { type: Number },
  grade:       { type: String },
  channel:     { type: String, enum: ['email', 'sms', 'push'], default: 'email' },
  status:      { type: String, enum: ['sent', 'failed', 'pending'], default: 'pending' },
  error:       { type: String },
  sent_at:     { type: Date, default: Date.now },
}, { timestamps: true });

// registering the model — this is what makes mongoose.model('Notification') work in consumer.js
mongoose.model('Notification', notificationSchema);
const Notification = mongoose.model('Notification');

// ══════════════════════════════════════════════════════════════════════════
// MONGODB CONNECTION
// ══════════════════════════════════════════════════════════════════════════

async function connectMongoDB() {
  // ⚠️  Correct URI format: mongodb://<host>:<port>/<database>
  // The database name MUST come after the port, at the END of the host section.
  // WRONG: mongodb://mongodb:27017/?directConnection=true/notif_db
  //   (query params come after the path, so /notif_db after ?... is invalid)
  // CORRECT: mongodb://mongodb:27017/notif_db
  //   (host=mongodb, port=27017, database=notif_db)
  const uri = process.env.MONGO_URI || 'mongodb://mongodb:27017/notif_db';

  await mongoose.connect(uri);
  console.log('[notification-service] ✅ Connected to MongoDB (notif_db)');
}

// ══════════════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ══════════════════════════════════════════════════════════════════════════

app.get('/notifications/health', (req, res) => {
  const mongoState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'ok',
    service: 'notification-service',
    mongodb: mongoState[mongoose.connection.readyState] || 'unknown',
    rabbitMQ: 'consumer started (see logs)',
  });
});

/**
 * GET /notifications
 * Returns the 50 most recent notification log entries.
 * Useful for admin monitoring — "did emails get sent after upload?"
 */
app.get('/notifications', async (req, res) => {
  try {
    const logs = await Notification.find()
      .sort({ sent_at: -1 })
      .limit(50)
      .lean();
    res.json({ notifications: logs, count: logs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /notifications/student/:studentId
 * All notification history for one student (useful for debugging).
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
 * GET /notifications/stats
 * Summary counts — quick sanity check.
 */
app.get('/notifications/stats', async (req, res) => {
  try {
    const total  = await Notification.countDocuments();
    const sent   = await Notification.countDocuments({ status: 'sent' });
    const failed = await Notification.countDocuments({ status: 'failed' });
    res.json({ total, sent, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// STARTUP SEQUENCE
// ══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 4004;

connectMongoDB()
  .then(() => {
    // Start HTTP server
    app.listen(PORT, () => {
      console.log(`[notification-service] 🚀 HTTP server running on port ${PORT}`);
    });

    // Start RabbitMQ consumer in the background.
    // startConsumer() has its own internal retry loop — it won't crash the service
    // if RabbitMQ isn't ready yet (e.g., Part 1 stack without RabbitMQ).
    startConsumer().catch(err => {
      console.error('[notification-service] Consumer error:', err.message);
      // Don't exit — HTTP server stays up for health checks even if consumer fails
    });
  })
  .catch(err => {
    console.error('[notification-service] Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
