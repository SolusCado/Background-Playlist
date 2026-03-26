#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

VERSION_PATTERN = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")
DATE_TOKEN_PATTERN = re.compile(r"\d{4}\.\d{2}\.\d{2}")
RUNTIME_CONST_PATTERN = re.compile(
    r'(?m)^(\s*const\s+RUNTIME_LOG_VERSION\s*=\s*")(\d{4}\.\d{2}\.\d{2})("\s*;\s*)$'
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Bump integration version across manifest, hacs filename, and runtime log banner."
        )
    )
    parser.add_argument(
        "version",
        help="New version in YYYY.MM.DD format (example: 2026.03.26)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show planned changes without writing files.",
    )
    return parser.parse_args()


def validate_version(version: str) -> str:
    normalized = version.strip()
    if not VERSION_PATTERN.match(normalized):
        raise SystemExit("Version must be in YYYY.MM.DD format.")
    return normalized


def update_manifest(manifest_path: Path, new_version: str, dry_run: bool) -> tuple[str, str]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    old_version = str(manifest.get("version", "")).strip()
    manifest["version"] = new_version

    if not dry_run:
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    return old_version, new_version


def update_hacs_filename(hacs_path: Path, new_version: str, dry_run: bool) -> tuple[str, str]:
    with hacs_path.open("r", encoding="utf-8") as handle:
        hacs = json.load(handle)

    old_filename = str(hacs.get("filename", "")).strip()
    if old_filename:
        replaced = DATE_TOKEN_PATTERN.sub(new_version, old_filename, count=1)
        new_filename = replaced if replaced != old_filename else f"youtube_background_{new_version}.zip"
    else:
        new_filename = f"youtube_background_{new_version}.zip"

    hacs["filename"] = new_filename

    if not dry_run:
        hacs_path.write_text(json.dumps(hacs, indent=2) + "\n", encoding="utf-8")

    return old_filename, new_filename


def update_runtime_banner(runtime_path: Path, new_version: str, dry_run: bool) -> tuple[str, str]:
    source = runtime_path.read_text(encoding="utf-8")
    match = RUNTIME_CONST_PATTERN.search(source)
    if not match:
        raise SystemExit("Could not find RUNTIME_LOG_VERSION constant in runtime file.")

    old_version = match.group(2)
    updated_source = RUNTIME_CONST_PATTERN.sub(
        rf'\1{new_version}\3',
        source,
        count=1,
    )

    if not dry_run:
        runtime_path.write_text(updated_source, encoding="utf-8")

    return old_version, new_version


def main() -> None:
    args = parse_args()
    new_version = validate_version(args.version)

    repo_root = Path(__file__).resolve().parents[1]
    manifest_path = repo_root / "custom_components/youtube_background/manifest.json"
    hacs_path = repo_root / "hacs.json"
    runtime_path = repo_root / "custom_components/youtube_background/frontend/youtube-background-runtime.js"

    if not manifest_path.exists() or not hacs_path.exists() or not runtime_path.exists():
        raise SystemExit("Expected project files not found. Run this script from the repository.")

    manifest_old, manifest_new = update_manifest(manifest_path, new_version, args.dry_run)
    hacs_old, hacs_new = update_hacs_filename(hacs_path, new_version, args.dry_run)
    runtime_old, runtime_new = update_runtime_banner(runtime_path, new_version, args.dry_run)

    mode = "DRY-RUN" if args.dry_run else "UPDATED"
    print(f"[{mode}] manifest version: {manifest_old or '<empty>'} -> {manifest_new}")
    print(f"[{mode}] hacs filename: {hacs_old or '<empty>'} -> {hacs_new}")
    print(f"[{mode}] runtime banner: {runtime_old or '<empty>'} -> {runtime_new}")


if __name__ == "__main__":
    main()
