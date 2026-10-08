#!/usr/bin/env python3
"""本次补录结束后的只读对账；不是周期任务，不重试 Apple 或写业务数据。"""
import json
import os
import pathlib
import subprocess
import time
import re

os.umask(0o077)
root = pathlib.Path(os.environ.get('OFFICIAL_BACKFILL_ROOT', '/var/www/apple-order-mgr/shared/official-pickup-backfill-20261007'))
service = os.environ.get('OFFICIAL_BACKFILL_SERVICE', 'apple-pickup-backfill-20261007.service')
if not re.fullmatch(r'apple-(?:pickup-backfill|picked-up-sync|missing-fields)-\d{8}\.service', service):
    raise RuntimeError('SERVICE_INVALID')
while True:
    state = subprocess.run(['systemctl', 'is-active', service], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=10).stdout.decode().strip()
    if state not in ('active', 'activating', 'deactivating', 'reloading', 'inactive', 'failed', 'unknown'):
        raise RuntimeError('SERVICE_STATE_UNAVAILABLE')
    if state not in ('active', 'activating', 'deactivating', 'reloading'):
        break
    time.sleep(50)

for attempt in range(3):
    result = subprocess.run(['/usr/bin/python3', str(pathlib.Path(__file__).with_name('checkBackfill.py'))],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
    if result.returncode == 0:
        report = json.loads(result.stdout)
        report['serviceStateAtEnd'] = state
        report['dateComplete'] = report['remainingNull'] == 0
        report['complete'] = report['dateComplete'] and report['receiptConfirmedOrders'] == report['total'] and not report['issues']
        if report.get('scope') in ('all-picked-up', 'missing-fields'):
            report['complete'] = report['allFieldsVerified'] == report['total'] and not report['issues']
        report['executionFinished'] = True
        report['lastEvent'] = json.loads((root / 'evidence/backfill.jsonl').read_text(encoding='utf-8').splitlines()[-1])
        output = root / 'evidence/final-reconciliation.json'
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False), flush=True)
        break
    if attempt == 2:
        (root / 'evidence/final-reconciliation-error.json').write_text(
            json.dumps({'code': 'READBACK_FAILED', 'attempts': 3}) + '\n')
        raise SystemExit(1)
    time.sleep(10)
