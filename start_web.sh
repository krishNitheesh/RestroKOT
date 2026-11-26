#!/usr/bin/env bash
set -e
export PORT="${PORT:-3000}"
export SECRET_KEY="${SECRET_KEY:-change-this-to-a-random-secret-key}"
export RESTROKOT_DATA_DIR="${RESTROKOT_DATA_DIR:-$(pwd)/data}"

mkdir -p "$RESTROKOT_DATA_DIR"

echo "Starting RestroKOT Web App on port $PORT (0% data-loss SQLite WAL + gthread)..."
exec gunicorn \
  --bind "0.0.0.0:${PORT}" \
  --workers 1 \
  --threads 16 \
  --worker-class gthread \
  --timeout 0 \
  --access-logfile - \
  app:app
