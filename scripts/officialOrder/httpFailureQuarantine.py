"""只读失败隔离的文件、容器和加密证据检查；不发官网请求或执行业务回写。"""
import hashlib
import json
import math
import re
import stat
import subprocess
import uuid

from runHttpSample import IMAGE

MAX_BYTES = 8388608
SAMPLE_KEYS = frozenset(('outcome', 'runId', 'requests', 'originalOutcome', 'egressAfterError',
    'attemptId', 'targetOrderId', 'proxyIndex', 'startedAt', 'finishedAt', 'elapsedSeconds',
    'egressHash', 'egressAfterHash', 'egressVerifiedAfter', 'businessWrites', 'cleanup', 'containerName'))
CHANGED_EGRESS_SAMPLE_KEYS = SAMPLE_KEYS - {'egressAfterError'}
STABLE_CONNECTION_KEYS = SAMPLE_KEYS - {'originalOutcome', 'egressAfterError'}
COMPLETE_UNVERIFIED_KEYS = (SAMPLE_KEYS - {'requests'}) | {'orderId', 'resultFile', 'receiptOutcome'}


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    def constant(_value):
        raise ValueError()
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def read_private(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_BYTES:
        raise ValueError()
    return path.read_bytes()


def equal_json(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def verify_node(root, proof_name, proof_sha, at, replay_closed=False):
    """在无网络、只读容器内重新核验原始密文链，宿主无需 Node 或解密依赖。"""
    name = 'apple-http-quarantine-verify-' + uuid.uuid4().hex
    try:
        result = subprocess.run([
            'docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
            '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '256m', '--pids-limit', '64',
            '-e', 'NODE_PATH=/research/node_modules', '-v', str(root) + ':/research:ro',
            '-v', str(root / 'deps') + ':/research/node_modules:ro', '--entrypoint', 'node', IMAGE,
            '/research/release/scripts/officialPickupBackfill/verifyHttpFailureQuarantine.js',
            '/research', proof_name, proof_sha, str(at), 'replay-closed' if replay_closed else 'close-current',
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if result.returncode or len(result.stdout) > MAX_BYTES:
            raise ValueError()
        return strict_json(result.stdout)
    finally:
        try:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=10)
        except Exception:
            pass


def runtime_boundary(root, sample, replay_closed=False):
    """必须保留出口拒绝，且不存在目标成功制品或仍存活的采集容器。"""
    rejected = strict_json(read_private(root / 'private/http-rejected-egress.json'))
    if (not isinstance(rejected, list) or any(not isinstance(value, str) or
            not re.fullmatch(r'[a-f0-9]{64}', value) for value in rejected) or (sample.get('outcome') != 'PROXY_CONNECTION_FAILED' and sample['egressHash'] not in rejected) or
            (sample.get('egressAfterHash') is not None and sample.get('egressVerifiedAfter') is False and
             sample.get('egressAfterHash') not in rejected)):
        raise ValueError()
    order = str(sample['targetOrderId'])
    for pattern in ('results/order-' + order + '-run-*.json', 'http-receipt-' + order + '-run-*.json',
                    'receipt-probe-' + order + '.json', 'http-apply-' + order + '-*.json',
                    'http-apply-basis-' + order + '-*.json', 'browser-receipt-bind-' + order + '-*.json',
                    'http-apply-intent-' + order + '.json', 'browser-receipt-bind-intent-' + order + '.json'):
        if replay_closed:
            continue
        matches = list((root / 'private').glob(pattern))
        if (sample.get('originalOutcome') == 'SUCCEEDED' and pattern.startswith('results/')):
            expected = root / ('private/results/order-' + order + '-run-' + str(sample['runId']) + '.json')
            if matches != [expected]:
                raise ValueError()
        elif matches:
            raise ValueError()
    result = subprocess.run(['docker', 'container', 'ls', '-a', '--format', '{{.Names}}'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    if result.returncode or len(result.stdout) > 65536:
        raise ValueError()
    names = result.stdout.decode('utf-8').splitlines()
    if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) for name in names):
        raise ValueError()
    if sample['containerName'] in names:
        raise ValueError()


def verify_failure(root, plan_sha, order_id, batch_attempt, sample, started_at, sample_at,
                   proof_name, proof_sha, at, expected=None):
    """精确原文、数据库原值与失败研究链共同证明失败；绝不将出口未知提升为成功。"""
    try:
        if not isinstance(sample, dict):
            raise ValueError()
        unknown_egress = (set(sample) == SAMPLE_KEYS and
                          sample.get('originalOutcome') in ('HTTP_541', 'HTTP_TIMEOUT', 'PROXY_CONNECTION_FAILED') and
                          sample.get('egressAfterError') == 'RUNTIME_COMMAND_FAILED' and
                          (sample.get('requests') == 3 or (sample.get('requests') == 2 and
                           sample.get('originalOutcome') == 'HTTP_TIMEOUT')) and sample.get('egressAfterHash') is None)
        unknown_after = (sample.get('egressAfterHash') is None and
                         sample.get('egressAfterError') == 'RUNTIME_COMMAND_FAILED')
        changed_after = (isinstance(sample.get('egressAfterHash'), str) and
                         re.fullmatch(r'[a-f0-9]{64}', sample['egressAfterHash']) and
                         sample['egressAfterHash'] != sample.get('egressHash') and 'egressAfterError' not in sample)
        changed_egress = (sample.get('originalOutcome') == 'PROXY_CONNECTION_FAILED' and sample.get('requests') == 4 and
                         ((set(sample) == CHANGED_EGRESS_SAMPLE_KEYS and changed_after) or
                          (set(sample) == SAMPLE_KEYS and unknown_after)))
        stable_connection = (set(sample) == STABLE_CONNECTION_KEYS and sample.get('outcome') == 'PROXY_CONNECTION_FAILED' and
                             sample.get('requests') == 3 and sample.get('egressAfterHash') == sample.get('egressHash') and
                             sample.get('egressVerifiedAfter') is True)
        redirect_limit = (set(sample) == SAMPLE_KEYS and
                          sample.get('originalOutcome') == 'REDIRECT_LIMIT' and
                          sample.get('egressAfterError') == 'RUNTIME_COMMAND_FAILED' and
                          sample.get('requests') == 9 and sample.get('egressAfterHash') is None)
        complete_unverified = (((set(sample) == COMPLETE_UNVERIFIED_KEYS and unknown_after) or
                                (set(sample) == COMPLETE_UNVERIFIED_KEYS - {'egressAfterError'} and changed_after)) and
                          sample.get('originalOutcome') == 'SUCCEEDED' and
                          sample.get('receiptOutcome') == 'RECEIPT_NOT_REQUESTED' and
                          type(sample.get('orderId')) is int and sample['orderId'] == order_id and
                          sample.get('resultFile') == '/research/private/results/order-' + str(order_id) + '-run-' + str(sample.get('runId')) + '.json')
        if (not (unknown_egress or changed_egress or redirect_limit or complete_unverified or stable_connection) or
                sample['outcome'] != ('PROXY_CONNECTION_FAILED' if stable_connection else 'EGRESS_CHANGED_OR_UNVERIFIED') or
                type(sample['businessWrites']) is not int or sample['businessWrites'] != 0 or
                type(sample['runId']) is not int or sample['runId'] <= 0 or
                (not complete_unverified and type(sample['requests']) is not int) or
                type(sample['targetOrderId']) is not int or sample['targetOrderId'] != order_id or
                type(sample['proxyIndex']) is not int or sample['proxyIndex'] < 0 or
                not isinstance(sample['attemptId'], str) or not re.fullmatch(r'[a-f0-9]{32}', sample['attemptId']) or
                not isinstance(sample['egressHash'], str) or not re.fullmatch(r'[a-f0-9]{64}', sample['egressHash']) or
                sample['egressVerifiedAfter'] is not stable_connection or
                not equal_json(sample['cleanup'], {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}) or
                sample['containerName'] != 'apple-official-http-sample-' + sample['attemptId'] or
                any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0
                    for value in (started_at, sample['startedAt'], sample['finishedAt'], sample_at, at)) or
                not started_at <= sample['startedAt'] <= sample['finishedAt'] <= sample_at <= at or
                type(sample['elapsedSeconds']) not in (int, float) or
                sample['elapsedSeconds'] != round(sample['finishedAt'] - sample['startedAt'], 3)):
            raise ValueError()
        name = 'http-sample-' + str(order_id) + '-' + sample['attemptId'] + '.json'
        raw = read_private(root / 'private' / name)
        if not equal_json(strict_json(raw), sample):
            raise ValueError()
        if (proof_name != 'http-failure-proof-' + str(order_id) + '-' + sample['attemptId'] + '.json' or
                not isinstance(proof_sha, str) or not re.fullmatch(r'[a-f0-9]{64}', proof_sha)):
            raise ValueError()
        proof_raw = read_private(root / 'private' / proof_name)
        if hashlib.sha256(proof_raw).hexdigest() != proof_sha:
            raise ValueError()
        proof = strict_json(proof_raw)
        if (proof.get('planSha256') != plan_sha or type(proof.get('orderId')) is not int or
                proof['orderId'] != order_id or proof.get('runId') != sample['runId'] or
                proof.get('batchAttemptId') != batch_attempt or proof.get('sampleAttemptId') != sample['attemptId'] or
                proof.get('sampleAuditSha256') != hashlib.sha256(raw).hexdigest()):
            raise ValueError()
        runtime_boundary(root, sample, replay_closed=expected is not None)
        evidence = verify_node(root, proof_name, proof_sha, at, replay_closed=expected is not None)
        if (not isinstance(evidence, dict) or evidence.get('outcome') != 'HTTP_FAILURE_QUARANTINE_VERIFIED' or
                evidence.get('orderId') != order_id or evidence.get('runId') != sample['runId'] or
                evidence.get('batchAttemptId') != batch_attempt or evidence.get('sampleAttemptId') != sample['attemptId'] or
                evidence.get('sampleAuditSha256') != proof['sampleAuditSha256'] or
                evidence.get('proofSha256') != proof_sha or evidence.get('planSha256') != plan_sha or
                evidence.get('egressHash') != sample['egressHash'] or
                ((changed_egress or stable_connection or (complete_unverified and changed_after)) and
                 evidence.get('egressAfterHash') != sample['egressAfterHash']) or
                not isinstance(evidence.get('files'), dict) or not evidence['files']):
            raise ValueError()
        if expected is not None and not equal_json(expected, evidence):
            raise ValueError()
        return evidence
    except Exception:
        raise RuntimeError('BATCH_FAILURE_QUARANTINE_DENIED') from None
