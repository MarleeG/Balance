#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

npm --prefix api install
npm --prefix client install
npm --prefix api run build
npm --prefix client run build
./start.sh
