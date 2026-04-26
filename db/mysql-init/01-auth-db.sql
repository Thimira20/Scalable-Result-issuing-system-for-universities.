-- ============================================================
-- auth_db  — owned exclusively by Auth Service
-- This database stores user identities from Google OAuth.
-- Auth Service is the ONLY service that writes here.
-- ============================================================

CREATE DATABASE IF NOT EXISTS auth_db;
USE auth_db;

-- users table
-- google_id  : The unique ID Google gives us after OAuth — we store it so
--              we can recognise a returning user without a password.
-- role       : 'student' or 'admin'. Set manually in the DB or via a seed.
--              The JWT we issue will carry this role so other services can
--              enforce access control without hitting this DB again.
CREATE TABLE IF NOT EXISTS users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  google_id  VARCHAR(255) NOT NULL UNIQUE,
  email      VARCHAR(255) NOT NULL UNIQUE,
  name       VARCHAR(255),
  role       ENUM('student', 'admin') NOT NULL DEFAULT 'student',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Grant the app user access to auth_db
GRANT ALL PRIVILEGES ON auth_db.* TO 'appuser'@'%';

-- ── Seed an admin account (replace with your real Google email) ──────────
-- When you first log in with Google, this row won't exist yet.
-- The Auth Service will INSERT a new row with role='student'.
-- You can then manually UPDATE the role to 'admin' for your account:
--   UPDATE users SET role='admin' WHERE email='your@email.com';
-- OR, uncomment and adjust the seed below (google_id must be your real one):
-- INSERT INTO users (google_id, email, name, role)
-- VALUES ('google-sub-id-here', 'admin@example.com', 'Admin User', 'admin')
-- ON DUPLICATE KEY UPDATE role='admin';

FLUSH PRIVILEGES;
