"""补录运行时：受限文件、并发安全日志和固定范围校验。"""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

DEFAULT_ROOT = '/var/www/apple-order-mgr/shared/official-pickup-backfill-20261007'
IMAGE = 'apple-order-mgr-runtime:20261007-actual-pickup-amd64'
MAX_WORKERS = 3
CONNECTIONS_PER_WORKER = 16
MAX_BATCH_CHANNELS = 6
OTHER_PROXY_CHANNELS = 1
PROXY_CHANNEL_CAPACITY = 10
PROXY_LEASE_SECONDS = 600
MAX_AGE_SECONDS = 86400
RETRYABLE = frozenset(('PROXY_CONNECTION_FAILED', 'HTTP_541', 'NO_VALID_ORDER_DATA',
                      'TIME_BUDGET', 'SITE_READINESS_TIMEOUT', 'HTTP_502', 'HTTP_503', 'HTTP_504',
                      'EGRESS_PROBE_FAILED', 'EGRESS_CHANGED_DURING_GROUP', 'PROXY_CAPACITY_WAIT_TIMEOUT'))
FATAL = frozenset(('REQUEST_BUDGET', 'STATE_WRITE_FAILED', 'BACKFILL_INVARIANCE_FAILED',
                   'READBACK_MISMATCH', 'STOCK_INVARIANCE_FAILED', 'BIND_FAILED',
                   'SOURCE_VERIFY_FAILED', 'NO_FRESH_EGRESS', 'BACKFILL_SCOPE_INVALID',
                   'PROXY_CAPACITY_WAIT_TIMEOUT'))


def call(args, **kwargs):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def readJson(path):
    with open(str(path)) as source:
        return json.load(source)


def writeJson(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with open(str(temporary), 'x') as output:
            os.chmod(str(temporary), 0o600)
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        if os.geteuid() == 0:
            os.chown(str(temporary), 1000, 1000)
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


@contextmanager
def fileLock(path, blocking=True):
    with open(str(path), 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def append(path, value):
    with open(str(path), 'a') as output:
        fcntl.flock(output, fcntl.LOCK_EX)
        try:
            output.write(json.dumps(value) + '\n')
            output.flush()
            os.fsync(output.fileno())
        finally:
            fcntl.flock(output, fcntl.LOCK_UN)


def records(path):
    if not pathlib.Path(path).exists():
        return []
    with open(str(path)) as source:
        fcntl.flock(source, fcntl.LOCK_SH)
        return [json.loads(line) for line in source if line.strip()]


def event(root, eventName, **fields):
    append(root / 'evidence/backfill.jsonl', dict(fields, event=eventName,
           time=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))


def timestamp(value):
    return datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc).timestamp()


def validatePlan(plan, original=None):
    full = threeFieldScope(plan)
    if ((not full and (plan.get('scope') or plan.get('cutoff') != '2026-09-23')) or not plan.get('entries') or
            not 0 <= time.time() - timestamp(plan['startedAt']) <= MAX_AGE_SECONDS):
        raise RuntimeError('BACKFILL_SCOPE_INVALID')
    ids = [item['id'] for item in plan['entries']]
    if len(ids) != len(set(ids)):
        raise RuntimeError('BACKFILL_SCOPE_INVALID')
    if missingScope(plan) and any(
            not isinstance(e.get('dateMissing'), bool) or not isinstance(e.get('serialsMissing'), bool) or
            not (e['dateMissing'] or e['serialsMissing']) or not isinstance(e.get('previousDevices'), list)
            for e in plan['entries']):
        raise RuntimeError('BACKFILL_SCOPE_INVALID')
    if original is not None:
        if (plan['startedAt'] != original['startedAt'] or plan['cutoff'] != original['cutoff'] or
                plan.get('scope') != original.get('scope') or plan.get('policy') != original.get('policy') or
                plan.get('schemaVersion') != original.get('schemaVersion') or
                [{k: e[k] for k in ('id', 'orderNumber', 'rowHash', 'accountKey')} for e in plan['entries']] !=
                [{k: e[k] for k in ('id', 'orderNumber', 'rowHash', 'accountKey')} for e in original['entries']]):
            raise RuntimeError('BACKFILL_SCOPE_INVALID')
        if missingScope(plan) and [
                {k: v for k, v in e.items() if k != 'stableRowHash'} for e in plan['entries']] != original['entries']:
            raise RuntimeError('BACKFILL_SCOPE_INVALID')


def fullScope(plan):
    return (plan.get('scope') == 'all-picked-up' and plan.get('schemaVersion') == 2 and
            plan.get('cutoff') is None and plan.get('policy') == {
                'loginCooldown': False, 'apiHealthCheck': False, 'proxy541Limit': 3})


def missingScope(plan):
    return (plan.get('scope') == 'missing-fields' and plan.get('schemaVersion') == 3 and
            plan.get('cutoff') is None and plan.get('policy') == {
                'loginCooldown': True, 'apiHealthCheck': True, 'proxy541Limit': 3})


def threeFieldScope(plan):
    return fullScope(plan) or missingScope(plan)


def safeCode(error):
    value = str(error)
    return value if re.fullmatch('[A-Z_0-9]+', value) else 'EXECUTOR_ERROR'


def rejectionSet(root, add=None):
    path = root / 'private/rejected-egress.json'
    with fileLock(root / 'private/rejected-egress.lock'):
        values = set(readJson(path)) if path.exists() else set()
        if add:
            values.update(add)
            writeJson(path, sorted(values))
        return values


def reserveChannel(root, proxyHash, startedAt):
    """持久登记十分钟粘性通道；失败也不提前释放或延长原租期。"""
    target = root / 'private/tunnel-leases.json'
    with fileLock(root / 'private/tunnel-leases.lock'):
        leases = readJson(target) if target.exists() else {}
        if proxyHash in leases:
            return {'startedAt': leases[proxyHash], 'waitUntil': None}
        active = [value for value in leases.values() if value + PROXY_LEASE_SECONDS > time.time()]
        if len(active) >= MAX_BATCH_CHANNELS:
            return {'startedAt': None, 'waitUntil': min(active) + PROXY_LEASE_SECONDS}
        leases[proxyHash] = startedAt
        writeJson(target, leases)
        return {'startedAt': startedAt, 'waitUntil': None}


def chooseGroups(plan, processed, applied, receipts):
    latest = {item['orderId']: item for item in processed}
    filled = {item['orderId'] for item in applied if (item.get('dateVerified') and item.get('statusSaved'))
              if threeFieldScope(plan)} if threeFieldScope(plan) else {
                  item['orderId'] for item in applied if item['outcome'] in ('FILLED', 'ALREADY_HAS_DATE')}
    receiptLatest = {item['orderId']: item for item in receipts}
    groups = {}
    for entry in plan['entries']:
        orderId = entry['id']
        previous = latest.get(orderId, {}).get('outcome')
        if orderId in filled:
            # 修复后的会话路径只补先前未成功的收据；实际次数由研究库预检。
            receipt = receiptLatest.get(orderId, {}).get('outcome')
            if receipt not in (None, 'RECEIPT_SESSION_REDIRECT', 'DETAIL_IDENTITY_INVALID',
                               'RECEIPT_CAPTURE_FAILED', 'RECEIPT_TIMEOUT', 'ECONNABORTED',
                               'EGRESS_CHANGED_BEFORE_RECEIPT', 'EGRESS_CHANGED_AFTER_RECEIPT', 'EGRESS_PROBE_FAILED'):
                continue
        elif previous and previous not in RETRYABLE:
            continue
        groups.setdefault(entry['accountKey'], []).append(dict(entry, receiptOnly=orderId in filled))
    return list(groups.values())


def shaFile(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
