# Cloud Project - Exam Result System (Microservices)

## Phase 1: Project Scaffolding & Root Config
- [ ] Create monorepo folder structure
- [ ] Root docker-compose.yml (all infra + services)
- [ ] Root .env.example
- [ ] Root .gitignore

## Phase 2: Infrastructure Services
- [ ] MySQL config (auth_db + exam_db, binlog enabled)
- [ ] MongoDB config
- [ ] Redis config
- [ ] Zookeeper config
- [ ] Kafka config
- [ ] Debezium Connect config + connector JSON
- [ ] RabbitMQ config
- [ ] Kafka-RabbitMQ bridge service

## Phase 3: Auth Service (port 4001)
- [ ] Express app with Google OAuth 2.0
- [ ] JWT issuance (HS256)
- [ ] MySQL auth_db connection (users table)
- [ ] Routes: /auth/google, /auth/callback, /auth/verify
- [ ] Dockerfile

## Phase 4: Result Service (port 4002)
- [ ] Express app
- [ ] Redis cache (key: result:{student_id}, TTL 1hr)
- [ ] MySQL exam_db connection
- [ ] JWT middleware (local verify)
- [ ] Routes: GET /results/:studentId
- [ ] Dockerfile

## Phase 5: Admin Service (port 4003)
- [ ] Express app
- [ ] CSV upload endpoint (multer)
- [ ] JWT middleware with role=admin check
- [ ] MySQL exam_db connection
- [ ] SAGA Orchestrator (3-step with compensations)
- [ ] saga_state table management
- [ ] Routes: POST /admin/upload, GET /admin/saga/:id
- [ ] Dockerfile

## Phase 6: Notification Service (port 4004)
- [ ] Express app
- [ ] RabbitMQ consumer (results.published queue)
- [ ] Email sending (nodemailer)
- [ ] MongoDB notif_db logging
- [ ] Dockerfile

## Phase 7: Student Portal Frontend (port 3000)
- [ ] React app (Create React App or Vite)
- [ ] Google OAuth login button
- [ ] Select exam & view result page
- [ ] JWT storage and API calls
- [ ] Dockerfile

## Phase 8: Admin Dashboard Frontend (port 3001)
- [ ] React app
- [ ] CSV upload UI
- [ ] System monitor / SAGA status view
- [ ] JWT storage with admin role guard
- [ ] Dockerfile

## Phase 9: Kubernetes Manifests
- [ ] Kubernetes Secret (exam-secrets)
- [ ] Deployment + Service YAML per backend service (4 services)
- [ ] Nginx Ingress controller with routing rules
- [ ] HorizontalPodAutoscaler for Result Service
- [ ] ConfigMap for non-secret config

## Phase 10: Verification
- [ ] Test Auth Service endpoints
- [ ] Test Result Service with Redis cache
- [ ] Test Admin CSV upload + SAGA flow
- [ ] Test Notification Service consumer
- [ ] Test Debezium CDC pipeline
- [ ] Test Kubernetes deployment
