#!/usr/bin/env python3
"""管理台 HTTP 队列：十个不同账号并发，独立容器，IPRoyal API，逐单提交。"""
import concurrent.futures
import fcntl
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / 'officialOrder'))
from iproyalApi import generate_proxy, read_private
from runHttpSample import IMAGE, official_http_evidence_version, probe, run, writePrivate

ROOT = pathlib.Path(os.environ.get('OFFICIAL_ORDER_ROOT', '/var/www/apple-order-mgr/shared/official-http-refresh'))
API_CONTAINER = os.environ.get('OFFICIAL_API_CONTAINER', 'apple-order-mgr-prod-api-1')
RUNTIME = os.environ.get('OFFICIAL_HTTP_RUNTIME', '/var/tmp/official-http-runtime-20261008')
STOPPING = False
HTTP_MAX_CONCURRENCY = 10
RETRYABLE = {'HTTP_541', 'PROXY_CONNECTION_FAILED', 'HTTP_TIMEOUT', 'HTTP_502', 'HTTP_503', 'HTTP_504'}
PROBE_RETRYABLE = {'EGRESS_PROBE_TIMEOUT', 'EGRESS_PROBE_CONNECTION_FAILED', 'EGRESS_PROBE_HTTP_FAILED'}


def failure_code(error, stage):
    """分类宿主失败，只使用固定阶段与数字退出码，不输出异常明文。"""
    code = str(error) if isinstance(error, RuntimeError) else ''
    if code != 'RUNTIME_COMMAND_FAILED' and re.fullmatch(r'[A-Z_0-9]{1,80}', code):
        return code
    if stage in ('probe-before', 'probe-after'):
        exit_code = getattr(error, 'exit_code', None)
        if isinstance(error, subprocess.TimeoutExpired) or exit_code == 28:
            return 'EGRESS_PROBE_TIMEOUT'
        if exit_code in (5, 6, 7, 52, 55, 56, 97):
            return 'EGRESS_PROBE_CONNECTION_FAILED'
        if exit_code == 22:
            return 'EGRESS_PROBE_HTTP_FAILED'
        if exit_code in (35, 51, 58, 60):
            return 'EGRESS_PROBE_TLS_FAILED'
        return 'EGRESS_PROBE_FAILED'
    if isinstance(error, subprocess.TimeoutExpired):
        return 'RUNTIME_COMMAND_TIMEOUT'
    return code if re.fullmatch(r'[A-Z_0-9]{1,80}', code) else 'HTTP_COLLECTOR_FAILED'


def command(action, payload=None):
    output = run(['docker', 'exec', '-i', '-e', 'DB_POOL_MAX=1', API_CONTAINER,
                  'node', 'src/workers/officialOrderQueueCommand.js', action],
                 input=json.dumps(payload).encode() if payload is not None else b'', timeout=30)
    for line in reversed(output.decode().splitlines()):
        if line.startswith('OFFICIAL_QUEUE_RESULT='):
            return json.loads(line[len('OFFICIAL_QUEUE_RESULT='):])
    raise RuntimeError('QUEUE_PROTOCOL_FAILED')


def stopped():
    return (STOPPING or (ROOT / 'private/STOP').exists() or
            (ROOT / 'private/http-cleanup-blocked.json').exists() or
            (ROOT / 'private/http-evidence-v2-maintenance.lock').exists())


def probe_with_retry(proxy, audit, key):
    """仅重探自有健康接口一次，保持同一代理；不重放官网或放宽出口校验。"""
    for index in range(2):
        if stopped():
            raise RuntimeError('REQUEST_STOPPED')
        audit[key] = index + 1
        diagnostics = audit.setdefault(key + 'Diagnostics', [])
        try:
            return probe(proxy, diagnostics=diagnostics)
        except Exception as error:
            # kill switch 已明确拒绝此会话，继续同会话探测不会恢复出口。
            if diagnostics and diagnostics[-1].get('proxyConnectStatus') == 410:
                raise
            if index or failure_code(error, 'probe-before') not in PROBE_RETRYABLE:
                raise


def egress_state(address, attempt_id, outcome=None):
    """跨线程与重启保留拒用出口；未知中断的占用不自动清除。"""
    with open(str(ROOT / 'private/egress.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = ROOT / 'private/egress.json'
        state = read_private(path) if path.exists() else {}
        if outcome is None:
            if address in state:
                raise RuntimeError('EGRESS_PREVIOUSLY_REJECTED')
            state[address] = {'attemptId': attempt_id, 'state': 'active'}
        elif state.get(address, {}).get('attemptId') == attempt_id:
            if outcome == 'SUCCEEDED':
                del state[address]
            else:
                state[address]['state'] = 'rejected'
        writePrivate(path, state)


def attempt(job, rejected):
    attempt_id = uuid.uuid4().hex
    name = 'apple-official-refresh-' + attempt_id
    audit = {'attemptId': attempt_id, 'jobId': job['id'], 'orderId': job['orderId'],
             'startedAt': time.time(), 'outcome': 'HTTP_COLLECTOR_FAILED', 'cleanupVerified': True}
    created = False
    result = None
    stage = 'input-read'
    try:
        evidence_version = official_http_evidence_version()
        if stopped():
            raise RuntimeError('REQUEST_STOPPED')
        data = json.loads(run(['docker', 'exec', '-i', '-e', 'OFFICIAL_ORDER_IDS=' + str(job['orderId']),
                              API_CONTAINER, 'node', '-'], timeout=30,
                             input=(ROOT / 'release/scripts/readOfficialOrderLinkInput.js').read_bytes()))
        sample = data['samples'][0]
        if (sample['id'] != job['orderId'] or sample['orderNumber'] != job['orderNumber'] or
                (job.get('accountKey') and sample['accountHash'] != job['accountKey'])):
            raise RuntimeError('LINK_IDENTITY_MISMATCH')
        # 账号摘要沿用研究 Gate 算法；系统队列另以 accountKey 在提交时再次核对。
        stage = 'proxy-acquire'
        proxy = generate_proxy(read_private(ROOT / 'private/iproyal-api.json'))
        stage = 'probe-before'
        before = probe_with_retry(proxy, audit, 'probeBeforeAttempts')
        audit['egressBefore'] = before
        if before in rejected:
            raise RuntimeError('EGRESS_PREVIOUSLY_REJECTED')
        egress_state(before, attempt_id)
        stage = 'configuration'
        settings = read_private(ROOT / 'private/httpConfig.json')
        writePrivate(ROOT / ('private/refresh-' + attempt_id + '.json'), {
            'capturedAt': data['capturedAt'], 'sample': sample, 'proxy': proxy, 'settings': settings})
        if stopped():
            raise RuntimeError('REQUEST_STOPPED')
        created = True
        audit['cleanupVerified'] = False
        stage = 'container-create'
        run(['docker', 'create', '--name', name, '--init', '--network', 'apple-account-research-internal',
             '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
             '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,size=67108864',
             '-e', 'HOME=/tmp', '-e', 'NODE_PATH=/research/node_modules',
             '-e', 'OFFICIAL_HTTP_EVIDENCE_VERSION=' + evidence_version,
             '-v', str(ROOT) + ':/research:rw', '-v', str(ROOT / 'deps') + ':/research/node_modules:ro',
             '-v', RUNTIME + ':/runtime:ro', '--entrypoint', 'node', IMAGE,
             '/research/release/scripts/collectOfficialRefreshHttp.js', '/research', attempt_id], timeout=30)
        stage = 'container-network'
        run(['docker', 'network', 'connect', 'apple-account-research-egress', name], timeout=15)
        stage = 'collector'
        output = subprocess.run(['docker', 'start', '-a', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=210)
        summary = json.loads(output.stdout.decode().strip().splitlines()[-1])
        code = summary.get('outcome')
        if not isinstance(code, str) or not re.fullmatch(r'[A-Z_0-9]{1,80}', code):
            raise RuntimeError('COLLECTOR_OUTPUT_INVALID')
        audit.update(outcome=code, collectorOutcome=code, runId=summary.get('runId'))
        # 仅精确失败协议可证明没有成功结果；未知退出或部分成功不自动重放。
        audit['collectorFailureVerified'] = (
            output.returncode == 2 and set(summary) == {'outcome', 'runId'} and
            type(summary.get('runId')) is int and summary['runId'] > 0 and code in RETRYABLE)
        stage = 'probe-after'
        after = probe_with_retry(proxy, audit, 'probeAfterAttempts')
        audit['egressAfter'] = after
        if before != after:
            raise RuntimeError('EGRESS_CHANGED_OR_UNVERIFIED')
        if code == 'SUCCEEDED':
            stage = 'result-read'
            run_id = summary.get('runId')
            expected = '/research/private/results/order-{}-run-{}.json'.format(job['orderId'], run_id)
            if (output.returncode or type(run_id) is not int or run_id < 1 or
                    summary.get('orderId') != job['orderId'] or summary.get('resultFile') != expected):
                raise RuntimeError('COLLECTOR_OUTPUT_INVALID')
            result = read_private(ROOT / 'private/results' / pathlib.Path(expected).name)
    except Exception as error:
        code = failure_code(error, stage)
        audit['failedStage'] = stage
        if type(getattr(error, 'exit_code', None)) is int:
            audit['commandExitCode'] = error.exit_code
        if isinstance(error, subprocess.TimeoutExpired):
            audit['commandTimedOut'] = True
        if stage == 'probe-after':
            audit['egressAfterError'] = code
        # 后置探测错误不能掩盖已经取得的官网失败原因。
        audit['outcome'] = (audit['collectorOutcome'] if stage == 'probe-after' and
                            audit.get('collectorOutcome') not in (None, 'SUCCEEDED') else code)
        result = None
    finally:
        if created:
            try:
                run(['docker', 'rm', '-f', name], timeout=30)
                audit['cleanupVerified'] = True
            except Exception:
                audit['outcome'] = 'HTTP_CLEANUP_PENDING'
                writePrivate(ROOT / 'private/http-cleanup-blocked.json', {'container': name, 'attemptId': attempt_id})
        if not audit['cleanupVerified'] or audit['outcome'] != 'SUCCEEDED':
            result = None
        if audit.get('egressBefore'):
            egress_state(audit['egressBefore'], attempt_id, audit['outcome'])
        audit['finishedAt'] = time.time()
        writePrivate(ROOT / ('private/refresh-audit-' + attempt_id + '.json'), audit)
    return audit, result


def collect(job):
    rejected = set()
    for _index in range(3):
        audit, result = attempt(job, rejected)
        if result is not None:
            return dict(job, outcome='SUCCEEDED', result=result, transport='http')
        if audit.get('egressBefore'):
            rejected.add(audit['egressBefore'])
        retryable = (audit['outcome'] in RETRYABLE or
                     (audit.get('failedStage') == 'probe-before' and
                      audit['outcome'] in PROBE_RETRYABLE | {'EGRESS_PREVIOUSLY_REJECTED'}))
        after_error = audit.get('egressAfterError')
        failed_read_only = (
            audit.get('collectorFailureVerified') is True and
            audit.get('collectorOutcome') == audit['outcome'] and
            audit['outcome'] in RETRYABLE and
            audit.get('failedStage') == 'probe-after' and after_error in PROBE_RETRYABLE)
        if (stopped() or not audit['cleanupVerified'] or not retryable or
                (after_error and not failed_read_only)):
            break
    return dict(job, outcome=audit['outcome'], transport='http')


def stop(_signal, _frame):
    global STOPPING
    STOPPING = True


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # 启动前配置失败不得伪造在线心跳。
    read_private(ROOT / 'private/iproyal-api.json')
    read_private(ROOT / 'private/httpConfig.json')
    for intent in (ROOT / 'private').glob('finish-*.json'):
        if read_private(intent).get('state') != 'FINISHED':
            raise RuntimeError('QUEUE_COMMIT_UNCONFIRMED')
    with open(str(ROOT / 'private/queue.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with concurrent.futures.ThreadPoolExecutor(max_workers=HTTP_MAX_CONCURRENCY) as pool:
            pending = {}
            while not STOPPING or pending:
                for future in list(pending):
                    if not future.done():
                        continue
                    job = pending.pop(future)
                    try:
                        payload = future.result()
                        if stopped() and payload.get('outcome') == 'SUCCEEDED':
                            payload = dict(job, outcome='REQUEST_STOPPED')
                        # 先持久写入意图，未知提交保存原凭据及结果，不重放官网或 finish。
                        intent = ROOT / ('private/finish-' + job['id'] + '.json')
                        writePrivate(intent, {'state': 'STARTED', 'payload': payload})
                        finished = command('finish', payload)
                        writePrivate(intent, {'state': 'FINISHED', 'result': finished})
                        print(json.dumps({'event': 'official_http_finished', 'jobId': job['id'], 'result': finished}), flush=True)
                    except Exception:
                        writePrivate(ROOT / 'private/STOP', {'reason': 'QUEUE_COMMIT_UNCONFIRMED', 'jobId': job['id']})
                        print(json.dumps({'event': 'official_http_stopped', 'jobId': job['id']}), flush=True)
                if not stopped():
                    try:
                        job = command('claim-http')
                        if job:
                            pending[pool.submit(collect, job)] = job
                            continue
                    except Exception:
                        print(json.dumps({'event': 'official_http_queue_unavailable'}), flush=True)
                time.sleep(1)


if __name__ == '__main__':
    main()
