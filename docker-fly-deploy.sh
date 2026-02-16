#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

DOCKERFILE="${DOCKERFILE:-Dockerfile}"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl is not installed or not on PATH."
  exit 1
fi

cmd=(flyctl deploy --dockerfile "${DOCKERFILE}")

if [[ -n "${FLY_APP_NAME:-}" ]]; then
  cmd+=(--app "${FLY_APP_NAME}")
fi

if [[ -n "${FLY_CONFIG:-}" ]]; then
  cmd+=(--config "${FLY_CONFIG}")
fi

cmd+=("$@")

echo "Running: ${cmd[*]}"
"${cmd[@]}"
