-- ============================================================
-- exam_db  — shared by Result Service (reads) and Admin Service (writes)
-- Debezium watches this DB's binlog for CDC events.
-- ============================================================

CREATE DATABASE IF NOT EXISTS exam_db;
USE exam_db;

-- exams table
-- Stores exam metadata. Student selects an exam_id on the portal.
CREATE TABLE IF NOT EXISTS exams (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  exam_date  DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- results table
-- Core table — this is what Debezium watches.
-- student_id : matches the user id from auth_db.users (logical FK, no CONSTRAINT
--              because services own their own DB — microservice principle).
-- published_at : set when admin publishes. NULL = not yet published.
CREATE TABLE IF NOT EXISTS results (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  student_id   INT NOT NULL,
  exam_id      INT NOT NULL,
  score        DECIMAL(5,2),
  grade        VARCHAR(5),
  published_at DATETIME DEFAULT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_student_exam (student_id, exam_id)  -- prevents duplicates; CSV upsert uses this
);

-- saga_state table
-- The SAGA Orchestrator (Part 3) writes one row per upload operation.
-- This lets us track exactly which step succeeded/failed and rollback safely.
-- payload : JSON blob — stores context needed for compensating transactions
--           e.g., which student IDs were affected so we can undo cache invalidation.
CREATE TABLE IF NOT EXISTS saga_state (
  saga_id    VARCHAR(36) PRIMARY KEY,          -- UUID
  type       VARCHAR(100) DEFAULT 'PUBLISH_RESULTS',
  step       INT DEFAULT 0,                    -- current step (1, 2, 3)
  status     ENUM('STARTED','IN_PROGRESS','COMPLETED','FAILED','COMPENSATING','COMPENSATED')
             NOT NULL DEFAULT 'STARTED',
  payload    JSON,                             -- context data for compensations
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Grant the app user access to exam_db
GRANT ALL PRIVILEGES ON exam_db.* TO 'appuser'@'%';

-- Grant the debezium user (for CDC) read-only access + replication privilege
-- (credentials set in docker-compose; this user is created by the init script)
CREATE USER IF NOT EXISTS 'debezium'@'%' IDENTIFIED BY 'debeziumpassword';
GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'debezium'@'%';

-- ── Seed data ────────────────────────────────────────────────────────────────
INSERT INTO exams (name, exam_date) VALUES
  ('Cloud Computing Midterm', '2025-03-15'),
  ('Distributed Systems Final', '2025-05-20'),
  ('Database Engineering Quiz', '2025-04-10')
ON DUPLICATE KEY UPDATE name = VALUES(name);

FLUSH PRIVILEGES;
