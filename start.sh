#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-${PORT:-3000}}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"

if [[ ! -d api/dist ]]; then
  echo "Missing build output: api/dist"
  echo "Run: npm --prefix api run build"
  exit 1
fi

if [[ ! -d client/dist ]]; then
  echo "Missing build output: client/dist"
  echo "Run: npm --prefix client run build"
  exit 1
fi

echo "Starting API on port ${API_PORT}..."
PORT="${API_PORT}" npm --prefix api run start:prod &
api_pid=$!

echo "Starting frontend on port ${FRONTEND_PORT}..."
npm --prefix client run preview -- --host 0.0.0.0 --port "${FRONTEND_PORT}" &
frontend_pid=$!

cleanup() {
  kill "${api_pid}" "${frontend_pid}" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

set +e
while true; do
  if ! kill -0 "${api_pid}" 2>/dev/null; then
    wait "${api_pid}"
    exit_code=$?
    break
  fi

  if ! kill -0 "${frontend_pid}" 2>/dev/null; then
    wait "${frontend_pid}"
    exit_code=$?
    break
  fi

  sleep 1
done
set -e

cleanup
wait "${api_pid}" "${frontend_pid}" 2>/dev/null || true

exit "${exit_code}"
