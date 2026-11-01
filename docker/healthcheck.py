#!/usr/bin/env python3
"""Probe the protected health API without putting its token in argv or output."""
import os
import sys
import urllib.request
sys.path.insert(0, '/opt/openflow/scripts')
from setup import parse_env
from pathlib import Path
try:
    values = parse_env(Path('/data/openflow.env').read_text())
    token = values.get('DEVFLOW_API_TOKEN', '')
    request = urllib.request.Request('http://127.0.0.1:' + os.environ.get('PORT', '3000') + '/api/health', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=8) as response:
        sys.exit(0 if response.status == 200 else 1)
except Exception:
    sys.exit(1)
