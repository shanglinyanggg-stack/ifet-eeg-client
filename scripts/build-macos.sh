#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$ROOT/src-tauri"
ALGORITHM_DIR="$TAURI_DIR/resources/SleepStagingAlgorithm_PC_v1.2.0"
BUILD_DIR="$TAURI_DIR/target/macos-runtime"
VENV_DIR="$BUILD_DIR/venv"
DIST_DIR="$BUILD_DIR/dist"
WORK_DIR="$BUILD_DIR/work"
SPEC_DIR="$BUILD_DIR/spec"
STAGED_DIR="$TAURI_DIR/target/macos-resources/SleepStagingAlgorithm_PC_v1.2.0"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS bundles must be built on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64)
    ARCH="arm64"
    NATIVE_TARGET="aarch64-apple-darwin"
    ;;
  x86_64)
    ARCH="x86_64"
    NATIVE_TARGET="x86_64-apple-darwin"
    ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

TARGET="${MACOS_TARGET:-$NATIVE_TARGET}"
if [[ "$TARGET" != "$NATIVE_TARGET" ]]; then
  echo "PyInstaller cannot cross-build the algorithm runtime: host=$NATIVE_TARGET target=$TARGET" >&2
  exit 1
fi

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"

python3 -m venv "$VENV_DIR"
PYTHON="$VENV_DIR/bin/python3"
"$PYTHON" -m pip install --disable-pip-version-check --upgrade pip
"$PYTHON" -m pip install \
  -r "$ALGORITHM_DIR/requirements-runtime.txt" \
  pyinstaller

rm -rf "$DIST_DIR" "$WORK_DIR" "$SPEC_DIR"
"$PYTHON" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name ifet-sleep-service \
  --paths "$ALGORITHM_DIR/sdk" \
  --add-data "$ALGORITHM_DIR/config:config" \
  --add-data "$ALGORITHM_DIR/models:models" \
  --distpath "$DIST_DIR" \
  --workpath "$WORK_DIR" \
  --specpath "$SPEC_DIR" \
  "$ALGORITHM_DIR/service.py"

chmod +x "$DIST_DIR/ifet-sleep-service"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  codesign \
    --force \
    --options runtime \
    --timestamp \
    --sign "$APPLE_SIGNING_IDENTITY" \
    "$DIST_DIR/ifet-sleep-service"
fi

"$PYTHON" "$ROOT/scripts/stage_macos_algorithm.py" \
  --source "$ALGORITHM_DIR" \
  --destination "$STAGED_DIR" \
  --runtime "$DIST_DIR/ifet-sleep-service" \
  --arch "$ARCH"

chmod +x "$STAGED_DIR/runtime/ifet-sleep-service"

cd "$ROOT"
if [[ ! -x "node_modules/.bin/tauri" ]]; then
  npm ci
fi
rustup target add "$TARGET"
npm run tauri -- build --target "$TARGET" --bundles app,dmg
