#!/usr/bin/env bash
# Generates a self-signed certificate for use with Cloudflare Full SSL mode.
# Place output in deploy/nginx/ssl/ (gitignored).
# For Cloudflare Full (Strict): use an Origin Certificate from the Cloudflare dashboard instead.
set -euo pipefail

SSL_DIR="$(dirname "$0")/ssl"
mkdir -p "$SSL_DIR"

if [ -f "$SSL_DIR/cert.pem" ]; then
  echo "SSL cert already exists at $SSL_DIR/cert.pem. Delete to regenerate."
  exit 0
fi

openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$SSL_DIR/key.pem" \
  -out "$SSL_DIR/cert.pem" \
  -subj "/CN=phatforces.me/O=Phatforces/C=SG"

echo "Self-signed cert generated at $SSL_DIR/"
echo "For production: replace with a Cloudflare Origin Certificate."
