#!/usr/bin/env python3
"""Build a deterministic, user-facing portable ZIP without local data."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXED_FILES = [
    ".nojekyll",
    "index.html",
    "README.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "启动工作台.bat",
    "start-workbench.bat",
    "start-workbench.command",
    "start.sh",
    "tools/serve.py",
    "tools/check.py",
    "tools/build.py",
    "tools/package_release.py",
]
DIRECTORIES = ["css", "js", "vendor", "docs"]
EPOCH = (2026, 9, 3, 0, 0, 0)


def release_files() -> list[Path]:
    paths = [ROOT / name for name in FIXED_FILES]
    for name in DIRECTORIES:
        paths.extend(path for path in (ROOT / name).rglob("*") if path.is_file())
    missing = [path for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing release file: " + str(missing[0]))
    return sorted(set(paths), key=lambda path: path.relative_to(ROOT).as_posix())


def add_bytes(archive: zipfile.ZipFile, name: str, data: bytes, executable: bool = False) -> None:
    info = zipfile.ZipInfo(name, EPOCH)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = ((0o755 if executable else 0o644) & 0xFFFF) << 16
    archive.writestr(info, data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Semantic version without the v prefix")
    parser.add_argument("--output", type=Path, help="Output ZIP path")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", args.version):
        parser.error("--version must be a semantic version such as 1.1.0")

    output = (args.output or ROOT / "dist" / f"research-document-workbench-v{args.version}.zip").resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    prefix = f"research-document-workbench-v{args.version}"
    manifest: dict[str, str] = {}
    files = release_files()

    with zipfile.ZipFile(output, "w") as archive:
        for path in files:
            relative = path.relative_to(ROOT).as_posix()
            data = path.read_bytes()
            manifest[relative] = hashlib.sha256(data).hexdigest()
            add_bytes(
                archive,
                f"{prefix}/{relative}",
                data,
                relative in {"start.sh", "start-workbench.command"},
            )
        manifest_data = json.dumps(
            {"version": args.version, "sha256": manifest},
            ensure_ascii=False,
            indent=2,
        ).encode("utf-8")
        add_bytes(archive, f"{prefix}/release-manifest.json", manifest_data)

    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("ZIP integrity verification failed")
        names = set(archive.namelist())
        for required in ["index.html", "tools/serve.py", "vendor/pdfjs-6.2.108/pdf.worker.mjs"]:
            if f"{prefix}/{required}" not in names:
                raise RuntimeError("Required file missing from ZIP: " + required)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f"Created {output}")
    print(f"Files: {len(files) + 1}; bytes: {output.stat().st_size}; sha256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
