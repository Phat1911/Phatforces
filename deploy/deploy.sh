#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env.prod ]]; then
  echo "Missing deploy/.env.prod. Copy .env.prod.example and set values."
  exit 1
fi

set -a
source .env.prod
set +a

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker compose -f docker-compose.prod.yml --env-file .env.prod pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --remove-orphans

docker image prune -f

echo "Deployment completed with IMAGE_TAG=$IMAGE_TAG"
