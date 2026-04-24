/**
 * JWT Authentication Middleware
 * 
 * Purpose:
 *   Verify the JWT on every protected route WITHOUT calling the Auth Service.
 *   This is the key microservices pattern: each service holds a copy of JWT_SECRET
 *   and verifies tokens independently. No inter-service HTTP call needed.
 *
 * Why this is important (think about scale):
 *   If every service called Auth Service to verify a token, Auth Service would:
 *   1. Become a performance bottleneck (every request hits it)
 *   2. Be a single point of failure (if it's down, ALL services fail)
 *   Local verification avoids both problems entirely.
 *
 * Usage:
 *   app.get('/protected', verifyJWT, (req, res) => { ... })
 *   app.get('/admin-only', verifyJWT, requireAdmin, (req, res) => { ... })
 *
 *   After verifyJWT runs, req.user = { user_id, email, role, iat, exp }
 */

const jwt = require('jsonwebtoken');

/**
 * verifyJWT
 * Extracts and verifies the Bearer token from the Authorization header.
 * Attaches decoded payload to req.user on success.
 */
function verifyJWT(req, res, next) {
  const authHeader = req.headers['authorization'];

  // Check header exists and follows "Bearer <token>" format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // jwt.verify throws if: token is expired, signature doesn't match, or token is malformed
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;   // { user_id, email, role, iat, exp }
    next();               // hand control to the actual route handler
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', detail: err.message });
  }
}

/**
 * requireAdmin
 * Must be used AFTER verifyJWT (relies on req.user being set).
 * Blocks access if the logged-in user is not an admin.
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: admin access required' });
  }
  next();
}

module.exports = { verifyJWT, requireAdmin };
