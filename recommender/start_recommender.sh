#!/bin/bash
# Start Photcot recommender microservice
# Usage: ./start_recommender.sh
# Reads DATABASE_URL from backend .env if available

export PATH=/home/hong_phat/go/bin:$PATH
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV="$PROJECT_DIR/recommender_venv"

# Load DB URL from backend .env if it exists
ENV_FILE="$PROJECT_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
    export $(grep -v '^#' "$ENV_FILE" | grep DATABASE_URL | xargs) 2>/dev/null
fi

# Kill any previous instance
fuser -k 8090/tcp 2>/dev/null
sleep 1

echo "Starting recommender on port 8090..."
nohup "$VENV/bin/python3" "$SCRIPT_DIR/recommender.py" > /tmp/recommender.log 2>&1 &
sleep 3

# Health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8090/health)
if [ "$HTTP_CODE" = "200" ]; then
    echo "Recommender is UP (port 8090)"
    curl -s http://localhost:8090/health | python3 -m json.tool
else
    echo "Recommender failed to start (HTTP $HTTP_CODE). Check /tmp/recommender.log:"
    tail -20 /tmp/recommender.log
fi
