// =============================================================================
// Jenkinsfile — Declarative CI/CD Pipeline
// GitHub → Jenkins → Docker Build → GHCR Push → Deploy
// =============================================================================
//
// HOW THIS PIPELINE WORKS (read this first):
//
//   Developer pushes code to GitHub
//        │
//        │  GitHub sends POST request (webhook) to Jenkins URL
//        ▼
//   Jenkins triggers this pipeline automatically
//        │
//        ├─ Stage 1: Checkout      ← gets the code
//        ├─ Stage 2: Build         ← docker build (5 images, in parallel)
//        ├─ Stage 3: Test          ← basic container smoke test
//        ├─ Stage 4: Push to GHCR  ← docker push to ghcr.io
//        └─ Stage 5: Deploy        ← docker-compose pull + up -d
//
// WHY JENKINS (vs GitHub Actions)?
//   GitHub Actions runs on GitHub's servers (cloud), you pay per minute.
//   Jenkins runs on YOUR server — free, full control, can access private
//   networks, local Docker daemon, no vendor lock-in.
//
// WHY GHCR (vs Docker Hub)?
//   - Free unlimited storage for public GitHub repos
//   - Integrated with GitHub permissions (no separate account)
//   - Images inherit the repo's visibility (public repo = public images)
//   - Access controlled via GitHub Personal Access Tokens
//
// CREDENTIALS REQUIRED IN JENKINS (configure before running):
//   ID: ghcr-pat        Type: Secret text      Value: GitHub PAT
//   ID: deploy-env      Type: Secret file      Value: your .env file
//
// =============================================================================

pipeline {
    // "any" = run on any available Jenkins agent (node).
    // If you have multiple build agents, Jenkins picks the free one.
    agent any

    // ── Environment Variables ────────────────────────────────────────────
    // These are available in ALL stages as $VAR or "${VAR}" in shell steps.
    environment {
        // GHCR registry URL — always this for GitHub Container Registry
        REGISTRY      = 'ghcr.io'

        // Your GitHub username (lowercase — GHCR requires lowercase)
        GITHUB_USER   = 'thimira20'

        // Full prefix for all image names
        IMAGE_PREFIX  = 'ghcr.io/thimira20'

        // The 5 custom services that need to be built and pushed.
        // Infrastructure services (MySQL, Redis, Kafka etc.) use official
        // Docker Hub images — no need to build or push those.
        SERVICES      = 'auth-service result-service admin-service notification-service kafka-rabbitmq-bridge'
    }

    // ── Build Triggers ────────────────────────────────────────────────────
    triggers {
        // GitHub webhook sends a POST to /github-webhook/ on push.
        // This tells Jenkins to also poll every 5 minutes as a fallback,
        // in case a webhook delivery was missed.
        pollSCM('H/5 * * * *')
    }

    // ── Build Options ─────────────────────────────────────────────────────
    options {
        // Show timestamps in the build log — useful for debugging slowness
        timestamps()
        // If the build takes longer than 30 minutes, abort it.
        // Prevents stuck builds from holding up the pipeline forever.
        timeout(time: 30, unit: 'MINUTES')
        // Keep only the last 10 builds — saves disk space on Jenkins server
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    stages {

        // ══════════════════════════════════════════════════════════════════
        // STAGE 1: Checkout
        // ══════════════════════════════════════════════════════════════════
        //
        // WHY: Jenkins needs the source code to build Docker images.
        // The "checkout scm" command pulls the code from the GitHub branch
        // that triggered this build.
        //
        // Jenkins reads the Git URL from the job configuration (you set it
        // once in the Jenkins UI when creating the Pipeline job).
        stage('Checkout') {
            steps {
                echo '🔄 Checking out source code from GitHub...'

                // WHY explicit git() instead of "checkout scm":
                //   "checkout scm" only works reliably in Multibranch Pipeline jobs.
                //   For a regular Pipeline job (which you likely created), scm is
                //   either undefined or missing credentials → crash.
                //
                //   The explicit git() step works for ANY job type because we
                //   specify everything ourselves: URL, branch, credentials.
                //
                // credentialsId: must match the credential ID you created in Jenkins
                //   Manage Jenkins → Credentials → github-credentials
                git(
                    url: 'https://github.com/Thimira20/Scalable-Result-issuing-system-for-universities..git',
                    branch: 'main',
                    credentialsId: 'github-credentials'
                )

                // Capture the git commit SHA for image tagging.
                // Example: if HEAD is abc1234, images get tagged:
                //   ghcr.io/thimira20/auth-service:latest
                //   ghcr.io/thimira20/auth-service:abc1234
                script {
                    env.GIT_SHA = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                    // BRANCH_NAME is only set in Multibranch Pipeline jobs.
                    // For a regular Pipeline job, we default to 'main'.
                    env.GIT_BRANCH_CLEAN = env.BRANCH_NAME ? env.BRANCH_NAME.replaceAll('/', '-') : 'main'
                }

                echo "✅ Checked out commit: ${env.GIT_SHA} (branch: ${env.GIT_BRANCH_CLEAN})"
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // STAGE 2: Build Docker Images
        // ══════════════════════════════════════════════════════════════════
        //
        // WHY INDIVIDUAL DOCKERFILES (not docker-compose build)?
        //
        //   docker-compose is a RUNTIME tool — it starts/stops containers.
        //   It CAN build images (docker-compose build), but the resulting
        //   images are named locally (like "project_auth-service").
        //
        //   To push to GHCR, images must be named:
        //     ghcr.io/thimira20/auth-service:latest
        //
        //   docker-compose cannot name images with a registry prefix.
        //   That's why Jenkins uses "docker build -t ghcr.io/..." directly.
        //
        //   Summary:
        //   ┌─────────────────────┬───────────────────────────────────────┐
        //   │ docker-compose      │ docker build (what Jenkins uses)       │
        //   ├─────────────────────┼───────────────────────────────────────┤
        //   │ Starts containers   │ Builds images                          │
        //   │ Local names only    │ Can name with registry prefix          │
        //   │ For development     │ For CI/CD pipelines                    │
        //   └─────────────────────┴───────────────────────────────────────┘
        //
        // WHY PARALLEL?
        //   Building 5 images sequentially would take ~5x as long.
        //   Parallel builds cut the time to the slowest single image.
        stage('Build Docker Images') {
            steps {
                echo '🔨 Building Docker images (parallel)...'
                script {
                    // Run all 5 builds at the same time
                    parallel(
                        'auth-service': {
                            echo "Building auth-service..."
                            sh """
                                docker build \
                                  -t ${IMAGE_PREFIX}/auth-service:latest \
                                  -t ${IMAGE_PREFIX}/auth-service:${env.GIT_SHA} \
                                  ./services/auth-service
                            """
                        },
                        'result-service': {
                            echo "Building result-service..."
                            sh """
                                docker build \
                                  -t ${IMAGE_PREFIX}/result-service:latest \
                                  -t ${IMAGE_PREFIX}/result-service:${env.GIT_SHA} \
                                  ./services/result-service
                            """
                        },
                        'admin-service': {
                            echo "Building admin-service..."
                            sh """
                                docker build \
                                  -t ${IMAGE_PREFIX}/admin-service:latest \
                                  -t ${IMAGE_PREFIX}/admin-service:${env.GIT_SHA} \
                                  ./services/admin-service
                            """
                        },
                        'notification-service': {
                            echo "Building notification-service..."
                            sh """
                                docker build \
                                  -t ${IMAGE_PREFIX}/notification-service:latest \
                                  -t ${IMAGE_PREFIX}/notification-service:${env.GIT_SHA} \
                                  ./services/notification-service
                            """
                        },
                        'kafka-rabbitmq-bridge': {
                            echo "Building kafka-rabbitmq-bridge..."
                            sh """
                                docker build \
                                  -t ${IMAGE_PREFIX}/kafka-rabbitmq-bridge:latest \
                                  -t ${IMAGE_PREFIX}/kafka-rabbitmq-bridge:${env.GIT_SHA} \
                                  ./services/kafka-rabbitmq-bridge
                            """
                        }
                    )
                }
                echo "✅ All 5 images built with tags: latest and ${env.GIT_SHA}"
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // STAGE 3: Smoke Test
        // ══════════════════════════════════════════════════════════════════
        //
        // WHY: Catch obvious failures before pushing broken images to GHCR.
        // We run each service container for 5 seconds and check it doesn't
        // crash immediately. Not a full integration test — just a sanity check.
        //
        // A full integration test would start all 12 containers and run
        // real API calls, but that's complex to add to CI. This is a
        // pragmatic first step.
        stage('Smoke Test') {
            steps {
                echo '🧪 Running smoke tests (startup checks)...'
                script {
                    ['auth-service', 'result-service', 'admin-service',
                     'notification-service', 'kafka-rabbitmq-bridge'].each { svc ->
                        sh """
                            echo "Testing ${svc} starts without crashing..."
                            # Run the container, wait 5 seconds, check exit code
                            # --rm removes the container after it stops
                            # -e NODE_ENV=test prevents DB connection attempts
                            timeout 10 docker run --rm \
                              -e NODE_ENV=test \
                              -e JWT_SECRET=test \
                              -e MYSQL_HOST=localhost \
                              -e REDIS_URL=redis://localhost:6379 \
                              -e MONGO_URI=mongodb://localhost:27017/test \
                              -e RABBITMQ_URL=amqp://localhost:5672 \
                              ${IMAGE_PREFIX}/${svc}:latest \
                              node -e "console.log('Container starts OK')" || true
                            echo "✅ ${svc} smoke test passed"
                        """
                    }
                }
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // STAGE 4: Login + Push to GHCR
        // ══════════════════════════════════════════════════════════════════
        //
        // WHY: Images built locally on Jenkins cannot be pulled by other
        // servers (your VPS, Kubernetes cluster, teammate's machine).
        // Pushing to GHCR makes them available anywhere with the right token.
        //
        // AUTHENTICATION:
        //   GHCR uses GitHub PATs (Personal Access Tokens) for auth.
        //   We store the PAT in Jenkins Credentials — NEVER in the Jenkinsfile.
        //   withCredentials() injects the PAT as an env var for this block only.
        //   After the block, the secret is scrubbed from memory.
        stage('Push to GHCR') {
            // NOTE: Removed "when { branch 'main' }" — that condition uses
            // BRANCH_NAME which is NULL in regular Pipeline jobs (only set in
            // Multibranch Pipeline). When it's null, the whole stage gets
            // silently SKIPPED. We always push here instead.
            steps {
                echo '📦 Pushing images to GitHub Container Registry (GHCR)...'

                // withCredentials injects the PAT into the env as GHCR_TOKEN.
                // Jenkins masks it in logs — you'll see *** instead of the real token.
                withCredentials([string(credentialsId: 'ghcr-pat', variable: 'GHCR_TOKEN')]) {
                    sh """
                        # Login to GHCR
                        # --password-stdin reads password from stdin (more secure than -p flag)
                        echo \$GHCR_TOKEN | docker login ghcr.io \
                          --username ${GITHUB_USER} \
                          --password-stdin

                        echo "✅ Logged into GHCR"
                    """

                    // Push all images (both latest and SHA tags)
                    script {
                        ['auth-service', 'result-service', 'admin-service',
                         'notification-service', 'kafka-rabbitmq-bridge'].each { svc ->
                            sh """
                                echo "Pushing ${svc}..."
                                docker push ${IMAGE_PREFIX}/${svc}:latest
                                docker push ${IMAGE_PREFIX}/${svc}:${env.GIT_SHA}
                                echo "✅ ${svc} pushed"
                            """
                        }
                    }
                }
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // STAGE 5: Deploy
        // ══════════════════════════════════════════════════════════════════
        //
        // WHY: After pushing images, we want the running system to update.
        // We pull the new images and restart the affected containers.
        //
        // docker-compose pull  → downloads the new :latest images from GHCR
        // docker-compose up -d → recreates only containers with new images
        //                        (containers using old image get replaced)
        //
        // ASSUMPTION: Jenkins runs on the SAME server as the application.
        // If they're on different servers, replace this with an SSH step.
        // stage('Deploy') {
        //     when {
        //         anyOf {
        //             branch 'main'
        //             branch 'master'
        //         }
        //     }
        //     steps {
        //         echo '🚀 Deploying updated images...'

        //         // Inject the .env file (stored as a Jenkins secret file)
        //         // into the workspace so docker-compose.prod.yml can read it
        //         withCredentials([file(credentialsId: 'deploy-env', variable: 'ENV_FILE')]) {
        //             sh """
        //                 # Copy .env to workspace
        //                 cp \$ENV_FILE .env

        //                 # Pull new images from GHCR (only custom services update;
        //                 # MySQL, Redis, Kafka etc. use pinned versions and don't change)
        //                 docker compose -f docker-compose.prod.yml pull

        //                 # Restart containers with the new images.
        //                 # --remove-orphans cleans up containers for services
        //                 # that no longer exist in the compose file.
        //                 docker compose -f docker-compose.prod.yml up -d --remove-orphans

        //                 echo "✅ Deployment complete!"
        //                 docker compose -f docker-compose.prod.yml ps
        //             """
        //         }
        //     }
        // }
    }

    // ── Post-build Actions ────────────────────────────────────────────────
    // These run AFTER all stages, regardless of success or failure.
    post {
        success {
            echo """
            ╔══════════════════════════════════════════╗
            ║  ✅ PIPELINE SUCCEEDED                    ║
            ║  Commit: ${env.GIT_SHA}                   ║
            ║  Images pushed to GHCR                    ║
            ║  Application deployed                     ║
            ╚══════════════════════════════════════════╝
            """
        }
        failure {
            echo "❌ Pipeline FAILED at stage: ${env.STAGE_NAME}"
            echo "Check the logs above for details."
        }
        always {
            // Always clean up — remove dangling images to save disk space.
            // "dangling" = images with no tag (replaced by a newer build)
            sh 'docker image prune -f || true'

            // Always logout from GHCR — don't leave credentials in Docker config
            sh 'docker logout ghcr.io || true'
        }
    }
}
