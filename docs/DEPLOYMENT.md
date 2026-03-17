# AWS + Cloudflare Setup Guide for Phatforces

## Architecture
```
Users -> Cloudflare (DNS + DDoS + CDN)
      -> EC2 (t3.small, ap-southeast-1)
           -> Docker Compose
                -> Nginx (80/443)
                -> Frontend (Next.js :3000)
                -> Backend (Go :8080)
                -> PostgreSQL (:5432)
                -> Redis (:6379)
AWS ECR -> stores Docker images (built by GitHub Actions)
```

---

## Step 1: AWS Setup

### 1a. Create ECR Repositories
Run in AWS CLI (or AWS Console > ECR):
```bash
aws ecr create-repository --repository-name phatforces-backend --region ap-southeast-1
aws ecr create-repository --repository-name phatforces-frontend --region ap-southeast-1
```

### 1b. Create IAM Role for GitHub Actions (OIDC)
1. Go to IAM > Identity Providers > Add Provider
   - Provider type: OpenID Connect
   - Provider URL: https://token.actions.githubusercontent.com
   - Audience: sts.amazonaws.com
2. Create IAM Role:
   - Trusted entity: Web identity
   - Identity provider: token.actions.githubusercontent.com
   - Audience: sts.amazonaws.com
   - GitHub condition: `repo:Phat1911/Phatforces:ref:refs/heads/main`
3. Attach this inline policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "*"
    }
  ]
}
```
4. Note the Role ARN: `arn:aws:iam::ACCOUNT_ID:role/phatforces-github-actions`

### 1c. Launch EC2 Instance
- AMI: Ubuntu 22.04 LTS (ap-southeast-1)
- Type: t3.small (2 vCPU, 2GB RAM) - minimum for all services
- Storage: 20GB gp3
- Security Group rules:
  - SSH (22) from your IP only
  - HTTP (80) from Cloudflare IPs (or 0.0.0.0/0 for simplicity)
  - HTTPS (443) from Cloudflare IPs (or 0.0.0.0/0)
- Key pair: create/download as phatforces-ec2.pem
- IAM Role: attach role with ECR pull permissions (AmazonEC2ContainerRegistryReadOnly)

### 1d. Attach EC2 IAM Role for ECR Pull
Create another role "phatforces-ec2-role" with:
- Trusted entity: EC2
- Policy: AmazonEC2ContainerRegistryReadOnly

Attach it to your EC2 instance.

### 1e. Bootstrap the EC2 Server
SSH into server and run:
```bash
ssh -i phatforces-ec2.pem ubuntu@EC2_PUBLIC_IP
git clone https://github.com/Phat1911/Phatforces.git /home/ubuntu/phatforces
cd /home/ubuntu/phatforces
chmod +x deploy/first_bootstrap.sh
./deploy/first_bootstrap.sh
newgrp docker  # OR logout and login again

# Generate SSL cert
chmod +x deploy/nginx/generate-ssl.sh
./deploy/nginx/generate-ssl.sh

# Create .env.prod
cp deploy/.env.prod.example deploy/.env.prod
nano deploy/.env.prod   # Fill in all values
```

---

## Step 2: Cloudflare Setup

1. Add site phatforces.me to Cloudflare (free plan works)
2. Update Namecheap nameservers to Cloudflare's:
   - Go to Namecheap > phatforces.me > Nameservers
   - Select Custom DNS
   - Enter the two nameservers Cloudflare gives you
3. In Cloudflare DNS:
   - Add A record: `@` -> EC2_PUBLIC_IP (Proxied = ON, orange cloud)
   - Add A record: `www` -> EC2_PUBLIC_IP (Proxied = ON)
4. SSL/TLS settings:
   - Mode: Full (not Full Strict for now with self-signed cert)
   - Or: Full Strict with Cloudflare Origin Certificate
5. Security > Firewall: optionally allow only Cloudflare IPs to port 80/443

---

## Step 3: GitHub Secrets
Go to github.com/Phat1911/Phatforces > Settings > Secrets > Actions:

| Secret Name | Value |
|---|---|
| AWS_ROLE_TO_ASSUME | arn:aws:iam::ACCOUNT_ID:role/phatforces-github-actions |
| AWS_REGION | ap-southeast-1 |
| AWS_ACCOUNT_ID | Your 12-digit AWS account ID |
| ECR_BACKEND_REPOSITORY | phatforces-backend |
| ECR_FRONTEND_REPOSITORY | phatforces-frontend |
| EC2_HOST | EC2 public IP or DNS |
| EC2_USER | ubuntu |
| EC2_SSH_KEY | Contents of phatforces-ec2.pem |
| EC2_PROJECT_PATH | /home/ubuntu/phatforces |

---

## Step 4: First Deploy
```bash
cd /home/hong_phat/my_project/photcot
git add -A
git commit -m "feat: production deployment config"
git push origin main
```
GitHub Actions will:
1. Run tests (ci.yml)
2. Build Docker images + push to ECR
3. SSH into EC2 and run deploy.sh
4. Zero-downtime rolling update via Docker Compose

---

## Verify Deployment
- https://phatforces.me -> frontend
- https://phatforces.me/api/health -> {"app":"Phatforces","status":"ok"}
