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
MANAGE_LOCAL_MONGOD="${MANAGE_LOCAL_MONGOD:-0}"
MONGOD_DBPATH="${MONGOD_DBPATH:-$HOME/data/db}"
MONGOD_LOGPATH="${MONGOD_LOGPATH:-$HOME/data/mongod.log}"

started_mongo_mode=""
started_mongod_by_script=0

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  exit 1
fi

cleanup() {
  if [[ "${started_mongod_by_script}" -eq 1 ]]; then
    if [[ "${started_mongo_mode}" == "brew" ]]; then
      echo "Stopping local MongoDB service..."
      brew services stop "${MONGODB_BREW_SERVICE}" >/dev/null || true
    elif [[ "${started_mongo_mode}" == "fork" ]]; then
      echo "Stopping local mongod..."
      if command -v mongosh >/dev/null 2>&1; then
        mongosh --quiet --eval "db.adminCommand({ shutdown: 1 })" >/dev/null 2>&1 || true
      fi
      if command -v pkill >/dev/null 2>&1; then
        pkill -f "mongod.*${MONGOD_DBPATH}" >/dev/null 2>&1 || true
      fi
    fi
  fi
}
trap cleanup EXIT

is_mongo_running() {
  if command -v mongosh >/dev/null 2>&1; then
    mongosh --quiet --eval "db.adminCommand({ ping: 1 }).ok" >/dev/null 2>&1
    return $?
  fi

  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x mongod >/dev/null 2>&1
    return $?
  fi

  return 1
}

start_local_mongo_if_needed() {
  if [[ "${MANAGE_LOCAL_MONGOD}" != "1" ]]; then
    return
  fi

  if is_mongo_running; then
    echo "Local MongoDB is already running."
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    MONGODB_BREW_SERVICE="$(brew services list | awk '/^mongodb-community@/ {print $1; exit}')"
    if [[ -n "${MONGODB_BREW_SERVICE:-}" ]]; then
      echo "Starting local MongoDB via brew service (${MONGODB_BREW_SERVICE})..."
      brew services start "${MONGODB_BREW_SERVICE}" >/dev/null
      started_mongo_mode="brew"
      started_mongod_by_script=1
      return
    fi
  fi

  if command -v mongod >/dev/null 2>&1; then
    mkdir -p "${MONGOD_DBPATH}"
    mkdir -p "$(dirname "${MONGOD_LOGPATH}")"
    echo "Starting local mongod with dbpath ${MONGOD_DBPATH}..."
    mongod --dbpath "${MONGOD_DBPATH}" --logpath "${MONGOD_LOGPATH}" --fork >/dev/null
    started_mongo_mode="fork"
    started_mongod_by_script=1
    return
  fi

  echo "MANAGE_LOCAL_MONGOD=1 but neither brew mongodb service nor mongod binary was found."
  echo "Install MongoDB locally, or set MANAGE_LOCAL_MONGOD=0."
  exit 1
}

start_local_mongo_if_needed

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
