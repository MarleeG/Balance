#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

IMAGE_NAME="${IMAGE_NAME:-balance-app}"
CONTAINER_NAME="${CONTAINER_NAME:-balance-app-local}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
DOCKER_BUILD_PROGRESS="${DOCKER_BUILD_PROGRESS:-plain}"
API_HOST_PORT="${API_HOST_PORT:-3000}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-4173}"
ENV_FILE="${ENV_FILE:-api/.env}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  exit 1
fi

echo "Building image ${IMAGE_NAME} using ${DOCKERFILE}..."
DOCKER_BUILDKIT=1 docker build --progress "${DOCKER_BUILD_PROGRESS}" -t "${IMAGE_NAME}" -f "${DOCKERFILE}" .

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  echo "Removing existing container ${CONTAINER_NAME}..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

echo "Starting container ${CONTAINER_NAME}..."
echo "Frontend: http://localhost:${FRONTEND_HOST_PORT}"
echo "API: http://localhost:${API_HOST_PORT}"
docker_env_args=()
if [[ -f "${ENV_FILE}" ]]; then
  echo "Using env file: ${ENV_FILE}"
  docker_env_args+=(--env-file "${ENV_FILE}")
fi

docker run --rm \
  --name "${CONTAINER_NAME}" \
  -p "${API_HOST_PORT}:3000" \
  -p "${FRONTEND_HOST_PORT}:4173" \
  "${docker_env_args[@]}" \
  "${IMAGE_NAME}"
