#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path


PACKAGE_ID = "com.ifet.sleep.experimental.band-alpha-20260824"
PACKAGE_VERSION = "1.2.0+band-alpha-exp.20260824.3"
PACKAGE_FOLDER = f"{PACKAGE_ID}-{PACKAGE_VERSION}"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_checksums(root: Path) -> None:
    checksum_path = root / "SHA256SUMS.txt"
    entries = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path != checksum_path:
            entries.append(f"{sha256(path)}  {path.relative_to(root).as_posix()}")
    checksum_path.write_text("\n".join(entries) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build an independently installable iFET algorithm package")
    parser.add_argument("--staged-stable", type=Path, required=True)
    parser.add_argument("--validation-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--signing-key", type=Path, required=True)
    args = parser.parse_args()

    if not (args.staged_stable / "algorithm_manifest.json").is_file():
        raise SystemExit("staged stable package is missing algorithm_manifest.json")
    if not args.validation_report.is_file():
        raise SystemExit("validation report does not exist")
    if not args.signing_key.is_file():
        raise SystemExit("Ed25519 signing key does not exist")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ifet-algorithm-") as temporary:
        root = Path(temporary) / PACKAGE_FOLDER
        shutil.copytree(args.staged_stable, root)
        manifest_path = root / "algorithm_manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(
            {
                "package": "iFET_Experimental_Band_Alpha_20260824",
                "package_id": PACKAGE_ID,
                "display_name": "状态增强视觉占比 + 个体 Alpha 修正 3",
                "version": PACKAGE_VERSION,
                "channel": "experimental",
                "algorithm_profile": "experimental-band-alpha-20260824",
                "host_api": {"minimum": 3, "maximum": 3},
                "release_approved": False,
                "calibration_schema_version": "ifet-calibration/experimental-band-alpha-20260824/v3",
                "validation": {
                    "release_approved": False,
                    "report": "validation/validation_report.json",
                    "warning": (
                        "The original physiological release gate remains failed. "
                        "The workflow-driven visual mapping passed only its presentation "
                        "checks. Research and controlled testing only."
                    ),
                },
                "signature": {
                    "algorithm": "Ed25519",
                    "key_id": "ifet-algorithm-update-2026-08",
                    "signed_file": "SHA256SUMS.txt",
                    "signature_file": "SIGNATURE.ed25519",
                },
                "capabilities": {
                    "sleep_staging": True,
                    "alpha_control": True,
                    "blink_control": True,
                    "band_share": True,
                    "individual_alpha": True,
                },
                "experimental_parameters": {
                    "band_window_seconds": 8,
                    "band_step_seconds": 1.0,
                    "band_psd": "4-second Hann Welch, 75% overlap",
                    "band_reference": "spatial robust reference with temporal-centering fallback",
                    "band_aperiodic_equalisation_exponent": 1.75,
                    "band_delta_subdelta_drift_gate": True,
                    "band_share_output": "state_enhanced_visual_index_not_physical_power",
                    "band_visual_driver": (
                        "open/idle=awake; closed calibration or active sleep guidance="
                        "eyes_closed; valid NREM plus sustained corrected Delta="
                        "deep_sleep_candidate"
                    ),
                    "band_share_anchors": {
                        "awake": [0.06, 0.10, 0.18, 0.66],
                        "eyes_closed": [0.08, 0.10, 0.66, 0.16],
                        "deep_sleep_candidate": [0.68, 0.18, 0.07, 0.07],
                    },
                    "calibration_duration_seconds": 20,
                    "calibration_minimum_valid_fraction": 0.75,
                    "bands_hz": {
                        "delta": [0.5, 2.0],
                        "theta": [4.0, 7.0],
                        "alpha": [8.0, 13.0],
                        "beta": [13.0, 30.0],
                    },
                    "alpha": {
                        "step_seconds": 0.25,
                        "iaf_search_hz": [7.5, 13.5],
                        "z": 1.5,
                        "margin": 0.05,
                        "analysis_window_seconds": 3.0,
                        "on_hold_seconds": 3.0,
                        "off_hold_seconds": 2.0,
                        "off_fraction": 0.45,
                        "ema_seconds": 5.0,
                        "quality_minimum": 0.5,
                    },
                },
            }
        )
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        validation_dir = root / "validation"
        validation_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.validation_report, validation_dir / "validation_report.json")
        write_checksums(root)
        subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-sign",
                "-rawin",
                "-inkey",
                str(args.signing_key),
                "-in",
                str(root / "SHA256SUMS.txt"),
                "-out",
                str(root / "SIGNATURE.ed25519"),
            ],
            check=True,
        )
        if (root / "SIGNATURE.ed25519").stat().st_size != 64:
            raise SystemExit("unexpected Ed25519 signature length")

        with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    archive.write(path, f"{root.name}/{path.relative_to(root).as_posix()}")

    print(
        json.dumps(
            {
                "output": str(args.output),
                "bytes": args.output.stat().st_size,
                "sha256": sha256(args.output),
                "package_id": PACKAGE_ID,
                "version": PACKAGE_VERSION,
                "release_approved": False,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
