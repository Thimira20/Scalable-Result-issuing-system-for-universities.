# Exam Result System — Microservices Implementation Plan

Build a cloud-native exam result system using a microservices architecture with two React frontends, four Express.js backend services, event-driven CDC via Debezium+Kafka, SAGA orchestration, and Kubernetes deployment via Minikube.

## User Review Required

> [!IMPORTANT]
> **Google OAuth Credentials Required**: You must supply your own `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from [Google Cloud Console](https://console.cloud.google.com/). The callback URL must be registered as `http://localhost:4001/auth/google/callback` (or the Minikube ingress equivalent). These will go into `.env` — never committed to Git.

> [!IMPORTANT]
> **Email credentials for Notification Service**: The nodemailer setup requires `EMAIL_USER` and `EMAIL_PASS` (e.g., Gmail app password or SMTP relay). These must be in `.env`.

> [!WARNING]
> **Docker Desktop / Minikube must be running** for the infrastructure Docker Compose and Kubernetes steps. Ensure you have sufficient RAM (≥8GB recommended for the full Debezium stack).

> [!NOTE]
> **kompose**: Running `kompose convert` will auto-generate Kubernetes YAML from docker-compose. We'll use this as a baseline and then layer in Secrets, HPA, and Ingress manually.

---

## Proposed Changes

### Root Project Structure

```
Project/
├── docker-compose.yml          # All infra + services
├── .env.example
├── .gitignore
├── k8s/                        # Kubernetes manifests
│   ├── secrets.yaml
│   ├── configmap.yaml
│   ├── auth-service.yaml
│   ├── result-service.yaml
│   ├── admin-service.yaml
│   ├── notification-service.yaml
│   ├── ingress.yaml
│   └── hpa-result.yaml
├── services/
│   ├── auth-service/
│   ├── result-service/
│   ├── admin-service/
│   ├── notification-service/
│   └── kafka-rabbitmq-bridge/
├── frontends/
│   ├── student-portal/         (port 3000)
│   └── admin-dashboard/        (port 3001)
└── db/
    ├── mysql-init/             # SQL init scripts
    └── debezium/               # Connector config JSON
```

---

### Infrastructure — docker-compose.yml

**Services included:**
| Container | Image | Purpose |
|---|---|---|
| mysql | mysql:8.0 | auth_db + exam_db (binlog ROW mode) |
| mongodb | mongo:6 | notif_db |
| redis | redis:7-alpine | Result cache |
| zookeeper | confluentinc/cp-zookeeper:7.5 | Kafka coord |
| kafka | confluentinc/cp-kafka:7.5 | Debezium transport |
| debezium | debezium/connect:2.4 | CDC connector |
| rabbitmq | rabbitmq:3-management | Queue + mgmt UI |
| kafka-rabbitmq-bridge | (custom Node.js) | Bridges Kafka→RabbitMQ |
| auth-service | (custom) | Port 4001 |
| result-service | (custom) | Port 4002 |
| admin-service | (custom) | Port 4003 |
| notification-service | (custom) | Port 4004 |
| student-portal | (custom) | Port 3000 |
| admin-dashboard | (custom) | Port 3001 |

MySQL binlog flags: `--binlog-format=ROW --binlog-row-image=FULL --log-bin=mysql-bin --server-id=1`

---

### Database Init Scripts — `db/mysql-init/`

#### [NEW] [01-auth-db.sql](file:///D:/7th%20sem/Cloud/Project/db/mysql-init/01-auth-db.sql)
Creates `auth_db` and `users` table:
```sql
id, google_id, email, name, role ENUM('student','admin'), created_at
```

#### [NEW] [02-exam-db.sql](file:///D:/7th%20sem/Cloud/Project/db/mysql-init/02-exam-db.sql)
Creates `exam_db` with tables:
- `exams` (id, name, date)
- `results` (id, student_id, exam_id, score, grade, published_at)
- `saga_state` (saga_id, type, step, status, payload JSON, created_at, updated_at)

---

### Auth Service — `services/auth-service/`

#### [NEW] `index.js`
- Express app on port 4001
- `passport-google-oauth20` for Google OAuth
- On callback: upsert user in `auth_db.users`, issue JWT (`HS256`, payload: `{user_id, email, role}`, secret: `JWT_SECRET`, expires: `24h`)
- Routes:
  - `GET /auth/google` — redirect to Google
  - `GET /auth/google/callback` — handle callback, return JWT
  - `GET /auth/verify` — verify JWT (used internally during dev; production services verify locally)
  - `GET /auth/health`

#### [NEW] `middleware/auth.js`
JWT verification middleware (shared pattern — each service has its own copy).

---

### Result Service — `services/result-service/`

#### [NEW] `index.js`
- Express on port 4002
- JWT middleware (local verify with `JWT_SECRET`)
- Redis client (`ioredis`)
- MySQL pool (`mysql2/promise`)
- `GET /results/:studentId`:
  1. Check Redis key `result:{studentId}`
  2. Cache hit → return JSON
  3. Cache miss → query `exam_db.results`, store in Redis (TTL 3600s), return

---

### Admin Service — `services/admin-service/`

#### [NEW] `index.js`
- Express on port 4003
- JWT middleware + `role === 'admin'` guard
- `multer` for CSV upload (memory storage)
- `POST /admin/upload` → triggers SAGA Orchestrator
- `GET /admin/saga/:sagaId` → returns saga state

#### [NEW] `saga/orchestrator.js`
SAGA with 3 steps + compensating transactions:

```
Step 1: Bulk upsert results → MySQL exam_db.results
  Compensate: DELETE inserted rows by saga_id batch

Step 2: Invalidate Redis cache for each affected student_id
  Compensate: Re-fetch from MySQL and re-cache in Redis

Step 3: (automatic) Debezium picks up binlog changes → Kafka → Bridge → RabbitMQ
  No compensation needed
```
- State persisted in `saga_state` table after each step
- Returns 200 after step 2 completes

---

### Notification Service — `services/notification-service/`

#### [NEW] `index.js`
- Express on port 4004
- `amqplib` consumer on RabbitMQ queue `results.published`
- On each message: send email via `nodemailer` (Gmail SMTP / configurable)
- Log to MongoDB `notif_db.notifications` (student_id, email, status, timestamp)

---

### Kafka-RabbitMQ Bridge — `services/kafka-rabbitmq-bridge/`

#### [NEW] `index.js`
- `kafkajs` consumer on topic `exam_db.exam_db.results` (Debezium output topic)
- Filters for INSERT/UPDATE operations
- Publishes to RabbitMQ queue `results.published` via `amqplib`
- Runs as a plain Node.js process (no HTTP server needed)

---

### Debezium Connector — `db/debezium/`

#### [NEW] `connector-config.json`
```json
{
  "name": "exam-results-connector",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",
    "database.hostname": "mysql",
    "database.port": "3306",
    "database.user": "debezium",
    "database.password": "...",
    "database.server.id": "1",
    "topic.prefix": "exam_db",
    "database.include.list": "exam_db",
    "table.include.list": "exam_db.results",
    "schema.history.internal.kafka.bootstrap.servers": "kafka:9092",
    "schema.history.internal.kafka.topic": "schema-changes.exam_db"
  }
}
```
Registration script: `register-connector.sh`

---

### Student Portal Frontend — `frontends/student-portal/`

#### [NEW] React app (Vite)
- `LoginPage` — "Sign in with Google" button → redirects to `http://localhost:4001/auth/google`
- `ResultsPage` — dropdown to select exam, fetches `GET /results/:studentId`, displays score/grade
- JWT stored in `localStorage`, sent as `Authorization: Bearer <token>`
- Protected routes (redirect to login if no JWT)

---

### Admin Dashboard Frontend — `frontends/admin-dashboard/`

#### [NEW] React app (Vite)
- `LoginPage` — same Google OAuth flow, but checks `role === 'admin'` after login
- `UploadPage` — drag-and-drop CSV upload → `POST /admin/upload`
- `MonitorPage` — polls `GET /admin/saga/:sagaId` for SAGA status, shows step progress
- Protected routes with admin role guard

---

### Kubernetes Manifests — `k8s/`

#### [NEW] `secrets.yaml`
```yaml
kind: Secret
metadata:
  name: exam-secrets
# base64-encoded values for: JWT_SECRET, DB_PASSWORD, GOOGLE_CLIENT_ID,
# GOOGLE_CLIENT_SECRET, EMAIL_USER, EMAIL_PASS, MONGO_URI, REDIS_URL, RABBITMQ_URL
```

#### [NEW] `auth-service.yaml`, `result-service.yaml`, `admin-service.yaml`, `notification-service.yaml`
Each: `Deployment` + `Service` (ClusterIP), env vars sourced from `exam-secrets` Secret.

#### [NEW] `ingress.yaml`
Nginx Ingress:
```
/auth   → auth-service:4001
/results → result-service:4002
/admin  → admin-service:4003
```

#### [NEW] `hpa-result.yaml`
```yaml
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef: result-service
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          averageUtilization: 50
```

---

## Verification Plan

### Automated Tests

**Start the stack:**
```bash
cd D:\7th sem\Cloud\Project
docker compose up -d
```

**Register Debezium connector (run once after containers are healthy):**
```bash
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d @db/debezium/connector-config.json
```

**Auth Service:**
```bash
# Health check
curl http://localhost:4001/auth/health
# Browser: navigate to http://localhost:4001/auth/google → Google login flow
```

**Result Service (with valid JWT):**
```bash
curl -H "Authorization: Bearer <JWT>" http://localhost:4002/results/STU001
# First call: DB hit (check service logs show "cache miss")
# Second call: Redis hit (check service logs show "cache hit")
```

**Admin CSV Upload (with admin JWT):**
```bash
curl -X POST http://localhost:4003/admin/upload \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -F "file=@sample-results.csv"
# Check SAGA state: GET http://localhost:4003/admin/saga/<sagaId>
```

**Notification via RabbitMQ:**
```bash
# After upload, watch notification service logs:
docker compose logs -f notification-service
# Confirm email received and MongoDB log entry created
```

**Kubernetes (Minikube):**
```bash
minikube start
kompose convert -f docker-compose.yml -o k8s/
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/
kubectl get pods
kubectl get ingress
```

### Manual Verification
1. Open browser → `http://localhost:3000` → click "Sign in with Google" → complete OAuth → see result lookup page
2. Open browser → `http://localhost:3001` → sign in as admin → upload a CSV → watch SAGA progress update in the monitor panel
3. Check RabbitMQ Management UI at `http://localhost:15672` (guest/guest) → verify `results.published` queue has messages after upload
4. Check notification service logs for email confirmation
