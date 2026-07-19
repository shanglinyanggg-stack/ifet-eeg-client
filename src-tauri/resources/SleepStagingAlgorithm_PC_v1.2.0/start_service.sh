#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUNDLED_RUNTIME="$ROOT/runtime/ifet-sleep-service"
if [[ -x "$BUNDLED_RUNTIME" ]]; then
  exec "$BUNDLED_RUNTIME" "$@"
fi

PYTHON="$ROOT/.venv/bin/python3"
if [[ ! -x "$PYTHON" ]]; then
  echo "Bundled runtime and Python fallback are both missing." >&2
  exit 1
fi
export PYTHONUTF8=1
exec "$PYTHON" "$ROOT/service.py" "$@"
