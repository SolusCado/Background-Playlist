#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def should_skip(path: Path) -> bool:
    if any(part in {"__pycache__", ".git", ".DS_Store"} for part in path.parts):
        return True
    if path.suffix in {".pyc", ".pyo", ".pyd"}:
        return True
    return False


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    hacs_path = repo_root / "hacs.json"

    with hacs_path.open("r", encoding="utf-8") as handle:
        hacs = json.load(handle)

    zip_name = str(hacs.get("filename", "")).strip()
    persistent_dir = str(hacs.get("persistent_directory", "")).strip()

    if not zip_name:
        raise SystemExit("hacs.json is missing 'filename'.")
    if not persistent_dir:
        raise SystemExit("hacs.json is missing 'persistent_directory'.")

    source_root = repo_root / persistent_dir
    if not source_root.exists() or not source_root.is_dir():
        raise SystemExit(f"Persistent directory not found: {source_root}")

    output_zip = repo_root / zip_name
    if output_zip.exists():
        output_zip.unlink()

    file_count = 0
    with ZipFile(output_zip, "w", compression=ZIP_DEFLATED) as archive:
        for file_path in sorted(source_root.rglob("*")):
            if not file_path.is_file() or should_skip(file_path):
                continue

            arcname = file_path.relative_to(source_root).as_posix()
            archive.write(file_path, arcname)
            file_count += 1

    print(f"Created: {output_zip.name}")
    print(f"Files:   {file_count}")


if __name__ == "__main__":
    main()
