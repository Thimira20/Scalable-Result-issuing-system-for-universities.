/**
 * AUTH SERVICE — index.js
 * Port: 4001
 *
 * Responsibility:
 *   • Redirect users to Google for authentication (OAuth 2.0)
 *   • Handle callback, upsert user in auth_db, issue a signed JWT
 *   • All other services verify that JWT LOCALLY — they never call us again
 *
 * Why Google OAuth instead of username/password?
 *   • No password storage → no bcrypt, no breach risk
 *   • Google handles 2FA, account recovery, suspicious login detection
 *   • Users log in with an account they already trust
 *
 * JWT Design:
 *   • Algorithm: HS256 (symmetric — same key signs and verifies)
 *   • Payload: { user_id, email, role }
 *   • Expiry: 24h
 *   • Secret: JWT_SECRET env var (shared across ALL services)
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { verifyJWT, requireAdmin } = require('./middleware/auth');

// ── ADMIN_EMAILS — auto-promote without SQL ────────────────────────────────
// Add comma-separated emails to ADMIN_EMAILS in your .env:
//   ADMIN_EMAILS=alice@gmail.com,bob@gmail.com
// On every login: if the user's Google email is in this list, their role
// is automatically set to 'admin' in the DB. No SQL queries needed!
//
// Example flow:
//   1. You add your email to ADMIN_EMAILS in .env
//   2. You sign in with Google
//   3. Auth Service sees your email → UPDATE users SET role='admin'
//   4. JWT issued with role='admin'
//   5. You now have admin access everywhere
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);  // remove empty strings

console.log(`[auth-service] Admin emails configured: [${ADMIN_EMAILS.join(', ') || 'none'}]`);

const app = express();
app.use(cors());
app.use(express.json());

// ── Session (required by Passport during the OAuth redirect flow) ──────────
// Passport temporarily stores the OAuth state in session between
// the redirect-to-Google step and the callback step.
// After the callback, we issue a JWT and the session is no longer needed.
app.use(session({
  secret: process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

// ── MySQL connection pool ──────────────────────────────────────────────────
// A "pool" manages multiple reusable connections.
// Much better than opening/closing a new connection on every request.
let db;
async function initDB() {
  db = await mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,  // auth_db
    waitForConnections: true,
    connectionLimit: 10,
  });
  console.log('[auth-service] Connected to MySQL (auth_db)');
}

// ── Passport: Google OAuth Strategy ───────────────────────────────────────
// This tells Passport HOW to authenticate with Google.
// callbackURL: must match what you registered in Google Cloud Console exactly.
passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'http://localhost:4001/auth/google/callback',
  },
  // This verify callback runs AFTER Google redirects back with user data.
  // profile: contains Google's profile info (id, name, email, photo)
  async (accessToken, refreshToken, profile, done) => {
    try {
      const googleId = profile.id;
      const email = profile.emails[0].value;
      const name = profile.displayName;

      // ── Upsert user ────────────────────────────────────────────────────
      // INSERT ... ON DUPLICATE KEY UPDATE:
      //   New user  → INSERT with role='student' (default)
      //   Returning → UPDATE only name/email, role stays as-is
      await db.execute(
        `INSERT INTO users (google_id, email, name)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name)`,
        [googleId, email, name]
      );

      // ── ADMIN_EMAILS auto-promotion ────────────────────────────────────
      // If this email is listed in ADMIN_EMAILS env var, ensure they are admin.
      // This runs on EVERY login, so you can add someone to the list and
      // they become admin the next time they sign in — no SQL query needed!
      if (ADMIN_EMAILS.includes(email.toLowerCase())) {
        await db.execute(
          'UPDATE users SET role = ? WHERE google_id = ?',
          ['admin', googleId]
        );
        console.log(`[auth-service] Auto-promoted ${email} to admin (ADMIN_EMAILS match)`);
      }

      // Fetch the full user row (id + role needed for JWT payload)
      const [rows] = await db.execute(
        'SELECT id, email, role FROM users WHERE google_id = ?',
        [googleId]
      );
      const user = rows[0];

      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

// Passport needs these to manage the session during the OAuth flow
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Routes ─────────────────────────────────────────────────────────────────

// Health check — Docker Compose and K8s use this
app.get('/auth/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

/**
 * STEP 1: Redirect to Google
 * When the frontend "Sign in with Google" button is clicked,
 * it navigates to this URL. Passport builds the Google redirect URL
 * and sends a 302. The user sees Google's login page.
 * 'scope' tells Google what data we want access to.
 */
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

/**
 * STEP 2: Google Callback
 * After the user approves on Google, Google redirects here with a ?code=...
 * Passport exchanges the code for an access token, fetches the profile,
 * runs our verify callback (above), then calls this route handler.
 *
 * We issue a signed JWT and redirect the frontend with it.
 * In a real app you'd redirect to a frontend URL like:
 *   http://localhost:3000/auth/callback?token=<JWT>
 * For now, we return JSON so you can test with curl/Postman.
 */
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/failed' }),
  (req, res) => {
    const user = req.user;

    // Issue JWT — this is what every other service will verify
    const token = jwt.sign(
      {
        user_id: user.id,
        email: user.email,
        role: user.role,          // 'student' or 'admin'
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h', algorithm: 'HS256' }
    );

    console.log(`[auth-service] JWT issued for ${user.email} (role: ${user.role})`);

    // In production redirect to frontend: res.redirect(`http://localhost:3000/callback?token=${token}`)
    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  }
);

app.get('/auth/failed', (req, res) => {
  res.status(401).json({ error: 'Google authentication failed' });
});

/**
 * GET /auth/verify
 * A utility endpoint for development / debugging.
 * You pass your JWT in the Authorization header and get back the decoded payload.
 * Production services verify the JWT locally (see middleware/auth.js) — 
 * they do NOT call this endpoint on every request (that would make Auth Service
 * a bottleneck and a single point of failure).
 */
app.get('/auth/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true, payload: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: err.message });
  }
});

// ── User Management Routes (admin only) ───────────────────────────────────

/**
 * GET /auth/users
 * Returns all registered users.
 * Admin dashboard calls this to show a user list with role-change buttons.
 *
 * Example response:
 *   { users: [{ id: 1, email: "alice@gmail.com", name: "Alice", role: "student" }, ...] }
 */
app.get('/auth/users', verifyJWT, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, google_id, email, name, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /auth/users/:id/role
 * Change a user's role without touching the database directly.
 *
 * Body: { "role": "admin" }  OR  { "role": "student" }
 *
 * Example — promote user #3 to admin:
 *   curl -X PATCH http://localhost:4001/auth/users/3/role \
 *        -H "Authorization: Bearer <ADMIN_JWT>" \
 *        -H "Content-Type: application/json" \
 *        -d '{"role": "admin"}'
 *
 * NOTE: The change takes effect at the NEXT login.
 *   The current JWT is still valid until it expires (24h).
 *   For immediate effect, the user should log out and log back in.
 */
app.patch('/auth/users/:id/role', verifyJWT, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const { role } = req.body;

  // Validate role value
  if (!['student', 'admin'].includes(role)) {
    return res.status(400).json({
      error: 'Invalid role. Must be "student" or "admin"'
    });
  }

  // Prevent admin from accidentally demoting themselves
  if (targetId === req.user.user_id && role === 'student') {
    return res.status(400).json({
      error: 'You cannot demote yourself. Have another admin do it.'
    });
  }

  try {
    const [result] = await db.execute(
      'UPDATE users SET role = ? WHERE id = ?',
      [role, targetId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch updated user for the response
    const [rows] = await db.execute(
      'SELECT id, email, name, role FROM users WHERE id = ?',
      [targetId]
    );

    console.log(`[auth-service] Role changed: user ${targetId} → ${role} (by admin ${req.user.email})`);
    res.json({
      message: `Role updated to "${role}" successfully`,
      user: rows[0],
      note: 'Change takes effect at next login (new JWT will carry the updated role)',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4001;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[auth-service] Running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[auth-service] Failed to connect to MySQL:', err.message);
  process.exit(1);
});
