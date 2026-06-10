#!/usr/bin/env python3
import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGE = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
NAME = PACKAGE['name']
VERSION = PACKAGE['version']
OUT = ROOT / f'{NAME}-{VERSION}.vsix'

FILES = [
    'package.json',
    'dist/extension.js',
    'resources/monitor.svg',
]

manifest = {
    'version': '1.0.0',
    'manifestVersion': 1,
    'metadata': {
        'id': NAME,
        'publisher': PACKAGE.get('publisher', 'local'),
        'publisherDisplayName': PACKAGE.get('publisher', 'local'),
        'targetPlatform': 'undefined',
        'isApplicationScoped': False,
        'updated': False,
        'isPreReleaseVersion': False,
        'installedTimestamp': 0,
        'preRelease': False,
    },
    'assets': [
        {
            'type': 'Microsoft.VisualStudio.Code.Manifest',
            'path': 'extension/package.json',
            'addressable': True,
        },
        {
            'type': 'Microsoft.VisualStudio.Services.Content.Details',
            'path': 'extension/package.json',
            'addressable': True,
        },
    ],
}

content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
'''

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('[Content_Types].xml', content_types)
    zf.writestr('extension.vsixmanifest', json.dumps(manifest, ensure_ascii=False, indent=2))
    for relative in FILES:
        source = ROOT / relative
        if not source.exists():
            raise FileNotFoundError(source)
        zf.write(source, 'extension/' + relative)

print(OUT)
