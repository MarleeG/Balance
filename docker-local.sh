#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

IMAGE_NAME="${IMAGE_NAME:-balance-app}"
CONTAINER_NAME="${CONTAINER_NAME:-balance-app-local}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
API_HOST_PORT="${API_HOST_PORT:-3000}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-4173}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  exit 1
fi

echo "Building image ${IMAGE_NAME} using ${DOCKERFILE}..."
docker build -t "${IMAGE_NAME}" -f "${DOCKERFILE}" .

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  echo "Removing existing container ${CONTAINER_NAME}..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

echo "Starting container ${CONTAINER_NAME}..."
echo "Frontend: http://localhost:${FRONTEND_HOST_PORT}"
echo "API: http://localhost:${API_HOST_PORT}"
docker run --rm \
  --name "${CONTAINER_NAME}" \
  -p "${API_HOST_PORT}:3000" \
  -p "${FRONTEND_HOST_PORT}:4173" \
  "${IMAGE_NAME}"
