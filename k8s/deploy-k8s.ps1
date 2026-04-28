# ═══════════════════════════════════════════════════════════════════════════
# deploy-k8s.ps1 — PowerShell script to deploy everything to Minikube
# ═══════════════════════════════════════════════════════════════════════════
#
# WHAT THIS SCRIPT DOES (step by step):
#
#   1. Start Minikube (local K8s cluster)
#   2. Enable required addons (Ingress, Metrics Server)
#   3. Point your Docker CLI at Minikube's Docker daemon
#      (so "docker build" builds INSIDE Minikube — no need for Docker Hub)
#   4. Build all 5 custom Docker images
#   5. Create MySQL init ConfigMap from SQL files
#   6. Apply all K8s manifests in dependency order
#   7. Wait for Pods to become ready
#   8. Print status and access instructions
#
# USAGE:
#   cd "D:\7th sem\Cloud\Project"
#   .\k8s\deploy-k8s.ps1
#
# PREREQUISITES:
#   - Minikube installed: https://minikube.sigs.k8s.io/docs/start/
#   - kubectl installed (comes with Minikube)
#   - Docker Desktop running
# ═══════════════════════════════════════════════════════════════════════════

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host " Exam Result System — Kubernetes Deployment"           -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan

# ── Step 1: Start Minikube ────────────────────────────────────────────────
Write-Host "`n📦 Step 1: Starting Minikube..." -ForegroundColor Yellow
minikube start --memory=8192 --cpus=4 --driver=docker
# --memory=8192  → allocate 8GB RAM to the cluster (Kafka/Debezium need a lot)
# --cpus=4       → 4 CPU cores
# --driver=docker → use Docker as the VM driver (most reliable on Windows)

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Minikube failed to start. Is Docker Desktop running?" -ForegroundColor Red
    exit 1
}

# ── Step 2: Enable addons ────────────────────────────────────────────────
Write-Host "`n🔌 Step 2: Enabling Minikube addons..." -ForegroundColor Yellow

# Ingress addon: installs the Nginx Ingress Controller Pod
minikube addons enable ingress
Write-Host "  ✅ Ingress controller enabled"

# Metrics Server: HPA needs this to read CPU/memory metrics from Pods
minikube addons enable metrics-server
Write-Host "  ✅ Metrics server enabled"

# ── Step 3: Use Minikube's Docker daemon ─────────────────────────────────
Write-Host "`n🐳 Step 3: Configuring Docker to build inside Minikube..." -ForegroundColor Yellow
# This is the KEY trick for local K8s development:
# Instead of pushing images to Docker Hub and pulling them in Minikube,
# we build images DIRECTLY inside Minikube's Docker daemon.
# After this, "docker build" runs inside the Minikube VM.
& minikube -p minikube docker-env --shell powershell | Invoke-Expression
Write-Host "  ✅ Docker CLI now targets Minikube's daemon"

# ── Step 4: Build all custom Docker images ───────────────────────────────
Write-Host "`n🔨 Step 4: Building Docker images inside Minikube..." -ForegroundColor Yellow

$services = @(
    @{ Name = "auth-service";           Path = "services/auth-service" },
    @{ Name = "result-service";         Path = "services/result-service" },
    @{ Name = "admin-service";          Path = "services/admin-service" },
    @{ Name = "notification-service";   Path = "services/notification-service" },
    @{ Name = "kafka-rabbitmq-bridge";  Path = "services/kafka-rabbitmq-bridge" }
)

foreach ($svc in $services) {
    Write-Host "  Building $($svc.Name)..."
    docker build -t "$($svc.Name):latest" ".\$($svc.Path)"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ Failed to build $($svc.Name)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✅ $($svc.Name):latest built"
}

# ── Step 5: Create MySQL init scripts ConfigMap ──────────────────────────
Write-Host "`n📄 Step 5: Creating MySQL init scripts ConfigMap..." -ForegroundColor Yellow
# This creates a ConfigMap named "mysql-init-scripts" from the SQL files.
# The MySQL Pod mounts this ConfigMap at /docker-entrypoint-initdb.d/
# so the init scripts run on first boot (same as Docker Compose).
kubectl delete configmap mysql-init-scripts --ignore-not-found
kubectl create configmap mysql-init-scripts --from-file=db/mysql-init/
Write-Host "  ✅ mysql-init-scripts ConfigMap created"

# ── Step 6: Apply K8s manifests in order ─────────────────────────────────
Write-Host "`n🚀 Step 6: Applying Kubernetes manifests..." -ForegroundColor Yellow

# Order matters! Secrets and ConfigMap first, then infrastructure, then services.
$manifests = @(
    "k8s/secrets.yaml",
    "k8s/configmap.yaml",
    "k8s/mysql.yaml",
    "k8s/redis-mongodb.yaml",
    "k8s/kafka-stack.yaml",
    "k8s/auth-service.yaml",
    "k8s/result-service.yaml",
    "k8s/admin-service.yaml",
    "k8s/notification-service.yaml",
    "k8s/bridge.yaml",
    "k8s/hpa-result.yaml",
    "k8s/ingress.yaml"
)

foreach ($manifest in $manifests) {
    Write-Host "  Applying $manifest..."
    kubectl apply -f $manifest
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ Failed to apply $manifest" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  ✅ All manifests applied"

# ── Step 7: Wait for Pods ────────────────────────────────────────────────
Write-Host "`n⏳ Step 7: Waiting for Pods to become ready (this takes 2-4 minutes)..." -ForegroundColor Yellow
Write-Host "  Watching Pod status... (press Ctrl+C to stop watching)"

# Wait for key deployments
kubectl rollout status deployment/mysql --timeout=120s
kubectl rollout status deployment/redis --timeout=60s
kubectl rollout status deployment/mongodb --timeout=60s
kubectl rollout status deployment/auth-service --timeout=120s
kubectl rollout status deployment/result-service --timeout=120s
kubectl rollout status deployment/admin-service --timeout=120s

# ── Step 8: Print status ─────────────────────────────────────────────────
Write-Host "`n═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host " ✅ DEPLOYMENT COMPLETE!" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green

Write-Host "`n📊 Pod Status:" -ForegroundColor Cyan
kubectl get pods -o wide

Write-Host "`n🌐 Services:" -ForegroundColor Cyan
kubectl get services

Write-Host "`n📈 HPA Status:" -ForegroundColor Cyan
kubectl get hpa

Write-Host "`n🔗 Ingress:" -ForegroundColor Cyan
kubectl get ingress

$minikubeIp = minikube ip
Write-Host "`n═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host " ACCESS INSTRUCTIONS"                                     -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Add to C:\Windows\System32\drivers\etc\hosts:"
Write-Host "     $minikubeIp  exam.local" -ForegroundColor Yellow
Write-Host ""
Write-Host "  2. Test endpoints:"
Write-Host "     curl http://exam.local/auth/health"
Write-Host "     curl http://exam.local/results/health"
Write-Host "     curl http://exam.local/admin/health"
Write-Host ""
Write-Host "  3. Open Minikube dashboard:"
Write-Host "     minikube dashboard" -ForegroundColor Yellow
Write-Host ""
Write-Host "  4. Register Debezium connector:"
Write-Host "     kubectl port-forward svc/debezium-service 8083:8083" -ForegroundColor Yellow
Write-Host "     Then in another terminal:"
Write-Host '     curl -X POST http://localhost:8083/connectors -H "Content-Type: application/json" -d @db/debezium/connector-config.json'
Write-Host ""
Write-Host "  5. View logs:"
Write-Host '     kubectl logs -f deployment/auth-service' -ForegroundColor Yellow
Write-Host ""
Write-Host "  6. Watch HPA scaling:"
Write-Host '     kubectl get hpa -w' -ForegroundColor Yellow
Write-Host ""
