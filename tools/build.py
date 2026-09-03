# -*- coding: utf-8 -*-
"""Validate the vendored PDF.js module bundle; no inline worker build is needed."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'vendor' / 'pdfjs-6.2.108'
metadata = json.loads((ASSETS / 'package.json').read_text(encoding='utf-8'))
assert metadata['version'] == '6.2.108', 'PDF.js package version mismatch'
for name in ('pdf.mjs', 'pdf.worker.mjs', 'LICENSE', 'cmaps', 'standard_fonts', 'wasm'):
    assert (ASSETS / name).exists(), 'Missing PDF.js asset: ' + name
print('PDF.js 6.2.108 module, worker, CMaps, fonts and WASM validated.')
