"""单笔服务器实测：健康与实际出口核验、受限容器、无业务写入。"""
import argparse
import contextlib
import stat
import fcntl
import hashlib
import ipaddress
import json
import math
import os
import pathlib
import re
import subprocess
import time
import uuid
from urllib.parse import quote

IMAGE = 'mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'


def writePrivate(path, value):
    """以 0600 独占临时文件原子替换私密配置或审计。"""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex + '.tmp')
    descriptor = None
    try:
        descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            descriptor = None
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(str(temporary), 1000, 1000)
        os.replace(str(temporary), str(path))
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def preserveQuarantineInput(root, orderId):
    """刷新输入前保留旧关闭事件绑定的精确字节；摘要不符时拒绝覆盖。"""
    private = root / 'private'
    original = private / ('request-' + str(orderId) + '.json')
    def read(path):
        with os.fdopen(os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 8388608:
                raise ValueError()
            return handle.read()
    try:
        for journal in ('http-batch-apply.jsonl', 'http-batch-dry-run.jsonl'):
            path = private / journal
            if not os.path.lexists(str(path)):
                continue
            raw = read(path)
            if raw and not raw.endswith(b'\n'):
                raise ValueError()
            for line in raw.splitlines():
                event = json.loads(line.decode('utf-8'))
                if event.get('event') != 'failed_read_only_quarantined' or event.get('orderId') != orderId:
                    continue
                attempt = event.get('sampleAttemptId')
                digest = event.get('verification', {}).get('files', {}).get('private/' + original.name)
                if (not isinstance(attempt, str) or not re.fullmatch(r'[a-f0-9]{32}', attempt) or
                        not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest)):
                    raise ValueError()
                saved = private / ('http-quarantine-input-' + str(orderId) + '-' + attempt + '.json')
                if os.path.lexists(str(saved)):
                    if hashlib.sha256(read(saved)).hexdigest() != digest:
                        raise ValueError()
                    continue
                value = read(original)
                if hashlib.sha256(value).hexdigest() != digest:
                    raise ValueError()
                with os.fdopen(os.open(str(saved), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as handle:
                    handle.write(value)
                    handle.flush()
                    if os.geteuid() == 0:
                        os.fchown(handle.fileno(), 1000, 1000)
                    os.fsync(handle.fileno())
                descriptor = os.open(str(private), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
    except Exception:
        raise RuntimeError('QUARANTINE_INPUT_PRESERVATION_FAILED') from None


def run(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError('RUNTIME_COMMAND_FAILED')
    return result.stdout


def probe(proxy):
    token = 'http-rebuild-' + uuid.uuid4().hex
    auth = quote(proxy['username'], safe='') + ':' + quote(proxy['password'], safe='')
    proxyUrl = 'http://' + auth + '@' + proxy['host'] + ':' + str(proxy['port'])
    config = 'proxy = "' + proxyUrl + '"\nurl = "https://apple.godp.me/api/health/ready?' + token + '"\n'
    output = run(['curl', '-fsS', '--noproxy', '', '--max-time', '20', '--config', '-'],
                 input=config.encode(), timeout=25)
    if json.loads(output).get('success') is not True:
        raise RuntimeError('API_HEALTH_FAILED')
    with open('/var/log/nginx/apple-order-mgr-access.log', 'rb') as source:
        source.seek(0, 2)
        source.seek(max(0, source.tell() - 262144))
        lines = [line for line in source.read().decode(errors='replace').splitlines() if token in line]
    if len(lines) != 1:
        raise RuntimeError('EGRESS_LOG_UNAVAILABLE')
    address = ipaddress.ip_address(lines[0].split()[0])
    if not address.is_global:
        raise RuntimeError('EGRESS_NOT_PUBLIC')
    return hashlib.sha256(str(address).encode()).hexdigest()


def preflightGate(root, order_id, attempt_id):
    """只读内网预检；只有固定暂缓码可省略探测，允许结果仍须原 Gate 再检查。"""
    name = 'apple-official-http-preflight-' + attempt_id
    began = time.time()
    try:
        output = run([
            'docker', 'run', '--rm', '--name', name, '--network', 'apple-account-research-internal',
            '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64',
            '-e', 'NODE_PATH=/research/node_modules', '-v', str(root) + ':/research:ro',
            '-v', str(root / 'deps') + ':/research/node_modules:ro', '--entrypoint', 'node', IMAGE,
            '/research/release/scripts/officialPickupBackfill/preflightGate.js', '--http', str(order_id),
        ], timeout=30)
        if len(output) > 4096:
            raise ValueError()
        value = json.loads(output.decode('utf-8'))
        if (not isinstance(value, dict) or set(value) != {
                'version', 'outcome', 'orderId', 'checkedAt', 'planSha256', 'inputSha256', 'accountPaused', 'attempts'} or
                type(value['version']) is not int or value['version'] != 2 or
                type(value['orderId']) is not int or value['orderId'] != order_id or
                type(value['accountPaused']) is not bool or type(value['attempts']) is not int or value['attempts'] < 0 or
                type(value['checkedAt']) not in (int, float) or not math.isfinite(value['checkedAt']) or
                not began <= value['checkedAt'] <= time.time() or
                value['planSha256'] != hashlib.sha256((root / 'private/plan.json').read_bytes()).hexdigest() or
                value['inputSha256'] != hashlib.sha256((root / ('private/request-' + str(order_id) + '.json')).read_bytes()).hexdigest()):
            raise ValueError()
        expected = ('ACCOUNT_COOLDOWN' if value['accountPaused'] else
                    'ORDER_ATTEMPT_LIMIT' if value['attempts'] >= 10 else 'HTTP_PREFLIGHT_ALLOWED')
        if value['outcome'] != expected:
            raise ValueError()
        return value
    except Exception:
        # 只读容器超时也限时清理；异常一律停止，不猜测查询结果或继续采集。
        try:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=10)
        except Exception:
            pass
        raise RuntimeError('GATE_PREFLIGHT_FAILED') from None


def safeFailure(error):
    """只返回执行器定义的错误码，不记录命令、异常明文或代理凭据。"""
    codes = {'INPUT_INVALID', 'HTTP_SAMPLE_BUSY', 'HTTP_SAMPLE_CLEANUP_PENDING', 'BACKFILL_SCOPE_INVALID', 'PROXY_INDEX_INVALID',
             'RUNTIME_COMMAND_FAILED', 'API_HEALTH_FAILED', 'EGRESS_LOG_UNAVAILABLE', 'EGRESS_NOT_PUBLIC',
             'EGRESS_PREVIOUSLY_REJECTED', 'GATE_PREFLIGHT_FAILED', 'REQUEST_STOPPED'}
    if isinstance(error, subprocess.TimeoutExpired):
        return 'HTTP_SAMPLE_TIMEOUT'
    return str(error) if isinstance(error, RuntimeError) and str(error) in codes else 'HTTP_SAMPLE_FAILED'


def publicSummary(value):
    """保留关联与受限错误码，排除子进程意外输出的敏感字段。"""
    if not isinstance(value, dict):
        return {'outcome': 'COLLECTOR_OUTPUT_MISSING'}
    result = {}
    for key in ('outcome', 'receiptOutcome'):
        if isinstance(value.get(key), str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', value[key]):
            result[key] = value[key]
    result.setdefault('outcome', 'COLLECTOR_OUTPUT_MISSING')
    for key in ('orderId', 'runId', 'requests'):
        if isinstance(value.get(key), int) and not isinstance(value[key], bool) and value[key] >= 0:
            result[key] = value[key]
    runId = result.get('runId')
    for key in ('resultFile', 'detailResultFile'):
        path = value.get(key)
        if (isinstance(path, str) and runId and
                re.fullmatch(r'/research/private/results/order-[1-9][0-9]*-run-' + str(runId) + r'\.json', path)):
            result[key] = path
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--id', type=int, required=True)
    parser.add_argument('--proxy-index', type=int, required=True)
    parser.add_argument('--sample-lock-fd', type=int)
    args = parser.parse_args()
    root = pathlib.Path(args.root)
    attemptId = uuid.uuid4().hex
    startedAt = time.time()
    summary = {'outcome': 'HTTP_SAMPLE_FAILED'}
    lock = None
    isolatedLocks = contextlib.ExitStack()
    proxy = None
    before = None
    after = None
    cleanupNeeded = False
    name = 'apple-official-http-sample-' + attemptId
    stage = 'input'
    cleanup = {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'}
    try:
        if not root.is_absolute() or args.id < 1:
            raise RuntimeError('INPUT_INVALID')
        stage = 'lock'
        lockPath = root / 'private/http-sample.lock'
        if args.sample_lock_fd is None:
            lock = open(str(lockPath), 'a', encoding='utf-8')
        else:
            info = os.fstat(args.sample_lock_fd)
            expected = lockPath.stat()
            if (not stat.S_ISREG(info.st_mode) or info.st_ino != expected.st_ino or
                    info.st_dev != expected.st_dev):
                raise RuntimeError('INPUT_INVALID')
            lock = os.fdopen(os.dup(args.sample_lock_fd), 'a', encoding='utf-8')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('HTTP_SAMPLE_BUSY')
        for key in ('order-' + str(args.id), 'proxy-' + str(args.proxy_index)):
            handle = isolatedLocks.enter_context(open(str(root / ('private/http-' + key + '.lock')), 'a'))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('HTTP_SAMPLE_BUSY')
        stage = 'cleanup-pending'
        if (root / 'private/http-cleanup-blocked.json').exists():
            raise RuntimeError('HTTP_SAMPLE_CLEANUP_PENDING')
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        stage = 'plan'
        plan = json.loads((root / 'private/plan.json').read_text(encoding='utf-8'))
        if plan.get('scope') != 'missing-fields' or not any(e['id'] == args.id for e in plan['entries']):
            raise RuntimeError('BACKFILL_SCOPE_INVALID')
        stage = 'proxy'
        proxies = json.loads((root / 'private/iproyal-cn.json').read_text(encoding='utf-8'))['entries']
        if not 0 <= args.proxy_index < len(proxies):
            raise RuntimeError('PROXY_INDEX_INVALID')
        proxy = dict(proxies[args.proxy_index], provider='iproyal')
        stage = 'input-read'
        inputFile = root / ('private/request-' + str(args.id) + '.json')
        data = run(['docker', 'exec', '-i', '-e', 'OFFICIAL_ORDER_IDS=' + str(args.id),
                    'apple-order-mgr-prod-api-1', 'node', '-'],
                   input=(root / 'release/scripts/readOfficialOrderLinkInput.js').read_bytes(), timeout=30)
        preserveQuarantineInput(root, args.id)
        writePrivate(inputFile, json.loads(data))
        stage = 'preflight'
        decision = preflightGate(root, args.id, attemptId)
        if (root / 'private/STOP').exists():
            raise RuntimeError('REQUEST_STOPPED')
        if decision['outcome'] != 'HTTP_PREFLIGHT_ALLOWED':
            summary = {'outcome': decision['outcome'], 'requests': 0,
                       'preflightOnly': True, 'preflight': decision}
            return summary
        stage = 'probe-before'
        before = probe(proxy)
        rejectedFile = root / 'private/http-rejected-egress.json'
        if rejectedFile.exists():
            rejected = json.loads(rejectedFile.read_text(encoding='utf-8'))
            if not isinstance(rejected, list) or any(
                    not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in rejected):
                raise RuntimeError('INPUT_INVALID')
            if before in rejected:
                raise RuntimeError('EGRESS_PREVIOUSLY_REJECTED')
        stage = 'configuration'
        writePrivate(root / ('private/http-config-' + attemptId + '.json'), {
            'attemptId': attemptId, 'orderId': args.id, 'proxy': proxy, 'settings': {
                'maxTotalRequests': 201470, 'maxRunRequests': 40,
                'pythonPath': '/runtime/venv/bin/python', 'healthVerifiedAt': time.time(),
            },
        })
        stage = 'container-create'
        # create 超时也可能已创建容器，因此在发起命令之前登记清理责任。
        cleanupNeeded = True
        run(['docker', 'create', '--name', name, '--init', '--network', 'apple-account-research-internal',
             '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
             '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,size=67108864',
             '-e', 'HOME=/tmp', '-e', 'NODE_PATH=/research/node_modules',
             '-v', str(root) + ':/research:rw', '-v', str(root / 'deps') + ':/research/node_modules:ro',
             '-v', '/var/tmp/official-http-runtime-20261008:/runtime:ro',
             '--entrypoint', 'node', IMAGE, '/research/release/scripts/collectOfficialOrderHttp.js',
             '/research', str(args.id), attemptId], timeout=30)
        stage = 'container-network'
        run(['docker', 'network', 'connect', 'apple-account-research-egress', name], timeout=15)
        stage = 'collector'
        output = subprocess.run(['docker', 'start', '-a', name], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=210)
        try:
            summary = publicSummary(json.loads(output.stdout.decode('utf-8').strip().splitlines()[-1]))
        except (ValueError, IndexError):
            summary = {'outcome': 'COLLECTOR_OUTPUT_MISSING'}
        stage = 'container-inspect'
        state = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', name], timeout=15))
        if summary.get('outcome') == 'SUCCEEDED':
            runId = summary.get('runId')
            expectedFile = '/research/private/results/order-' + str(args.id) + '-run-' + str(runId) + '.json'
            if output.returncode or state.get('Running') is not False or state.get('ExitCode') != 0:
                summary['outcome'] = 'COLLECTOR_EXIT_INVALID'
            elif (summary.get('orderId') != args.id or not runId or summary.get('resultFile') != expectedFile):
                summary['outcome'] = 'COLLECTOR_IDENTITY_INVALID'
        stage = 'probe-after'
        try:
            after = probe(proxy)
        except Exception as error:
            summary['egressAfterError'] = safeFailure(error)
        if before != after:
            summary['originalOutcome'] = summary['outcome']
            summary['outcome'] = 'EGRESS_CHANGED_OR_UNVERIFIED'
        stage = 'complete'
    except Exception as error:
        # 不保留异常 str/repr 或子进程 stderr，避免包含请求、账号或代理凭据。
        summary.update(outcome=safeFailure(error), failedStage=stage,
                       errorType=type(error).__name__)
    finally:
        try:
            if cleanupNeeded:
                cleanup = {'attempted': True, 'removed': False, 'outcome': 'CONTAINER_CLEANUP_FAILED'}
                try:
                    removed = subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE, timeout=30)
                    cleanup['removed'] = removed.returncode == 0
                    cleanup['outcome'] = 'REMOVED' if cleanup['removed'] else 'CONTAINER_CLEANUP_FAILED'
                except subprocess.TimeoutExpired:
                    cleanup['outcome'] = 'CONTAINER_CLEANUP_TIMEOUT'
                except Exception:
                    cleanup['outcome'] = 'CONTAINER_CLEANUP_FAILED'
                if not cleanup['removed']:
                    # 未确认容器移除前，禁止后续调用覆盖它仍可能使用的共享配置。
                    try:
                        writePrivate(root / 'private/http-cleanup-blocked.json', {
                            'attemptId': attemptId, 'targetOrderId': args.id, 'containerName': name,
                            'outcome': cleanup['outcome'],
                        })
                        cleanup['blockRecorded'] = True
                    except Exception:
                        cleanup['blockRecorded'] = False
                    if summary.get('outcome') == 'SUCCEEDED':
                        summary['originalOutcome'] = summary['outcome']
                        summary['outcome'] = cleanup['outcome']
            finishedAt = time.time()
            summary.update(attemptId=attemptId, targetOrderId=args.id, proxyIndex=args.proxy_index,
                           startedAt=startedAt, finishedAt=finishedAt,
                           elapsedSeconds=round(finishedAt - startedAt, 3),
                           egressHash=before, egressAfterHash=after,
                           egressVerifiedAfter=(before is not None and before == after),
                           businessWrites=0, cleanup=cleanup)
            if cleanupNeeded:
                summary['containerName'] = name
            try:
                if root.is_absolute() and (root / 'private').is_dir():
                    writePrivate(root / ('private/http-sample-' + str(args.id) + '-' + attemptId + '.json'), summary)
                else:
                    raise RuntimeError('AUDIT_DIRECTORY_UNAVAILABLE')
            except Exception:
                summary['originalOutcome'] = summary['outcome']
                summary['outcome'] = 'AUDIT_WRITE_FAILED'
            print(json.dumps(summary))
        finally:
            isolatedLocks.close()
            if lock is not None:
                lock.close()
    return summary


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'outcome': 'HTTP_SAMPLE_FAILED', 'businessWrites': 0}))
        raise SystemExit(2)
