"""单目标浏览器采集：共享锁与风控、私密凭据输入、同出口收据审计；零业务回写。"""
import argparse
import datetime
import fcntl
import hashlib
import json
import math
import pathlib
import re
import stat
import subprocess
import time
import uuid

from runHttpSample import IMAGE, probe, writePrivate, safeFailure, publicSummary

POLICY = {'loginCooldown': True, 'apiHealthCheck': True, 'proxy541Limit': 3}
MAX_PRIVATE_BYTES = 8388608
MAX_LEASE_SECONDS = 86400 - 210
INPUT_CODES = frozenset(('ACCOUNT_ID_MISSING', 'ACCOUNT_REFERENCE_CONFLICT', 'ORDER_ACCOUNT_AMBIGUOUS',
    'ACCOUNT_MARKED_INVALID', 'ORDER_CREDENTIALS_MISSING', 'CREDENTIAL_DECRYPT_FAILED',
    'CREDENTIAL_SNAPSHOT_MISMATCH', 'INPUT_INVALID', 'LINK_IDENTITY_MISMATCH', 'DESTINATION_DENIED',
    'ORDER_NOT_FOUND', 'ORDER_INPUT_READ_FAILED'))
ERROR_CODES = INPUT_CODES | frozenset(('INPUT_IDENTITY_INVALID', 'PROXY_LEASE_EXPIRED',
    'PROXY_LEASE_INVALID', 'PROXY_LEASE_EGRESS_CHANGED', 'COLLECTOR_OUTPUT_MISSING',
    'COLLECTOR_IDENTITY_INVALID', 'COLLECTOR_EXIT_INVALID', 'RECEIPT_METADATA_INVALID',
    'BROWSER_PRIVATE_FILE_INVALID', 'REQUEST_STOPPED'))


def validInt(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def timestamp(value):
    for pattern in ('%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ'):
        try:
            return datetime.datetime.strptime(value, pattern).replace(tzinfo=datetime.timezone.utc).timestamp()
        except (ValueError, TypeError):
            pass
    raise RuntimeError('INPUT_INVALID')


def isoTime(value):
    return datetime.datetime.utcfromtimestamp(value).isoformat(timespec='milliseconds') + 'Z'


def readPrivate(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_PRIVATE_BYTES:
        raise RuntimeError('BROWSER_PRIVATE_FILE_INVALID')
    return json.loads(path.read_text(encoding='utf-8'))


def call(args, **kwargs):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def run(args, **kwargs):
    result = call(args, **kwargs)
    if result.returncode:
        raise RuntimeError('RUNTIME_COMMAND_FAILED')
    return result.stdout


def browserPreflight(root, orderId, attemptId):
    """当前无密码输入绑定的研究库只读查询；不足两次额度不探测代理。"""
    name = 'apple-browser-preflight-' + attemptId
    began = time.time()
    try:
        output = run(['docker', 'run', '--rm', '--name', name,
            '--network', 'apple-account-research-internal', '--user', '1000:1000', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64',
            '-e', 'NODE_PATH=/research/node_modules', '-v', str(root) + ':/research:ro',
            '-v', str(root / 'deps') + ':/research/node_modules:ro', '--entrypoint', 'node', IMAGE,
            '/research/release/scripts/officialPickupBackfill/preflightGate.js', '--browser', str(orderId)], timeout=30)
        if len(output) > 4096:
            raise ValueError()
        value = json.loads(output.decode('utf-8'))
        if (not isinstance(value, dict) or set(value) != {'version', 'mode', 'requiredAttempts', 'outcome',
                'orderId', 'checkedAt', 'planSha256', 'inputSha256', 'accountPaused', 'loginPaused', 'attempts'} or
                type(value['version']) is not int or value['version'] != 2 or value['mode'] != 'browser' or
                type(value['requiredAttempts']) is not int or value['requiredAttempts'] != 2 or
                type(value['orderId']) is not int or value['orderId'] != orderId or
                type(value['accountPaused']) is not bool or type(value['loginPaused']) is not bool or
                type(value['attempts']) is not int or value['attempts'] < 0 or
                type(value['checkedAt']) not in (int, float) or not math.isfinite(value['checkedAt']) or
                not began <= value['checkedAt'] <= time.time() or
                value['planSha256'] != hashlib.sha256((root / 'private/plan.json').read_bytes()).hexdigest() or
                value['inputSha256'] != hashlib.sha256((root / ('private/request-' + str(orderId) + '.json')).read_bytes()).hexdigest()):
            raise ValueError()
        expected = ('ACCOUNT_COOLDOWN' if value['accountPaused'] else 'LOGIN_COOLDOWN' if value['loginPaused'] else
                    'RECEIPT_ATTEMPT_LIMIT' if value['attempts'] >= 9 else 'BROWSER_PREFLIGHT_ALLOWED')
        if value['outcome'] != expected:
            raise ValueError()
        return value
    except Exception:
        try:
            call(['docker', 'rm', '-f', name], timeout=10)
        except Exception:
            pass
        raise RuntimeError('GATE_PREFLIGHT_FAILED') from None


def failureCode(error):
    code = str(error)
    if code in ERROR_CODES:
        return code
    code = safeFailure(error)
    return 'BROWSER_SAMPLE_FAILED' if code == 'HTTP_SAMPLE_FAILED' else code


def readRejected(root):
    path = root / 'private/http-rejected-egress.json'
    values = readPrivate(path) if path.exists() else []
    if not isinstance(values, list) or any(not isinstance(value, str) or
            not re.fullmatch(r'[a-f0-9]{64}', value) for value in values):
        raise RuntimeError('INPUT_INVALID')
    return set(values)


def rememberRejected(root, values):
    rejected = readRejected(root)
    rejected.update(value for value in values if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value))
    writePrivate(root / 'private/http-rejected-egress.json', sorted(rejected))


def beginLease(root, proxyHash):
    """持久保留可证观测起点；不声称这是供应商最早租约，也不在复用时延长。"""
    path = root / 'private/browser-proxy-leases.json'
    leases = readPrivate(path) if path.exists() else {}
    if not isinstance(leases, dict):
        raise RuntimeError('PROXY_LEASE_INVALID')
    lease = leases.get(proxyHash)
    now = time.time()
    if lease is None:
        began = now
        for auditPath in (root / 'private').glob('http-sample-*.json'):
            audit = readPrivate(auditPath)
            if audit.get('proxyHash') == proxyHash:
                value = audit.get('startedAt')
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value > now:
                    raise RuntimeError('PROXY_LEASE_INVALID')
                began = min(began, value)
        lease = {'startedAt': isoTime(began), 'egressHash': None,
                 'startBasis': 'earliest-local-observation'}
        leases[proxyHash] = lease
        writePrivate(path, leases)
    if (not isinstance(lease, dict) or not 0 <= now - timestamp(lease.get('startedAt')) <= MAX_LEASE_SECONDS or
            (lease.get('egressHash') is not None and
             not re.fullmatch(r'[a-f0-9]{64}', lease.get('egressHash', '')))):
        raise RuntimeError('PROXY_LEASE_EXPIRED')
    return leases, lease


def collectorSummary(value, orderId):
    """只接受冻结单目标结果，屏蔽完整订单、账号和任意子进程字段。"""
    if not isinstance(value, dict):
        raise RuntimeError('COLLECTOR_OUTPUT_MISSING')
    top = publicSummary(value)
    results = value.get('results')
    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        if top['outcome'] == 'SUCCEEDED':
            raise RuntimeError('COLLECTOR_IDENTITY_INVALID')
        return top
    result = results[0]
    if value.get('systemOrderId') != orderId or result.get('orderId') != orderId:
        raise RuntimeError('COLLECTOR_IDENTITY_INVALID')
    summary = publicSummary(result)
    if top['outcome'] != 'SUCCEEDED':
        summary['outcome'] = top['outcome']
    if summary['outcome'] == 'SUCCEEDED':
        runId = result.get('runId')
        if (not validInt(runId) or value.get('runId') != runId or result.get('attempted') is not True or
                result.get('resultFile') != '/research/private/results/order-' + str(orderId) + '-run-' + str(runId) + '.json'):
            raise RuntimeError('COLLECTOR_IDENTITY_INVALID')
    for key in ('passwordSubmitted', 'serverSessionRestored'):
        if type(value.get(key)) is bool:
            summary[key] = value[key]
    receipt = result.get('receipt')
    if isinstance(receipt, dict):
        cleaned = publicSummary(receipt)
        if validInt(receipt.get('detailRun')):
            cleaned['detailRun'] = receipt['detailRun']
        summary['receipt'] = cleaned
    return summary


def receiptMetadata(root, summary, entry, lease, startedAt, finishedAt, after, auditName, auditHash):
    receipt = summary.get('receipt')
    if not isinstance(receipt, dict) or receipt.get('outcome') != 'RECEIPT_CAPTURED':
        return None
    path = root / ('private/receipt-probe-' + str(entry['id']) + '.json')
    value = readPrivate(path)
    detail = readPrivate(root / ('private/results/order-' + str(entry['id']) + '-run-' + str(summary['runId']) + '.json'))
    source = detail.get('source', {})
    observed = timestamp(value.get('observedAt'))
    if (summary.get('outcome') != 'SUCCEEDED' or summary.get('egressVerifiedAfter') is not True or
            receipt.get('orderId') != entry['id'] or receipt.get('detailRun') != summary['runId'] or
            not validInt(receipt.get('runId')) or receipt['runId'] == summary['runId'] or
            value.get('systemOrderId') != entry['id'] or value.get('orderNumber') != entry['orderNumber'] or
            value.get('runId') != receipt['runId'] or value.get('detailRun') != summary['runId'] or
            value.get('transport') != 'same-browser' or value.get('egressVerifiedAfter') is not False or
            value.get('egressHash') != lease['egressHash'] or after != lease['egressHash'] or
            value.get('status') != 200 or not re.match(r'^text/html\b', value.get('contentType', '')) or
            value.get('file') != 'receipt-probe-' + str(receipt['runId']) + '.enc' or
            not re.fullmatch(r'[a-f0-9]{64}', value.get('sha256', '')) or
            not re.fullmatch(r'[a-f0-9]{64}', value.get('urlHash', '')) or
            detail.get('systemOrderId') != entry['id'] or detail.get('orderNumber') != entry['orderNumber'] or
            source.get('runId') != summary['runId'] or value.get('detailSha256') != source.get('sha256') or
            not startedAt <= timestamp(source.get('observedAt')) <= observed <= finishedAt or
            finishedAt - timestamp(lease['startedAt']) > 86400 - 30 or
            readPrivate(root / 'private/collectorConfig.json').get('leaseContext') != lease):
        raise RuntimeError('RECEIPT_METADATA_INVALID')
    return dict(value, egressVerifiedAfter=True, egressAfterHash=after, proxyHash=lease['proxyHash'],
                leaseStartedAt=lease['startedAt'], browserAuditFile=auditName, browserAuditSha256=auditHash,
                browserAttemptId=summary['attemptId'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--id', required=True, type=int)
    parser.add_argument('--proxy-index', required=True, type=int)
    parser.add_argument('--native-browser', action='store_true')
    args = parser.parse_args()
    root = pathlib.Path(args.root)
    startedAt = time.time()
    attemptId = uuid.uuid4().hex
    auditName = 'browser-sample-' + str(args.id) + '-' + attemptId + '.json'
    name = 'apple-official-browser-sample-' + attemptId
    summary = {'outcome': 'BROWSER_SAMPLE_FAILED'}
    lock = None
    before = after = None
    proxy = lease = entry = None
    proxyHash = None
    cleanupNeeded = False
    stage = 'input'
    cleanup = {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'}
    try:
        if not root.is_absolute() or args.id < 1:
            raise RuntimeError('INPUT_INVALID')
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        stage = 'lock'
        lock = open(str(root / 'private/http-sample.lock'), 'a', encoding='utf-8')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('HTTP_SAMPLE_BUSY')
        if (root / 'private/http-cleanup-blocked.json').exists():
            raise RuntimeError('HTTP_SAMPLE_CLEANUP_PENDING')
        stage = 'plan'
        plan = readPrivate(root / 'private/plan.json')
        entries = [value for value in plan.get('entries', []) if value.get('id') == args.id]
        if (plan.get('schemaVersion') != 3 or plan.get('scope') != 'missing-fields' or
                'cutoff' not in plan or plan.get('cutoff') is not None or plan.get('policy') != POLICY or len(entries) != 1 or
                not 0 <= startedAt - timestamp(plan.get('startedAt')) <= 86400):
            raise RuntimeError('BACKFILL_SCOPE_INVALID')
        entry = entries[0]
        if (not re.fullmatch(r'W[0-9]{10}', entry.get('orderNumber', '')) or
                not re.fullmatch(r'[a-f0-9]{32}', entry.get('accountKey', '')) or
                type(entry.get('dateMissing')) is not bool or type(entry.get('serialsMissing')) is not bool or
                not (entry['dateMissing'] or entry['serialsMissing'])):
            raise RuntimeError('BACKFILL_SCOPE_INVALID')
        stage = 'link-input-read'
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        linkData = run(['docker', 'exec', '-i', '-e', 'OFFICIAL_ORDER_IDS=' + str(args.id),
            'apple-order-mgr-prod-api-1', 'node', '-'],
            input=(root / 'release/scripts/readOfficialOrderLinkInput.js').read_bytes(), timeout=30)
        if len(linkData) > MAX_PRIVATE_BYTES:
            raise RuntimeError('INPUT_IDENTITY_INVALID')
        linkInput = json.loads(linkData.decode('utf-8'))
        linkValues = linkInput.get('samples')
        if (not isinstance(linkValues, list) or len(linkValues) != 1 or
                not isinstance(linkValues[0], dict) or type(linkValues[0].get('id')) is not int or
                linkValues[0]['id'] != args.id or linkValues[0].get('orderNumber') != entry['orderNumber'] or
                not re.fullmatch(r'[a-f0-9]{64}', linkValues[0].get('accountHash', ''))):
            raise RuntimeError('INPUT_IDENTITY_INVALID')
        writePrivate(root / ('private/request-' + str(args.id) + '.json'), linkInput)
        stage = 'preflight'
        decision = browserPreflight(root, args.id, attemptId)
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        if decision['outcome'] != 'BROWSER_PREFLIGHT_ALLOWED':
            summary = {'outcome': decision['outcome'], 'requests': 0, 'preflightOnly': True, 'preflight': decision}
            return summary
        stage = 'proxy'
        proxies = readPrivate(root / 'private/iproyal-cn.json')['entries']
        if not 0 <= args.proxy_index < len(proxies):
            raise RuntimeError('PROXY_INDEX_INVALID')
        proxy = dict(proxies[args.proxy_index], provider='iproyal', maxConnections=16, preemptiveAuth=True)
        proxyHash = hashlib.sha256(json.dumps([proxy['host'], int(proxy['port']), proxy['username'], proxy['password']],
                                             ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
        leases, previousLease = beginLease(root, proxyHash)
        stage = 'probe-before'
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        before = probe(proxy)
        if before in readRejected(root):
            raise RuntimeError('EGRESS_PREVIOUSLY_REJECTED')
        if previousLease['egressHash'] is not None and previousLease['egressHash'] != before:
            rememberRejected(root, [previousLease['egressHash'], before])
            raise RuntimeError('PROXY_LEASE_EGRESS_CHANGED')
        previousLease['egressHash'] = before
        writePrivate(root / 'private/browser-proxy-leases.json', leases)
        lease = {'provider': 'iproyal', 'startedAt': previousLease['startedAt'],
                 'proxyHash': proxyHash, 'egressHash': before}
        stage = 'input-read'
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        data = call(['docker', 'exec', '-i', '-e', 'OFFICIAL_ORDER_ID=' + str(args.id),
                     '-e', 'OFFICIAL_ACCOUNT_GROUP=', '-e', 'OFFICIAL_GROUP_LEASE=',
                     'apple-order-mgr-prod-api-1', 'node', '-'],
                    input=(root / 'release/scripts/readOfficialOrderInput.js').read_bytes(), timeout=30)
        if data.returncode:
            try:
                code = json.loads(data.stderr.decode('utf-8')).get('outcome')
            except (ValueError, UnicodeError, AttributeError):
                code = None
            raise RuntimeError(code if code in INPUT_CODES else 'ORDER_INPUT_READ_FAILED')
        inputs = json.loads(data.stdout.decode('utf-8'))
        values = inputs.get('samples')
        if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
            raise RuntimeError('INPUT_IDENTITY_INVALID')
        value = values[0]
        email = value.get('email', '').strip().lower()
        if (value.get('id') != args.id or value.get('orderNumber') != entry['orderNumber'] or
                not email or hashlib.md5(email.encode('utf-8')).hexdigest() != entry['accountKey'] or
                hashlib.sha256(email.encode('utf-8')).hexdigest() != value.get('accountHash') or
                value.get('accountHash') != linkValues[0]['accountHash'] or
                not isinstance(value.get('password'), str) or not value['password']):
            raise RuntimeError('INPUT_IDENTITY_INVALID')
        writePrivate(root / ('private/request-' + str(args.id) + '.json'), {'samples': values, 'failures': []})
        stage = 'configuration'
        writePrivate(root / 'private/browserProxy.json', proxy)
        writePrivate(root / 'private/collectorConfig.json', {
            'proxyFile': 'browserProxy.json', 'captureReceipt': True,
            'httpBootstrap': not args.native_browser, 'persistSessions': False,
            'httpPythonPath': '/runtime/venv/bin/python', 'leaseContext': lease,
            'maxRunRequests': 300, 'maxTotalRequests': 201470, 'browserMode': 'headed',
        })
        stage = 'container-create'
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        cleanupNeeded = True
        run(['docker', 'create', '--name', name, '--init', '--network', 'apple-account-research-internal',
             '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
             '--memory', '1024m', '--cpus', '1', '--pids-limit', '256', '--shm-size', '256m',
             '--tmpfs', '/tmp:rw,nosuid,size=268435456', '-e', 'HOME=/tmp', '-e', 'NODE_PATH=/research/node_modules',
             '-v', str(root) + ':/research:rw', '-v', str(root / 'deps') + ':/research/node_modules:ro',
             '-v', '/var/tmp/official-http-runtime-20261008:/runtime:ro', '--entrypoint', 'xvfb-run', IMAGE,
             '-a', '-s', '-screen 0 1365x900x24', 'node', '/research/release/scripts/collectOfficialOrder.js',
             '/research', str(args.id), 'backfill'], timeout=30)
        stage = 'container-network'
        run(['docker', 'network', 'connect', 'apple-account-research-egress', name], timeout=15)
        stage = 'collector'
        output = call(['docker', 'start', '-a', name], timeout=240)
        try:
            raw = json.loads(output.stdout.decode('utf-8').strip().splitlines()[-1])
        except (ValueError, UnicodeError, IndexError):
            raise RuntimeError('COLLECTOR_OUTPUT_MISSING')
        summary = collectorSummary(raw, args.id)
        state = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', name], timeout=15))
        if summary['outcome'] == 'SUCCEEDED' and (output.returncode or state.get('Running') is not False or
                state.get('ExitCode') != 0 or state.get('OOMKilled') is not False):
            summary['outcome'] = 'COLLECTOR_EXIT_INVALID'
        stage = 'complete'
    except Exception as error:
        summary.update(outcome=failureCode(error), failedStage=stage, errorType=type(error).__name__)
    finally:
        try:
            if cleanupNeeded:
                cleanup = {'attempted': True, 'removed': False, 'outcome': 'CONTAINER_CLEANUP_FAILED'}
                try:
                    removed = call(['docker', 'rm', '-f', name], timeout=30)
                    cleanup.update(removed=removed.returncode == 0,
                                   outcome='REMOVED' if removed.returncode == 0 else 'CONTAINER_CLEANUP_FAILED')
                except subprocess.TimeoutExpired:
                    cleanup['outcome'] = 'CONTAINER_CLEANUP_TIMEOUT'
                except Exception:
                    pass
                if not cleanup['removed']:
                    try:
                        writePrivate(root / 'private/http-cleanup-blocked.json', {
                            'attemptId': attemptId, 'targetOrderId': args.id, 'containerName': name,
                            'outcome': cleanup['outcome'],
                        })
                        cleanup['blockRecorded'] = True
                    except Exception:
                        cleanup['blockRecorded'] = False
                    if summary.get('outcome') == 'SUCCEEDED':
                        summary.update(originalOutcome=summary['outcome'], outcome=cleanup['outcome'])
                if before is not None:
                    try:
                        after = probe(proxy)
                    except Exception as error:
                        summary['egressAfterError'] = failureCode(error)
                    if after != before:
                        summary.update(originalOutcome=summary['outcome'], outcome='EGRESS_CHANGED_OR_UNVERIFIED')
                if (summary.get('outcome') == 'HTTP_541' or summary.get('originalOutcome') == 'HTTP_541' or
                        summary.get('receipt', {}).get('outcome') == 'HTTP_541' or after != before):
                    try:
                        rememberRejected(root, [before, after])
                    except Exception:
                        summary['outcome'] = 'REJECTION_WRITE_FAILED'
            finishedAt = time.time()
            summary.update(attemptId=attemptId, targetOrderId=args.id, proxyIndex=args.proxy_index,
                           bootstrapMode='native-browser' if args.native_browser else 'http-bootstrap',
                           persistSessions=False,
                           startedAt=startedAt, finishedAt=finishedAt, egressHash=before, egressAfterHash=after,
                           egressVerifiedAfter=before is not None and before == after, businessWrites=0,
                           cleanup=cleanup, proxyHash=proxyHash, auditFile=auditName)
            if cleanupNeeded:
                summary['containerName'] = name
            if lease is not None:
                summary['leaseContext'] = lease
            if validInt(summary.get('runId')):
                summary['detailRunId'] = summary['runId']
            receipt = summary.get('receipt')
            if isinstance(receipt, dict):
                summary['receiptOutcome'] = receipt.get('outcome')
                if validInt(receipt.get('runId')):
                    summary['receiptRunId'] = receipt['runId']
                if receipt.get('outcome') == 'RECEIPT_CAPTURED':
                    summary['receiptFile'] = '/research/private/receipt-probe-' + str(args.id) + '.json'
            try:
                if not root.is_absolute() or not (root / 'private').is_dir():
                    raise RuntimeError('INPUT_INVALID')
                metadata = None
                if summary.get('outcome') == 'SUCCEEDED' and cleanup['removed']:
                    metadata = receiptMetadata(root, summary, entry, lease, startedAt, finishedAt, after, auditName, None)
                summary['receiptEgressVerifiedAfter'] = metadata is not None
                writePrivate(root / 'private' / auditName, summary)
                if metadata:
                    metadata['browserAuditSha256'] = hashlib.sha256((root / 'private' / auditName).read_bytes()).hexdigest()
                    writePrivate(root / ('private/receipt-probe-' + str(args.id) + '.json'), metadata)
            except Exception as error:
                summary.update(originalOutcome=summary['outcome'], outcome=failureCode(error))
                if summary['outcome'] == 'BROWSER_SAMPLE_FAILED':
                    summary['outcome'] = 'AUDIT_WRITE_FAILED'
                try:
                    if root.is_absolute() and (root / 'private').is_dir():
                        writePrivate(root / 'private' / auditName, summary)
                except Exception:
                    pass
            print(json.dumps(summary, ensure_ascii=True))
        finally:
            if lock is not None:
                lock.close()
    return summary


if __name__ == '__main__':
    main()
