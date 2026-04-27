# Exam Result Microservices System

A cloud-native exam result management platform built with a microservices architecture. Students log in via Google, check their results, and receive email notifications when results are published. Admins upload CSVs and the system handles everything automatically.

---

## Architecture Overview

```
                         ┌──────────────────────────────────┐
                         │         EXTERNAL CLIENTS          │
                         │  Student Browser  Admin Browser   │
                         └────────────┬─────────────────────┘
                                      │
                              ┌───────▼────────┐
                              │  Docker Network │  (exam_net)
                              └───────┬─────── ┘
                 ┌────────────────────┼───────────────────┐
                 ▼                    ▼                   ▼
          ┌─────────────┐    ┌─────────────┐    ┌──────────────┐
          │ Auth Service│    │Result Service│    │ Admin Service │
          │   :4001     │    │   :4002      │    │   :4003       │
          │ Google OAuth│    │ Redis Cache  │    │ CSV Upload    │
          │ JWT Issuance│    │ Exam Results │    │ SAGA Orchestr │
          └──────┬──────┘    └──────┬───── ┘    └──────┬────── ┘
                 │                  │                   │
         ┌───────▼───────┐  ┌───── ▼───────┐  ┌───────▼───────┐
         │  MySQL auth_db│  │    Redis      │  │ MySQL exam_db │
         └───────────────┘  └──────────────┘  └───────┬───────┘
                                                       │ binlog
                                                       ▼
                                              ┌────────────────┐
                                              │    Debezium    │
                                              │  CDC Connector │
                                              └───────┬────────┘
                                                      │
                                                      ▼
                                              ┌────────────────┐
                                              │     Kafka      │
                                              │  exam_db topic │
                                              └───────┬────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │ Kafka-RabbitMQ │
                                              │    Bridge      │
                                              └───────┬────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │   RabbitMQ     │
                                              │results.published│
                                              └───────┬────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │  Notification  │
                                              │   Service :4004│
                                              │ Email + MongoDB│
                                              └────────────────┘
```

---

## Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js + Express | Lightweight, async I/O, fast startup |
| Auth | Google OAuth 2.0 + JWT (HS256) | No passwords to store, Google handles security |
| Primary DB | MySQL 8.0 | Reliable ACID transactions for exam data |
| Cache | Redis | Sub-millisecond result lookup on results day |
| Document Store | MongoDB | Flexible schema for notification logs |
| CDC | Debezium + Kafka | Zero-code change detection on MySQL binlog |
| Message Queue | RabbitMQ | Reliable async email delivery with ACK |
| Orchestration | Docker Compose / Kubernetes | Reproducible infrastructure |
| Auto-scaling | Kubernetes HPA | Scale Result Service 1→10 pods on load |

---

## Project Structure

```
Project/
├── docker-compose.yml          # All 12 containers
├── .env                        # Your secrets (never commit this)
├── .env.example                # Template with explanations
├── sample-results.csv          # Test CSV for upload
├── services/
│   ├── auth-service/           # Port 4001 — Google OAuth + JWT
│   ├── result-service/         # Port 4002 — Results + Redis cache
│   ├── admin-service/          # Port 4003 — CSV upload + SAGA
│   │   └── saga/
│   │       └── orchestrator.js # 3-step SAGA with compensations
│   ├── notification-service/   # Port 4004 — Email + MongoDB logs
│   └── kafka-rabbitmq-bridge/  # Background worker (no HTTP port)
├── db/
│   ├── mysql-init/             # SQL schemas (auto-run on first boot)
│   │   ├── 01-auth-db.sql
│   │   └── 02-exam-db.sql
│   └── debezium/
│       ├── connector-config.json
│       └── register-connector.sh
└── k8s/                        # Kubernetes manifests (Part 4)
    ├── secrets.yaml
    ├── configmap.yaml
    ├── *.yaml                  # One per service/infra
    ├── hpa-result.yaml         # Auto-scaling
    ├── ingress.yaml            # URL routing
    └── deploy-k8s.ps1          # One-click deploy
```

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Docker Desktop | ≥ 4.x | `docker --version` |
| Docker RAM allocation | ≥ 8 GB | Docker Desktop → Settings → Resources |
| Node.js (for local dev only) | ≥ 20.x | `node --version` |

---

## Quick Start (Docker Compose)

### Step 1 — Clone and Configure

```bash
git clone <your-repo-url>
cd Project

# Copy environment template
copy .env.example .env
```

### Step 2 — Set Your Admin Email

Open `.env` and set:

```env
# Your Google email — you'll automatically get admin role on first login
ADMIN_EMAILS=your_actual_email@gmail.com

# Google OAuth credentials (see Step 3)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
```

### Step 3 — Google OAuth Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → **APIs & Services** → **Credentials**
3. Click **Create Credentials** → **OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Authorized redirect URIs: `http://localhost:4001/auth/google/callback`
6. Copy **Client ID** and **Client Secret** into `.env`

### Step 4 — Start All Containers

```bash
docker compose up --build -d
```

First run takes **3–5 minutes** (downloads images, builds services, runs DB init scripts).

### Step 5 — Verify Everything Is Running

```bash
docker compose ps
```

All containers should show `Up` or `Up (healthy)`.

```bash
# Health checks
curl http://localhost:4001/auth/health
curl http://localhost:4002/results/health
curl http://localhost:4003/admin/health
curl http://localhost:4004/notifications/health
```

### Step 6 — Register Debezium Connector (once only)

Wait ~30 seconds after startup, then:

**PowerShell:**
```powershell
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:8083/connectors" `
  -ContentType "application/json" `
  -Body (Get-Content "db\debezium\connector-config.json" -Raw)
```

**Git Bash / WSL / Linux:**
```bash
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d @db/debezium/connector-config.json
```

Verify it's running:
```bash
curl http://localhost:8083/connectors/exam-results-connector/status
```

---

## Testing the Full Flow

### Get an Admin JWT (for testing without browser)

```bash
node -e "
  require('dotenv').config();
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { user_id: 1, email: 'admin@test.com', role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  console.log(token);
"
```

Save as `ADMIN_TOKEN=<output>`.

### Upload Results CSV

```bash
curl -X POST http://localhost:4003/admin/upload \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@sample-results.csv"
```

Response includes a `sagaId`. Use it to check SAGA status:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4003/admin/saga/<SAGA_ID>
```

### Check Results (as student)

```bash
STUDENT_TOKEN=$(node -e "
  require('dotenv').config();
  const jwt = require('jsonwebtoken');
  console.log(jwt.sign({ user_id: 1, role: 'student' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
")

# First call → cache MISS (from MySQL)
curl -H "Authorization: Bearer $STUDENT_TOKEN" \
  http://localhost:4002/results/1

# Second call → cache HIT (from Redis, much faster)
curl -H "Authorization: Bearer $STUDENT_TOKEN" \
  http://localhost:4002/results/1
```

### Monitor Notifications

```bash
# See all notification logs
curl http://localhost:4004/notifications

# Check notification stats
curl http://localhost:4004/notifications/stats
```

### View RabbitMQ Management UI

Open: **http://localhost:15672**
Login: `guest` / `guest`
→ Queues → `results.published`

---

## Role Management (No SQL Needed!)

### Method 1 — Environment Variable (recommended for initial setup)

```env
# .env
ADMIN_EMAILS=alice@gmail.com,bob@gmail.com
```

Restart the auth service, then sign in with Google. Done — you're admin.

### Method 2 — API call (for changing roles after setup)

```bash
# List all users (admin JWT required)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4001/auth/users

# Promote user #3 to admin
curl -X PATCH http://localhost:4001/auth/users/3/role \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# Demote user #3 back to student
curl -X PATCH http://localhost:4001/auth/users/3/role \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "student"}'
```

> **Note:** Role change takes effect at next login (new JWT carries the updated role).

---

## API Reference

### Auth Service (port 4001)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/health` | None | Health check |
| GET | `/auth/google` | None | Start Google OAuth flow |
| GET | `/auth/google/callback` | None | OAuth callback — issues JWT |
| GET | `/auth/verify` | Bearer JWT | Decode and validate a JWT |
| GET | `/auth/users` | Admin JWT | List all users |
| PATCH | `/auth/users/:id/role` | Admin JWT | Change user role |

### Result Service (port 4002)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/results/health` | None | Health check |
| GET | `/results/:studentId` | Bearer JWT | Get student results (cached) |
| GET | `/results/exam/:examId` | Admin JWT | All results for one exam |

### Admin Service (port 4003)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/health` | None | Health check |
| GET | `/admin/exams` | Admin JWT | List all exams |
| POST | `/admin/upload` | Admin JWT | Upload CSV → triggers SAGA |
| GET | `/admin/results` | Admin JWT | All results in system |
| GET | `/admin/saga/:sagaId` | Admin JWT | SAGA run detail |
| GET | `/admin/sagas` | Admin JWT | Last 20 SAGA runs |

### Notification Service (port 4004)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/notifications/health` | None | Health check |
| GET | `/notifications` | None | Last 50 notification logs |
| GET | `/notifications/stats` | None | sent/failed counts |
| GET | `/notifications/student/:id` | None | Notifications for one student |
| POST | `/notifications/test` | None | Manually create a test log |

---

## Useful Docker Commands

```bash
# Live logs for one service
docker compose logs -f admin-service

# Restart one service after code change
docker compose restart auth-service

# Open MySQL shell
docker compose exec mysql mysql -u appuser -papppassword123 exam_db

# Open Redis CLI
docker compose exec redis redis-cli

# Stop everything (keep data)
docker compose down

# Full reset (delete all data)
docker compose down -v
```

---

## Kubernetes Deployment (Minikube)

```powershell
# One-click deploy
cd "D:\7th sem\Cloud\Project"
.\k8s\deploy-k8s.ps1
```

See `k8s/` directory for individual manifests and the [K8s Deployment Guide](k8s_deployment_guide.md).

---

## CSV Format for Upload

```csv
student_id,exam_id,score,grade
1,1,92.5,A
2,1,78.0,B
3,1,65.5,C
```

- `student_id` — must match a user `id` in `auth_db.users`
- `exam_id` — must match an exam `id` in `exam_db.exams` (seeds: 1, 2, 3)
- `score` — decimal (0–100)
- `grade` — A / B / C / D / F
