from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
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
    parser = argparse.ArgumentParser(description="Update bundled algorithm runtime metadata")
    parser.add_argument("--algorithm-dir", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--arch", required=True)
    args = parser.parse_args()

    algorithm_dir = args.algorithm_dir.resolve()
    runtime = args.runtime.resolve()
    manifest_path = algorithm_dir / "algorithm_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["target"] = args.target
    manifest["bundled_runtime"] = {
        "path": runtime.relative_to(algorithm_dir).as_posix(),
        "platform": args.platform,
        "arch": args.arch,
        "format": f"PyInstaller {package_version('pyinstaller')} one-file {args.platform}",
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

    checksum_path = algorithm_dir / "SHA256SUMS.txt"
    entries = []
    for path in sorted(algorithm_dir.rglob("*")):
        if path.is_file() and path != checksum_path and "__pycache__" not in path.parts:
            entries.append(f"{sha256(path)}  {path.relative_to(algorithm_dir).as_posix()}")
    checksum_path.write_text("\n".join(entries) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "runtime": str(runtime),
                "bytes": runtime.stat().st_size,
                "sha256": sha256(runtime),
                "checksum_entries": len(entries),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
