#!/usr/bin/env python3
"""Regenerate the deterministic SHA256 manifest for the bundled algorithm."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


def include(path: Path, root: Path, output: Path) -> bool:
    relative = path.relative_to(root)
    return (
        path.is_file()
        and path != output
        and "__pycache__" not in relative.parts
        and path.name != ".DS_Store"
        and path.suffix != ".pyc"
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("resource_root", type=Path)
    args = parser.parse_args()

    root = args.resource_root.resolve()
    output = root / "SHA256SUMS.txt"
    files = sorted(
        (path for path in root.rglob("*") if include(path, root, output)),
        key=lambda path: path.relative_to(root).as_posix(),
    )
    body = "".join(
        f"{sha256(path)}  {path.relative_to(root).as_posix()}\n" for path in files
    )
    temporary = output.with_suffix(".txt.tmp")
    temporary.write_text(body, encoding="utf-8")
    temporary.replace(output)
    print(f"updated {output} ({len(files)} files)")


if __name__ == "__main__":
    main()
