#!/usr/bin/env python3
"""Release validation for the static research reading workbench."""
from __future__ import annotations

import ast
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ERRORS: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        ERRORS.append(message)


def validate_python() -> None:
    for path in sorted((ROOT / "tools").glob("*.py")):
        try:
            ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        except (OSError, SyntaxError) as exc:
            ERRORS.append(f"Python check failed for {path.relative_to(ROOT)}: {exc}")


def validate_javascript() -> None:
    node = shutil.which("node")
    require(node is not None, "Node.js is required to validate JavaScript syntax")
    if not node:
        return
    for path in sorted((ROOT / "js").glob("*.js")):
        result = subprocess.run(
            [node, "--check", str(path)], capture_output=True, text=True
        )
        if result.returncode:
            ERRORS.append(
                f"JavaScript check failed for {path.relative_to(ROOT)}: "
                f"{result.stderr.strip()}"
            )


def validate_html_assets() -> None:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    refs = re.findall(r"(?:src|href)=[\"']([^\"']+)[\"']", html)
    for ref in refs:
        clean = ref.split("?", 1)[0]
        if not clean or clean.startswith(("data:", "http://", "https://", "#")):
            continue
        require((ROOT / clean).is_file(), f"Missing local resource referenced by index.html: {ref}")
    require("?v=15" in html, "Expected the v15 browser cache key in index.html")


def validate_vendor() -> None:
    required = [
        "vendor/pdfjs-6.2.108/pdf.mjs",
        "vendor/pdfjs-6.2.108/pdf.worker.mjs",
        "vendor/pdfjs-6.2.108/cmaps",
        "vendor/pdfjs-6.2.108/standard_fonts",
        "vendor/pdfjs-6.2.108/wasm",
        "vendor/marked-18.0.11/marked.umd.js",
        "vendor/dompurify-3.4.14/purify.min.js",
        "vendor/markdown-provenance.json",
    ]
    for relative in required:
        require((ROOT / relative).exists(), f"Missing vendored dependency: {relative}")


def validate_release_files() -> None:
    for relative in [
        "README.md",
        "CONTRIBUTING.md",
        "docs/USER_GUIDE.md",
        "docs/assets/logo.svg",
        "LICENSE",
        "SECURITY.md",
        "THIRD-PARTY-NOTICES.md",
        "CHANGELOG.md",
        ".gitignore",
        "启动工作台.bat",
        "start-workbench.bat",
        "start-workbench.command",
        "start.sh",
        "tools/package_release.py",
    ]:
        require((ROOT / relative).is_file(), f"Missing release file: {relative}")

    targets = [ROOT / "index.html", ROOT / "README.md", ROOT / "启动工作台.bat"]
    targets += sorted((ROOT / "js").glob("*.js"))
    targets += sorted((ROOT / "tools").glob("*.py"))
    personal = re.compile(r"(?:[A-Za-z]:[\\/]+Users[\\/]+17167|[A-Za-z]:[\\/]+Here[\\/]+Vibe Coding)", re.I)
    for path in targets:
        text = path.read_text(encoding="utf-8-sig")
        require(not personal.search(text), f"Personal absolute path found in {path.relative_to(ROOT)}")


def main() -> int:
    validate_python()
    validate_javascript()
    validate_html_assets()
    validate_vendor()
    validate_release_files()
    if ERRORS:
        print("Release validation failed:", file=sys.stderr)
        for error in ERRORS:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Release validation passed: Python, JavaScript, HTML assets, vendor files and packaging.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
