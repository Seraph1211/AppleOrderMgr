"""HTTP 操作共用的纯文件停机边界；不连接数据库、不修改意图或业务状态。"""
import hashlib
import json
import math
import os
import pathlib
import re
import stat

MAX_PRIVATE_BYTES = 16777216
MAX_PLAN_BYTES = 67108864
HTTP_FIELDS = frozenset(('state', 'sourceAudit', 'attemptId', 'orderId', 'runId',
                         'payloadFile', 'previewFile', 'resultFile', 'auditFile'))
BROWSER_FIELDS = frozenset(('state', 'sourceAudit', 'attemptId', 'orderId', 'receiptRunId',
                            'receiptSha256', 'payloadFile', 'resultFile', 'auditFile', 'payloadSha256'))


def strictJson(raw):
    """拒绝任意层级重复键和非有限数，不用最后一个同名 state 覆盖前者。"""
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    def constant(_value):
        raise ValueError()
    def decimal(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError()
        return result
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant, parse_float=decimal)


def privateBytes(path, maximum=MAX_PRIVATE_BYTES):
    """一次打开私密普通文件；不跟随链接，不容忍截断或读取期间变化。"""
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o077 or before.st_size > maximum:
            raise ValueError()
        raw = handle.read(maximum + 1)
        after = os.fstat(handle.fileno())
        if len(raw) > maximum or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError()
        return raw


def positiveInt(value):
    return type(value) is int and value > 0


def validHash(value, length=64):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{' + str(length) + '}', value) is not None


def validateIntent(path, value, own=False):
    """只接受既有完整意图身份；终态不改变，旧 browser 可没有可选 startedAt。"""
    match = re.fullmatch(r'(http-apply-intent-|browser-receipt-bind-intent-)([1-9][0-9]*)\.json', path.name)
    if (not match or not isinstance(value, dict) or not positiveInt(value.get('orderId')) or
            value['orderId'] != int(match.group(2)) or not validHash(value.get('attemptId'), 32)):
        raise ValueError()
    order = str(value['orderId'])
    attempt = value['attemptId']
    http = match.group(1) == 'http-apply-intent-'
    fields = HTTP_FIELDS if http else BROWSER_FIELDS
    optional = {'outcome'} if http else {'startedAt'}
    if not fields.issubset(value) or not set(value).issubset(fields | optional):
        raise ValueError()
    accepted = ('APPLY_STARTED',) if own else ('APPLIED', 'ROLLED_BACK') if http else ('APPLIED',)
    if value['state'] not in accepted or (own and not http):
        raise ValueError()
    source = 'http-sample-' if http else 'browser-sample-'
    if (not isinstance(value['sourceAudit'], str) or
            not re.fullmatch(source + order + r'-[a-f0-9]{32}\.json', value['sourceAudit'])):
        raise ValueError()
    prefix = ('http-apply-' if http else 'browser-receipt-bind-') + order + '-' + attempt
    for field, suffix in (('payloadFile', '-payload.json'), ('resultFile', '-result.json'), ('auditFile', '-audit.json')):
        if value[field] != prefix + suffix:
            raise ValueError()
    if http:
        if not positiveInt(value['runId']) or value['previewFile'] != prefix + '-preview.json':
            raise ValueError()
        if 'outcome' in value and (not isinstance(value['outcome'], str) or
                not re.fullmatch(r'HTTP_APPLY_[A-Z_]{1,80}', value['outcome'])):
            raise ValueError()
        if value['state'] == 'ROLLED_BACK' and 'outcome' not in value:
            raise ValueError()
    else:
        if (not positiveInt(value['receiptRunId']) or not validHash(value['receiptSha256']) or
                not validHash(value['payloadSha256'])):
            raise ValueError()
        if ('startedAt' in value and (type(value['startedAt']) not in (int, float) or
                not math.isfinite(value['startedAt']) or value['startedAt'] <= 0)):
            raise ValueError()


def checkWriteBoundary(root, planSha256, ownIntent=None):
    """检查全局意图与原计划；仅本调用精确路径及原字节的已持久化意图可豁免。"""
    private = pathlib.Path(root) / 'private'
    ownFound = ownIntent is None
    try:
        if ownIntent is not None:
            if (not isinstance(ownIntent, tuple) or len(ownIntent) != 2 or
                    not isinstance(ownIntent[0], pathlib.Path) or ownIntent[0].parent != private or
                    not isinstance(ownIntent[1], bytes)):
                raise ValueError()
        for prefix in ('http-apply-intent-', 'browser-receipt-bind-intent-'):
            for path in private.glob(prefix + '*.json'):
                raw = privateBytes(path)
                own = ownIntent is not None and path == ownIntent[0]
                if own:
                    if raw != ownIntent[1]:
                        raise ValueError()
                    ownFound = True
                validateIntent(path, strictJson(raw), own)
        if not ownFound:
            raise ValueError()
    except Exception:
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED') from None
    if os.path.lexists(str(private / 'STOP')):
        raise RuntimeError('WRITE_BOUNDARY_STOP_REQUESTED')
    if os.path.lexists(str(private / 'http-cleanup-blocked.json')):
        raise RuntimeError('WRITE_BOUNDARY_CLEANUP_PENDING')
    try:
        if not validHash(planSha256) or hashlib.sha256(privateBytes(private / 'plan.json', MAX_PLAN_BYTES)).hexdigest() != planSha256:
            raise ValueError()
    except Exception:
        raise RuntimeError('WRITE_BOUNDARY_PLAN_CHANGED') from None
