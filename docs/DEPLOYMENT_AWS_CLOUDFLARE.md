# Phatforces Production Deployment (AWS + Cloudflare + CI/CD)

This runbook deploys the full stack to AWS and serves traffic via Cloudflare on phatforces.me.

## Target Architecture

- Cloudflare DNS + proxy + WAF
- AWS EC2 Ubuntu host running Docker Compose
- AWS ECR for backend/frontend images
- PostgreSQL and Redis containers on the EC2 host (phase 1)
- Nginx reverse proxy container handling domain routing

## 1. AWS Resources

Create these resources in AWS (recommended region: ap-southeast-1):

1. IAM OIDC role for GitHub Actions
2. ECR repositories:
   - phatforces-backend
   - phatforces-frontend
3. EC2 instance:
   - Ubuntu 22.04
   - t3.medium or larger
   - 50GB+ gp3 storage
4. Security group:
   - allow 22 from your IP
   - allow 80 from 0.0.0.0/0
   - allow 443 from 0.0.0.0/0

## 2. EC2 First-Time Setup

SSH into EC2 and run:

```bash
cd /home/ubuntu
git clone <your-repo-url> phatforces
cd phatforces
chmod +x deploy/first_bootstrap.sh
./deploy/first_bootstrap.sh
```

Then create production env file:

```bash
cd /home/ubuntu/phatforces/deploy
cp .env.prod.example .env.prod
nano .env.prod
```

Set real values for POSTGRES_PASSWORD, JWT_SECRET, RESEND_API_KEY, and AWS account fields.

## 3. Cloudflare Setup For phatforces.me

In Cloudflare DNS:

1. Add A record @ -> EC2 public IP (Proxied ON)
2. Add A record www -> EC2 public IP (Proxied ON)

In Cloudflare SSL/TLS:

1. Set mode to Flexible for initial bring-up on port 80
2. After confirming site works, switch to Full (strict) and configure HTTPS origin cert on Nginx

In Cloudflare Security:

1. Turn on Bot Fight Mode
2. Enable basic WAF managed rules

## 4. GitHub Secrets Required

Add these repository secrets:

- AWS_ROLE_TO_ASSUME
- AWS_REGION
- AWS_ACCOUNT_ID
- ECR_BACKEND_REPOSITORY
- ECR_FRONTEND_REPOSITORY
- EC2_HOST
- EC2_USER
- EC2_SSH_KEY
- EC2_PROJECT_PATH

Recommended values:

- EC2_USER=ubuntu
- EC2_PROJECT_PATH=/home/ubuntu/phatforces

## 5. CI/CD Flow

- On push to main:
  1. CI workflow builds backend/frontend
  2. Deploy workflow builds Docker images
  3. Deploy workflow pushes images to ECR using commit SHA tag
  4. Deploy workflow SSHes to EC2 and runs deploy/deploy.sh

## 6. Manual Deployment (Fallback)

If CI is unavailable:

```bash
cd /home/ubuntu/phatforces/deploy
export IMAGE_TAG=latest
chmod +x deploy.sh
./deploy.sh
```

## 7. Validation Checklist

Run these checks:

```bash
curl -I http://phatforces.me
curl -I http://phatforces.me/api/health
```

Expected:

- homepage returns 200 or 307/308 -> 200
- /api/health returns JSON with status ok

## 8. Post-Deploy Hardening

1. Move PostgreSQL to AWS RDS
2. Move Redis to ElastiCache
3. Move uploads to S3 + CloudFront or Cloudflare R2
4. Add HTTPS origin certificates and enforce TLS
5. Add database automated backups and monitoring

## 9. Rollback

On EC2:

```bash
cd /home/ubuntu/phatforces/deploy
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous_sha>/' .env.prod
./deploy.sh
```
