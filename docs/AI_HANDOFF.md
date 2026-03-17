# AI Handoff Guide For Phatforces

This file helps future AI agents continue work safely and quickly.

## Project Snapshot

- Backend: Go + Gin + PostgreSQL + Redis
- Frontend: Next.js 14 app router
- Production runtime: Docker Compose on EC2
- Registry: AWS ECR
- Edge/DNS: Cloudflare

## Critical Paths

- Backend entrypoint: backend/cmd/main.go
- Frontend homepage feed: frontend/app/page.tsx
- Profile and creator dashboard: frontend/app/profile/page.tsx
- Monetization API: backend/internal/handlers/monetization.go
- Production compose: deploy/docker-compose.prod.yml
- Nginx routing: deploy/nginx/phatforces.conf
- CI workflow: .github/workflows/ci.yml
- Deploy workflow: .github/workflows/deploy-aws.yml

## Deployment Facts

- Backend image: ${ECR_REGISTRY}/${ECR_BACKEND_REPOSITORY}:${IMAGE_TAG}
- Frontend image: ${ECR_REGISTRY}/${ECR_FRONTEND_REPOSITORY}:${IMAGE_TAG}
- API URL in production frontend: https://phatforces.me/api/v1
- Upload URL in production frontend: https://phatforces.me

## Required Secrets For Deploy Workflow

- AWS_ROLE_TO_ASSUME
- AWS_REGION
- AWS_ACCOUNT_ID
- ECR_BACKEND_REPOSITORY
- ECR_FRONTEND_REPOSITORY
- EC2_HOST
- EC2_USER
- EC2_SSH_KEY
- EC2_PROJECT_PATH

## Non-Obvious Product Behavior

1. Feed queue logic differs between public and for-you routes.
2. Upload processing uses ffmpeg/ffprobe in backend container.
3. Local uploads are mounted in Docker volume uploads_data.
4. Monetization is currently coins + estimated earnings, not Stripe payouts.

## Safe Change Strategy

1. Keep API paths stable under /api/v1.
2. Preserve NEXT_PUBLIC_API_URL and NEXT_PUBLIC_UPLOADS_URL env compatibility.
3. Prefer additive DB migrations; do not drop data tables in-place.
4. If changing feed ranking, keep fallback behavior for empty feeds.

## Recommended Next Infra Iterations

1. Add HTTPS origin cert and Nginx 443 config.
2. Move data services to managed AWS (RDS/ElastiCache).
3. Implement object storage for uploads (S3 or R2).
4. Add staging environment and preview deployments.

## Recommended Next Product Iterations

1. Sponsored challenges for local businesses.
2. Boosted posts and business billing.
3. Creator payout compliance and anti-fraud checks.
4. Retention analytics (activation, D7, D30).
