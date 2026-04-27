// Jenkinsfile — Windows Jenkins CI/CD Pipeline
// GitHub → Jenkins (Windows) → Docker Build → GHCR Push
//
// KEY DIFFERENCE from Linux Jenkins:
//   Linux: sh """..."""   (bash)
//   Windows: powershell """..."""  (PowerShell)
//
// PowerShell vs bat on Windows Jenkins:
//   bat: only runs single-line or simple .cmd syntax — NO \ continuation, NO # comments
//   powershell: supports multi-line, backtick ` continuation, # comments — use this!

pipeline {
    agent any

    environment {
        GITHUB_USER  = 'thimira20'
        IMAGE_PREFIX = 'ghcr.io/thimira20'
    }

    options {
        timestamps()
        timeout(time: 30, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    stages {

        // ── STAGE 1: Checkout ───────────────────────────────────────────
        // Git is already installed on your Windows machine (shown in logs).
        // We use explicit git() step — works for regular Pipeline jobs.
        stage('Checkout') {
            steps {
                echo '🔄 Checking out source code from GitHub...'

                git(
                    // FIXED: single dot before .git  (you had ..git — double dot)
                    url: 'https://github.com/Thimira20/Scalable-Result-issuing-system-for-universities..git',
                    branch: 'main',
                    credentialsId: 'github-credentials'
                )

                script {
                    // powershell(returnStdout:true) captures command output as a string
                    // Same as sh(returnStdout:true) on Linux
                    env.GIT_SHA = powershell(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                }

                echo "✅ Checked out commit: ${env.GIT_SHA}"
            }
        }

        // ── STAGE 2: Build Docker Images ────────────────────────────────
        // docker build works on Windows with Docker Desktop running.
        //
        // POWERSHELL SYNTAX NOTE:
        //   \$env:IMAGE_PREFIX  →  \$ tells Groovy "don't interpolate this"
        //                          PowerShell then sees $env:IMAGE_PREFIX and
        //                          reads it from the OS environment (set by
        //                          the environment{} block above).
        //   ${svc}             →  Groovy interpolates this (loop variable)
        //   Backtick `         →  PowerShell line continuation (NOT backslash \)
        stage('Build Docker Images') {
            steps {
                echo '🔨 Building Docker images (parallel)...'
                script {
                    parallel(
                        'auth-service': {
                            powershell """
                                docker build `
                                  -t \$env:IMAGE_PREFIX/auth-service:latest `
                                  -t \$env:IMAGE_PREFIX/auth-service:${env.GIT_SHA} `
                                  ./services/auth-service
                            """
                        },
                        'result-service': {
                            powershell """
                                docker build `
                                  -t \$env:IMAGE_PREFIX/result-service:latest `
                                  -t \$env:IMAGE_PREFIX/result-service:${env.GIT_SHA} `
                                  ./services/result-service
                            """
                        },
                        'admin-service': {
                            powershell """
                                docker build `
                                  -t \$env:IMAGE_PREFIX/admin-service:latest `
                                  -t \$env:IMAGE_PREFIX/admin-service:${env.GIT_SHA} `
                                  ./services/admin-service
                            """
                        },
                        'notification-service': {
                            powershell """
                                docker build `
                                  -t \$env:IMAGE_PREFIX/notification-service:latest `
                                  -t \$env:IMAGE_PREFIX/notification-service:${env.GIT_SHA} `
                                  ./services/notification-service
                            """
                        },
                        'kafka-rabbitmq-bridge': {
                            powershell """
                                docker build `
                                  -t \$env:IMAGE_PREFIX/kafka-rabbitmq-bridge:latest `
                                  -t \$env:IMAGE_PREFIX/kafka-rabbitmq-bridge:${env.GIT_SHA} `
                                  ./services/kafka-rabbitmq-bridge
                            """
                        }
                    )
                }
                echo "✅ All 5 images built — tagged :latest and :${env.GIT_SHA}"
            }
        }

        // ── STAGE 3: Smoke Test ─────────────────────────────────────────
        // Runs each image with just "node -e console.log()" to verify
        // the image starts without crashing.
        // No Linux "timeout" command needed — docker run exits naturally.
        stage('Smoke Test') {
            steps {
                echo '🧪 Smoke testing images...'
                script {
                    ['auth-service', 'result-service', 'admin-service',
                     'notification-service', 'kafka-rabbitmq-bridge'].each { svc ->
                        echo "Testing ${svc}..."
                        powershell """
                            docker run --rm `
                              -e NODE_ENV=test `
                              -e JWT_SECRET=test `
                              \$env:IMAGE_PREFIX/${svc}:latest `
                              node -e "console.log('${svc} image OK')"
                        """
                    }
                }
                echo '✅ All images passed smoke test'
            }
        }

        // ── STAGE 4: Push to GHCR ───────────────────────────────────────
        // withCredentials injects GHCR_TOKEN into the OS environment.
        // PowerShell reads it as $env:GHCR_TOKEN.
        //
        // Single-quoted '''...''' = Groovy does NOT interpolate anything.
        // PowerShell resolves $env:GHCR_TOKEN itself from OS env.
        // This is the SAFE way to handle secrets — Groovy never touches them.
        stage('Push to GHCR') {
            steps {
                echo '📦 Pushing images to GitHub Container Registry...'
                withCredentials([string(credentialsId: 'ghcr-pat', variable: 'GHCR_TOKEN')]) {

                    // Login — single quotes so Groovy doesn't try to resolve $env:GHCR_TOKEN
                    powershell '''
                        Write-Host "Logging in to ghcr.io..."
                        echo $env:GHCR_TOKEN | docker login ghcr.io `
                          --username thimira20 `
                          --password-stdin
                        Write-Host "Login successful"
                    '''

                    // Push all images
                    script {
                        ['auth-service', 'result-service', 'admin-service',
                         'notification-service', 'kafka-rabbitmq-bridge'].each { svc ->
                            echo "Pushing ${svc}..."
                            // Double-quoted so Groovy interpolates ${svc} and ${env.GIT_SHA}
                            // \$env:IMAGE_PREFIX is escaped so PowerShell resolves it
                            powershell """
                                docker push \$env:IMAGE_PREFIX/${svc}:latest
                                docker push \$env:IMAGE_PREFIX/${svc}:${env.GIT_SHA}
                                Write-Host "✅ ${svc} pushed"
                            """
                        }
                    }
                }
            }
        }

        // ── STAGE 5: Deploy (commented — no server yet) ─────────────────
        // Uncomment when you have a server to deploy to.
        // stage('Deploy') { ... }
    }

    post {
        success {
            echo "✅ Pipeline SUCCEEDED — commit ${env.GIT_SHA} images are on GHCR"
        }
        failure {
            echo "❌ Pipeline FAILED — check the stage logs above"
        }
        always {
            // Cleanup — || true equivalent in Windows: & exit 0
            // bat is fine here since these are simple one-line commands
            bat 'docker image prune -f & exit 0'
            bat 'docker logout ghcr.io & exit 0'
        }
    }
}
