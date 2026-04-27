/**
 * NOTIFICATION SERVICE — consumer.js
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS A MESSAGE QUEUE CONSUMER?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Think of RabbitMQ like a post office:
 *
 *   Producer (bridge) → drops letters into a mailbox (queue)
 *   Consumer (us)     → picks up letters, processes them, stamps "done"
 *
 * Key concepts:
 *
 *  ┌──────────────────────────────────────────────────────────────────────┐
 *  │ QUEUE         │ "results.published" — holds messages until consumed  │
 *  ├──────────────────────────────────────────────────────────────────────┤
 *  │ ACK           │ "Acknowledgement" — tells RabbitMQ "I processed      │
 *  │               │ this message successfully, delete it from the queue" │
 *  ├──────────────────────────────────────────────────────────────────────┤
 *  │ NACK          │ "Negative ACK" — tells RabbitMQ "I failed, requeue   │
 *  │               │ this message (or discard it)"                        │
 *  ├──────────────────────────────────────────────────────────────────────┤
 *  │ prefetch(1)   │ "Give me 1 message at a time. Don't send the next    │
 *  │               │ one until I ACK the current one." This prevents      │
 *  │               │ the consumer from being flooded if email is slow.    │
 *  ├──────────────────────────────────────────────────────────────────────┤
 *  │ durable:true  │ The queue persists to disk — survives RabbitMQ       │
 *  │               │ restart. Messages are NOT lost if the broker goes    │
 *  │               │ down.                                                │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 * MESSAGE FORMAT received from the bridge:
 *  {
 *    student_id:   1,
 *    exam_id:      1,
 *    score:        92.5,
 *    grade:        "A",
 *    published_at: "2025-05-01T12:00:00.000Z",
 *    email:        "student@example.com",
 *    name:         "Alice",
 *    _op:          "c",
 *    _captured_at: "2025-05-01T12:00:01.000Z"
 *  }
 */

const amqplib = require('amqplib');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');

// ── RabbitMQ queue name ────────────────────────────────────────────────────
const QUEUE = 'results.published';

// ── Email transporter ──────────────────────────────────────────────────────
// nodemailer transporter is created once and reused for all emails.
// It manages an SMTP connection pool internally.
let transporter;

/**
 * createTransporter()
 * Sets up nodemailer with Gmail SMTP or falls back to Ethereal (fake SMTP).
 *
 * Ethereal (https://ethereal.email):
 *   A free fake SMTP server for testing. Emails are NOT actually delivered —
 *   they're captured and viewable at https://ethereal.email/messages.
 *   Perfect for development without a real email account.
 *
 * To use Gmail in production:
 *   1. Enable 2FA on your Google account
 *   2. Create an "App Password" (Google Account → Security → App Passwords)
 *   3. Set EMAIL_USER=your@gmail.com  EMAIL_PASS=your-app-password
 */
async function createTransporter() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  // If real credentials are provided, use Gmail
  if (user && pass && user !== 'your_gmail@gmail.com') {
    console.log('[notification] Using Gmail SMTP for email delivery');
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  // Otherwise, create a throwaway Ethereal test account
  console.log('[notification] No real EMAIL credentials — using Ethereal (fake SMTP) for testing');
  const testAccount = await nodemailer.createTestAccount();
  console.log(`[notification] Ethereal test account: ${testAccount.user}`);
  console.log('[notification] View sent emails at: https://ethereal.email/messages');

  return nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
}

// ── Build the email content ────────────────────────────────────────────────

function buildEmailContent(data) {
  const gradeEmoji = {
    'A': '🏆', 'B': '🎉', 'C': '👍', 'D': '📚', 'F': '💪'
  }[data.grade] || '📊';

  const subject = `${gradeEmoji} Your Exam Result is Out! Score: ${data.score} (${data.grade})`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Exam Result Published</h2>
      <p>Hello <strong>${data.name || 'Student'}</strong>,</p>
      <p>Your result for <strong>Exam #${data.exam_id}</strong> has been published.</p>

      <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
        <tr style="background: #f3f4f6;">
          <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Score</strong></td>
          <td style="padding: 10px; border: 1px solid #e5e7eb;">${data.score} / 100</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Grade</strong></td>
          <td style="padding: 10px; border: 1px solid #e5e7eb; font-size: 1.4em;">${gradeEmoji} ${data.grade}</td>
        </tr>
        <tr style="background: #f3f4f6;">
          <td style="padding: 10px; border: 1px solid #e5e7eb;"><strong>Published At</strong></td>
          <td style="padding: 10px; border: 1px solid #e5e7eb;">${data.published_at}</td>
        </tr>
      </table>

      <p style="color: #6b7280; font-size: 0.9em;">
        This is an automated notification. Please log in to the portal to view full details.
      </p>
    </div>
  `;

  // Plain text fallback for email clients that don't render HTML
  const text = `Hello ${data.name || 'Student'},\n\nYour result for Exam #${data.exam_id} is out.\nScore: ${data.score}  Grade: ${data.grade}\nPublished: ${data.published_at}\n\nLog in to the portal for details.`;

  return { subject, html, text };
}

// ── Main consumer function ────────────────────────────────────────────────

async function startConsumer() {
  // index.js registers the schema before calling startConsumer().
  const NotificationLog = mongoose.model('Notification');

  // ── 1. Create email transporter ──────────────────────────────────────
  transporter = await createTransporter();

  // ── 2. Connect to RabbitMQ ────────────────────────────────────────────
  // Retry loop: RabbitMQ might not be up yet when this service starts
  let rabbitConn;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      console.log(`[notification] Connecting to RabbitMQ (attempt ${attempt})...`);
      rabbitConn = await amqplib.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
      console.log('[notification] ✅ Connected to RabbitMQ');
      break;
    } catch (err) {
      console.warn(`[notification] RabbitMQ not ready: ${err.message}. Retrying in 5s...`);
      if (attempt === 20) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ── 3. Create a channel ───────────────────────────────────────────────
  // A channel is a lightweight virtual connection inside the RabbitMQ connection.
  // Think of the connection as a TCP socket, and channels as logical streams on it.
  const channel = await rabbitConn.createChannel();

  // assertQueue: safe to call even if queue already exists.
  // Must use the SAME options (durable: true) as when the bridge created it.
  await channel.assertQueue(QUEUE, { durable: true });

  // prefetch(1): "Fair dispatch" — give me one message at a time.
  // Without this, RabbitMQ delivers all queued messages to this consumer at once,
  // which would cause: sending 1000 emails simultaneously = SMTP server bans you.
  channel.prefetch(1);

  console.log(`[notification] 👂 Listening on RabbitMQ queue: "${QUEUE}"`);
  console.log('[notification] 📬 Ready to send emails and log notifications...');

  // ── 4. Consume messages ───────────────────────────────────────────────
  channel.consume(QUEUE, async (msg) => {
    // msg is null if the consumer is cancelled (RabbitMQ sends null on cancel)
    if (!msg) return;

    let data;
    try {
      data = JSON.parse(msg.content.toString());
      console.log(`[notification] 📩 Message received for student ${data.student_id} (${data.email})`);
    } catch (parseErr) {
      console.error('[notification] Invalid message format — discarding:', parseErr.message);
      channel.nack(msg, false, false);  // nack without requeue (bad message → discard)
      return;
    }

    // ── Send email ──────────────────────────────────────────────────────
    const { subject, html, text } = buildEmailContent(data);
    let emailStatus = 'sent';
    let emailError = null;

    try {
      const info = await transporter.sendMail({
        from: `"Exam System" <${process.env.EMAIL_USER || 'noreply@examystem.com'}>`,
        to: data.email,
        subject,
        text,
        html,
      });

      console.log(`[notification] ✉️  Email sent to ${data.email}`);

      // For Ethereal: print preview URL so you can inspect the email in browser
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log(`[notification] 🔗 Preview email at: ${previewUrl}`);
      }
    } catch (emailErr) {
      console.error(`[notification] ❌ Email failed for ${data.email}:`, emailErr.message);
      emailStatus = 'failed';
      emailError = emailErr.message;
    }

    // ── Log to MongoDB ──────────────────────────────────────────────────
    // Always log, even if email failed — gives us audit trail.
    try {
      await NotificationLog.create({
        student_id:  data.student_id,
        email:       data.email,
        exam_id:     data.exam_id,
        score:       data.score,
        grade:       data.grade,
        channel:     'email',
        status:      emailStatus,
        error:       emailError,
        sent_at:     new Date(),
      });
      console.log(`[notification] 📋 Logged to MongoDB: student=${data.student_id} status=${emailStatus}`);
    } catch (mongoErr) {
      console.error('[notification] MongoDB log failed:', mongoErr.message);
      // We still ACK the message — MongoDB failure shouldn't retrigger the email
    }

    // ── ACK the message ─────────────────────────────────────────────────
    // This tells RabbitMQ: "I'm done with this message, remove it from the queue."
    // If we crash BEFORE ack-ing, RabbitMQ will requeue the message and
    // deliver it to another consumer — guaranteed at-least-once delivery.
    channel.ack(msg);
    console.log(`[notification] ✅ Message ACK'd`);
  });

  // Handle connection drops — try to reconnect
  rabbitConn.on('close', async () => {
    console.warn('[notification] RabbitMQ connection closed. Reconnecting in 10s...');
    setTimeout(startConsumer, 10000);
  });
}

module.exports = { startConsumer };
