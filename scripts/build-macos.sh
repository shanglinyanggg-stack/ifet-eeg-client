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
ALGORITHM_PACKAGE_DIR="$TAURI_DIR/target/algorithm-packages"
EXPERIMENTAL_PACKAGE="$ALGORITHM_PACKAGE_DIR/ifet-band-alpha-experimental-20260824-r3.ifet-algorithm"
VALIDATION_REPORT="${VALIDATION_REPORT:-/Users/ysl/Developer/EEGDM/result/ifet_algorithm_validation_2026_08_24_band_alpha_r3/validation_report.json}"
ALGORITHM_SIGNING_KEY="${IFET_ALGORITHM_SIGNING_KEY:-/Users/ysl/Library/Application Support/iFET Algorithm Signing/algorithm_update_ed25519_private.pem}"

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

PYTHON_BOOTSTRAP="${PYTHON_BOOTSTRAP:-}"
if [[ -z "$PYTHON_BOOTSTRAP" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then
    PYTHON_BOOTSTRAP="$(command -v python3.12)"
  else
    PYTHON_BOOTSTRAP="$(command -v python3)"
  fi
fi
"$PYTHON_BOOTSTRAP" - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit("The algorithm sidecar requires Python 3.10 or newer")
PY
"$PYTHON_BOOTSTRAP" -m venv "$VENV_DIR"
PYTHON="$VENV_DIR/bin/python3"
"$PYTHON" -m pip install --disable-pip-version-check --upgrade pip
"$PYTHON" -m pip install \
  -r "$ALGORITHM_DIR/requirements-runtime.txt" \
  pyinstaller

PYTHONPATH="$ALGORITHM_DIR/sdk" "$PYTHON" "$ROOT/scripts/test_sleep_demo_v1021.py"
PYTHONPATH="$ALGORITHM_DIR/sdk" "$PYTHON" \
  "$ALGORITHM_DIR/validation/validate_adaptive_blink_v121.py" >/dev/null

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

# Stimulus edition does not update the independent experimental algorithms.
# Building a normal app must not require a private algorithm signing key.
if [[ "${BUILD_EXPERIMENTAL_ALGORITHM_PACKAGE:-0}" == "1" ]]; then
  mkdir -p "$ALGORITHM_PACKAGE_DIR"
  "$PYTHON" "$ROOT/scripts/build_algorithm_package.py" \
    --staged-stable "$STAGED_DIR" \
    --validation-report "$VALIDATION_REPORT" \
    --signing-key "$ALGORITHM_SIGNING_KEY" \
    --output "$EXPERIMENTAL_PACKAGE"
fi

cd "$ROOT"
if [[ ! -x "node_modules/.bin/tauri" ]]; then
  npm ci
fi
rustup target add "$TARGET"
npm run tauri -- build --target "$TARGET" --bundles app,dmg

if [[ "${BUILD_EXPERIMENTAL_ALGORITHM_PACKAGE:-0}" == "1" ]]; then
  echo "Independent experimental algorithm package: $EXPERIMENTAL_PACKAGE"
fi
