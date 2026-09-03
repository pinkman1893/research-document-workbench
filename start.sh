#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
if command -v python3 >/dev/null 2>&1; then exec python3 tools/serve.py; fi
if command -v python >/dev/null 2>&1; then exec python tools/serve.py; fi
printf '%s\n' 'Python 3 was not found. Install it from https://www.python.org/downloads/' >&2
exit 1
