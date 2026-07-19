#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import shutil
import stat
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage the macOS sleep runtime resource")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--arch", choices=("arm64", "x86_64"), required=True)
    args = parser.parse_args()

    if args.destination.exists():
        shutil.rmtree(args.destination)
    shutil.copytree(
        args.source,
        args.destination,
        ignore=shutil.ignore_patterns(".venv", "runtime", "__pycache__", "*.pyc", ".DS_Store"),
    )
    for script_name in ("setup_macos.sh", "start_service.sh"):
        script = args.destination / script_name
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    runtime_dir = args.destination / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    runtime = runtime_dir / "ifet-sleep-service"
    shutil.copy2(args.runtime, runtime)
    runtime.chmod(runtime.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    manifest_path = args.destination / "algorithm_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["target"] = f"macOS {args.arch} desktop App"
    manifest["bundled_runtime"] = {
        "path": "runtime/ifet-sleep-service",
        "platform": "macOS",
        "arch": args.arch,
        "format": f"PyInstaller {package_version('pyinstaller')} one-file macOS",
        "python_version": platform.python_version(),
        "numpy_version": package_version("numpy"),
        "scipy_version": package_version("scipy"),
        "onnxruntime_version": package_version("onnxruntime"),
        "bytes": runtime.stat().st_size,
        "sha256": sha256(runtime),
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    checksum_path = args.destination / "SHA256SUMS.txt"
    entries = []
    for path in sorted(args.destination.rglob("*")):
        if path.is_file() and path != checksum_path:
            relative = path.relative_to(args.destination).as_posix()
            entries.append(f"{sha256(path)}  {relative}")
    checksum_path.write_text("\n".join(entries) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "destination": str(args.destination),
                "arch": args.arch,
                "runtime_bytes": runtime.stat().st_size,
                "runtime_sha256": sha256(runtime),
                "checksum_entries": len(entries),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
