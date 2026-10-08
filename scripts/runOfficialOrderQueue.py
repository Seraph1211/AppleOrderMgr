#!/usr/bin/env python3
"""人工队列宿主执行器：固定 Docker 命令、单浏览器、私有结果提交。"""
import fcntl
import json
import os
import re
import signal
import subprocess
import time

ROOT = os.environ.get('OFFICIAL_ORDER_ROOT', '/var/www/apple-order-mgr/shared/official-orders')
API = 'apple-order-mgr-prod-api-1'
PREFIX = 'OFFICIAL_QUEUE_RESULT='
STDERR_FAILURE_CODES = frozenset([
    'ORDER_ID_INVALID', 'ORDER_NOT_FOUND', 'ACCOUNT_ID_MISSING',
    'ACCOUNT_REFERENCE_CONFLICT', 'ORDER_ACCOUNT_AMBIGUOUS', 'ACCOUNT_MARKED_INVALID',
    'ORDER_CREDENTIALS_MISSING', 'CREDENTIAL_DECRYPT_FAILED',
    'CREDENTIAL_SNAPSHOT_MISMATCH', 'ORDER_INPUT_READ_FAILED', 'ACCESS_REVOKED', 'ACCOUNT_CHANGED',
    'INPUT_INVALID', 'LINK_IDENTITY_MISMATCH', 'DESTINATION_DENIED',
    'ARGUMENTS_INVALID', 'PROXY_FILE_INVALID', 'PRIVATE_FILE_PERMISSIONS',
    'INPUT_TOO_LARGE', 'KEY_INVALID', 'ENCRYPTED_STATE_INVALID',
    'ACCOUNT_MISMATCH', 'SESSION_EXPIRED', 'SESSION_IDENTITY_MISMATCH',
    'SESSION_INVALID', 'ISOLATED_DATABASE_REQUIRED', 'CLI_FAILED',
])
STOPPING = False

def stop(_signal, _frame):
    global STOPPING
    STOPPING = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def command(action, value=None):
    result = subprocess.run(
        ['docker', 'exec', '-i', '-e', 'DB_POOL_MAX=1', API, 'node',
         'src/workers/officialOrderQueueCommand.js', action],
        input=json.dumps(value) if value is not None else '',
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, encoding='utf-8', errors='replace', timeout=30)
    if result.returncode:
        raise RuntimeError('QUEUE_COMMAND_FAILED')
    for line in reversed(result.stdout.splitlines()):
        if line.startswith(PREFIX):
            return json.loads(line[len(PREFIX):])
    raise RuntimeError('QUEUE_PROTOCOL_FAILED')


def read_summary(result):
    """标准输出是采集协议；标准错误只接受固定失败码，不公开原始诊断。"""
    for text, standard_error in [(result.stdout, False), (result.stderr, True)]:
        for line in reversed(text.splitlines()):
            if len(line) > (8192 if standard_error else 1048576):
                continue
            try:
                candidate = json.loads(line)
                code = candidate.get('outcome') if isinstance(candidate, dict) else None
                if not isinstance(code, str) or not re.match(r'^[A-Z_0-9]{1,80}$', code):
                    continue
                if standard_error:
                    if code in STDERR_FAILURE_CODES:
                        return {'outcome': code}
                else:
                    return candidate
            except ValueError:
                continue
    if 'COLLECTOR_BUSY' in result.stderr.splitlines():
        return {'outcome': 'COLLECTOR_BUSY'}
    if 'READ_ONLY_ORDER_INPUT_FAILED' in result.stderr.splitlines():
        return {'outcome': 'ORDER_INPUT_READ_FAILED'}
    return None


def read_result(summary, order_id):
    name = os.path.basename(summary.get('resultFile', ''))
    if not re.match(r'^order-%d-run-[1-9][0-9]*\.json$' % order_id, name):
        raise RuntimeError('RESULT_FILE_INVALID')
    path = ROOT + '/private/results/' + name
    if os.path.islink(path) or os.path.getsize(path) > 1048576:
        raise RuntimeError('RESULT_FILE_INVALID')
    with open(path, encoding='utf-8') as stream:
        return json.load(stream)


def collect(job):
    if not isinstance(job['orderId'], int) or job['orderId'] < 1:
        raise RuntimeError('ORDER_ID_INVALID')
    grouped = isinstance(job.get('jobs'), list)
    args = ['bash', ROOT + '/release/scripts/runOfficialOrderServer.sh', str(job['orderId'])]
    environment = dict(os.environ, OFFICIAL_ORDER_ROOT=ROOT)
    if grouped:
        args.append('account')
        environment.update(OFFICIAL_ACCOUNT_GROUP=job['accountGroupId'],
                           OFFICIAL_GROUP_LEASE=job['leaseToken'])
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, encoding='utf-8', errors='replace',
                            timeout=240, env=environment)
    summary = read_summary(result) or {'outcome': 'COLLECTOR_FAILED'}
    if not grouped:
        payload = dict(job, outcome=summary['outcome'])
        if result.returncode == 0 and payload['outcome'] == 'SUCCEEDED':
            payload['result'] = read_result(summary, job['orderId'])
        elif payload['outcome'] == 'SUCCEEDED':
            payload['outcome'] = 'COLLECTOR_EXIT_FAILED'
        return payload
    # 每个结果只匹配已领取的订单；允许已验证的部分成功，异常退出不接纳结果。
    observed = summary.get('results', []) if result.returncode in (0, 2) else []
    if not isinstance(observed, list):
        raise RuntimeError('RESULT_FILE_INVALID')
    by_id = {}
    expected = {item['orderId'] for item in job['jobs']}
    for item in observed:
        if (not isinstance(item, dict) or item.get('orderId') not in expected or
                item['orderId'] in by_id):
            raise RuntimeError('RESULT_FILE_INVALID')
        by_id[item['orderId']] = item
    payloads = []
    for member in job['jobs']:
        item = by_id.get(member['orderId'])
        code = item.get('outcome') if item else summary['outcome']
        if not isinstance(code, str) or not re.match(r'^[A-Z_0-9]{1,80}$', code):
            code = 'COLLECTOR_FAILED'
        if not item and code in ('SUCCEEDED', 'PARTIAL'):
            code = 'COLLECTOR_FAILED'
        payload = dict(member, outcome=code)
        if code == 'SUCCEEDED':
            payload['result'] = read_result(item, member['orderId'])
        payloads.append(payload)
    return {'accountGroupId': job['accountGroupId'], 'leaseToken': job['leaseToken'],
            'results': payloads}


def main():
    os.umask(0o077)
    with open(ROOT + '/private/queue.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while not STOPPING:
            job = None
            try:
                job = command('claim')
                if job:
                    try:
                        payload = collect(job)
                    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired):
                        subprocess.run(['docker', 'stop', '-t', '5', 'apple-official-order-collector'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                        payload = ({'accountGroupId': job['accountGroupId'], 'leaseToken': job['leaseToken'],
                                    'results': [dict(member, outcome='COLLECTOR_INTERRUPTED') for member in job['jobs']]}
                                   if job.get('jobs') else dict(job, outcome='COLLECTOR_INTERRUPTED'))
                    finished = command('finish-group' if job.get('jobs') else 'finish', payload)
                    print(json.dumps({'event': 'official_order_finished', 'jobId': job['id'],
                                      'orderId': job['orderId'], 'state': finished.get('state'),
                                      'errorCode': finished.get('errorCode')}), flush=True)
            except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired):
                # 不回放官网请求；未完成租约将过期，系统保留上次官网状态。
                print(json.dumps({'event': 'queue_unavailable', 'jobId': job.get('id') if job else None}), flush=True)
            time.sleep(5)


if __name__ == '__main__':
    main()
