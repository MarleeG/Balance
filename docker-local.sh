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
WATCH_MODE="${WATCH_MODE:-1}"
WATCH_INTERVAL_SECONDS="${WATCH_INTERVAL_SECONDS:-2}"
MANAGE_LOCAL_MONGOD="${MANAGE_LOCAL_MONGOD:-0}"
MONGOD_DBPATH="${MONGOD_DBPATH:-$HOME/data/db}"
MONGOD_LOGPATH="${MONGOD_LOGPATH:-$HOME/data/mongod.log}"

started_mongo_mode=""
started_mongod_by_script=0
log_stream_pid=""
docker_env_args=()

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  exit 1
fi

cleanup() {
  if [[ -n "${log_stream_pid}" ]]; then
    kill "${log_stream_pid}" >/dev/null 2>&1 || true
    wait "${log_stream_pid}" 2>/dev/null || true
    log_stream_pid=""
  fi

  if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null || true
  fi

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

prepare_env_args() {
  docker_env_args=()
  if [[ -f "${ENV_FILE}" ]]; then
    echo "Using env file: ${ENV_FILE}"
    docker_env_args+=(--env-file "${ENV_FILE}")
  fi
}

build_image() {
  echo "Building image ${IMAGE_NAME} using ${DOCKERFILE}..."
  DOCKER_BUILDKIT=1 docker build --progress "${DOCKER_BUILD_PROGRESS}" -t "${IMAGE_NAME}" -f "${DOCKERFILE}" .
}

remove_existing_container() {
  if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
    echo "Removing existing container ${CONTAINER_NAME}..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null
  fi
}

start_container_foreground() {
  echo "Starting container ${CONTAINER_NAME}..."
  echo "Frontend: http://localhost:${FRONTEND_HOST_PORT}"
  echo "API: http://localhost:${API_HOST_PORT}"
  docker run --rm \
    --name "${CONTAINER_NAME}" \
    -p "${API_HOST_PORT}:3000" \
    -p "${FRONTEND_HOST_PORT}:4173" \
    "${docker_env_args[@]}" \
    "${IMAGE_NAME}"
}

start_container_detached() {
  echo "Starting container ${CONTAINER_NAME} in watch mode..."
  echo "Frontend: http://localhost:${FRONTEND_HOST_PORT}"
  echo "API: http://localhost:${API_HOST_PORT}"
  docker run --rm -d \
    --name "${CONTAINER_NAME}" \
    -p "${API_HOST_PORT}:3000" \
    -p "${FRONTEND_HOST_PORT}:4173" \
    "${docker_env_args[@]}" \
    "${IMAGE_NAME}" >/dev/null
}

start_log_stream() {
  if [[ -n "${log_stream_pid}" ]]; then
    kill "${log_stream_pid}" >/dev/null 2>&1 || true
    wait "${log_stream_pid}" 2>/dev/null || true
  fi

  docker logs -f "${CONTAINER_NAME}" &
  log_stream_pid=$!
}

compute_watch_hash() {
  local configured_targets=(
    api/src
    api/test
    api/package.json
    api/package-lock.json
    api/tsconfig.json
    api/tsconfig.build.json
    api/nest-cli.json
    client/src
    client/public
    client/index.html
    client/package.json
    client/package-lock.json
    client/tsconfig.json
    client/tsconfig.app.json
    client/vite.config.ts
    Dockerfile
    start.sh
    docker-local.sh
  )
  local existing_targets=()
  local target

  if [[ -f "${ENV_FILE}" ]]; then
    configured_targets+=("${ENV_FILE}")
  fi

  for target in "${configured_targets[@]}"; do
    if [[ -e "${target}" ]]; then
      existing_targets+=("${target}")
    fi
  done

  if [[ "${#existing_targets[@]}" -eq 0 ]]; then
    echo "no-targets"
    return
  fi

  local hash
  hash="$(
    find "${existing_targets[@]}" -type f \
      ! -path '*/node_modules/*' \
      ! -path '*/dist/*' \
      -print0 2>/dev/null \
      | xargs -0 shasum 2>/dev/null \
      | shasum \
      | awk '{print $1}'
  )"

  echo "${hash}"
}

restart_container_for_watch() {
  if ! build_image; then
    echo "Build failed. Keeping current container running."
    return
  fi

  remove_existing_container
  start_container_detached
  start_log_stream
}

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

prepare_env_args
build_image

remove_existing_container

if [[ "${WATCH_MODE}" == "1" ]]; then
  start_container_detached
  start_log_stream

  last_hash="$(compute_watch_hash)"
  echo "Watch mode enabled. Polling for changes every ${WATCH_INTERVAL_SECONDS}s..."

  while true; do
    sleep "${WATCH_INTERVAL_SECONDS}"
    current_hash="$(compute_watch_hash)"
    if [[ "${current_hash}" != "${last_hash}" ]]; then
      echo "Detected file changes. Rebuilding and restarting ${CONTAINER_NAME}..."
      restart_container_for_watch
      last_hash="${current_hash}"
    fi
  done
else
  start_container_foreground
fi
