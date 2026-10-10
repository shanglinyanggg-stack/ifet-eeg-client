#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest(root: Path) -> dict:
    value = json.loads((root / "algorithm_manifest.json").read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("algorithm manifest must be an object")
    for key in ("package_id", "version"):
        text = str(value.get(key, ""))
        if not text or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_+" for character in text):
            raise ValueError(f"unsafe {key}")
    return value


def verify(root: Path, public_key: Path) -> None:
    subprocess.run(
        [
            "openssl",
            "pkeyutl",
            "-verify",
            "-pubin",
            "-inkey",
            str(public_key),
            "-rawin",
            "-in",
            str(root / "SHA256SUMS.txt"),
            "-sigfile",
            str(root / "SIGNATURE.ed25519"),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    lines = (root / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError("empty SHA256SUMS.txt")
    for line in lines:
        expected, relative = line.split("  ", 1)
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("unsafe checksum path")
        if sha256(root / path) != expected.lower():
            raise ValueError(f"checksum mismatch: {relative}")


def install_directory(source: Path, destination: Path, store: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = store / f"stage-{uuid.uuid4()}"
    shutil.copytree(source, staging)
    if destination.exists():
        existing = (destination / "SHA256SUMS.txt").read_bytes() if (destination / "SHA256SUMS.txt").exists() else b""
        incoming = (staging / "SHA256SUMS.txt").read_bytes() if (staging / "SHA256SUMS.txt").exists() else b""
        if existing == incoming:
            shutil.rmtree(staging)
            return
        raise ValueError("same package version already exists with different content")
    os.replace(staging, destination)


def main() -> None:
    parser = argparse.ArgumentParser(description="Install a verified iFET algorithm package on macOS")
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--stable-source", type=Path, required=True)
    parser.add_argument(
        "--public-key",
        type=Path,
        default=Path.home() / "Library/Application Support/iFET Algorithm Signing/algorithm_update_ed25519_public.pem",
    )
    parser.add_argument(
        "--store",
        type=Path,
        default=Path.home() / "Library/Application Support/com.ifet.eeg-client.algorithm-lab-v0229/algorithms",
    )
    args = parser.parse_args()
    args.store.mkdir(parents=True, exist_ok=True)

    stable = manifest(args.stable_source)
    stable_destination = args.store / "packages" / stable["package_id"] / stable["version"]
    install_directory(args.stable_source, stable_destination, args.store)

    with tempfile.TemporaryDirectory(prefix="ifet-install-") as temporary:
        temporary_path = Path(temporary).resolve()
        with zipfile.ZipFile(args.package) as archive:
            for item in archive.infolist():
                target = (temporary_path / item.filename).resolve()
                if temporary_path not in target.parents and target != temporary_path:
                    raise ValueError("archive path traversal")
            archive.extractall(temporary_path)
        roots = list(temporary_path.glob("*/algorithm_manifest.json"))
        if len(roots) != 1:
            raise ValueError("archive must contain exactly one package root")
        package_root = roots[0].parent
        verify(package_root, args.public_key)
        runtime = package_root / "runtime/ifet-sleep-service"
        if not runtime.is_file():
            raise ValueError("macOS algorithm runtime is missing")
        runtime.chmod(runtime.stat().st_mode | 0o755)
        experimental = manifest(package_root)
        if experimental.get("release_approved") is not False:
            raise ValueError("this installer expects the explicit experimental package")
        destination = args.store / "packages" / experimental["package_id"] / experimental["version"]
        install_directory(package_root, destination, args.store)

    selection = {
        "active_package_id": experimental["package_id"],
        "active_version": experimental["version"],
        "last_known_good_package_id": stable["package_id"],
        "last_known_good_version": stable["version"],
    }
    temporary_selection = args.store / "current.json.tmp"
    temporary_selection.write_text(json.dumps(selection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary_selection, args.store / "current.json")
    print(
        json.dumps(
            {
                "store": str(args.store),
                "active": f"{experimental['package_id']}@{experimental['version']}",
                "fallback": f"{stable['package_id']}@{stable['version']}",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
