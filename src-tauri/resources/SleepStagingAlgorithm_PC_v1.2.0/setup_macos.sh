#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
python3 -m venv "$ROOT/.venv"
PYTHON="$ROOT/.venv/bin/python3"
"$PYTHON" -m pip install --upgrade pip
"$PYTHON" -m pip install -r "$ROOT/requirements-runtime.txt"
echo "Runtime installed. Run ./start_service.sh next."
