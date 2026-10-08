"""仅关闭详情已成功、收据被守卫拒绝的明确失败；不采集或回写业务。"""
import hashlib
import re
import subprocess
import uuid

import runHttpBatch as http
from runHttpSample import IMAGE

AUDIT_KEYS = frozenset(('attemptId', 'auditFile', 'bootstrapMode', 'businessWrites', 'cleanup',
    'containerName', 'detailRunId', 'egressAfterHash', 'egressHash', 'egressVerifiedAfter', 'finishedAt',
    'leaseContext', 'orderId', 'outcome', 'passwordSubmitted', 'persistSessions',
    'proxyHash', 'proxyIndex', 'receipt', 'receiptOutcome', 'receiptRunId', 'resultFile', 'receiptEgressVerifiedAfter', 'runId', 'serverSessionRestored', 'startedAt',
    'targetOrderId'))


def read_json(root, name):
    raw = http.read_private(root / 'private' / name)
    return http.strict_json(raw), hashlib.sha256(raw).hexdigest()


def verify_node(root, proof_name, proof_sha, at):
    """无网络只读 Node 进程核验原始证据；输出只包含摘要和运行身份。"""
    name = 'apple-browser-close-verify-' + uuid.uuid4().hex
    try:
        output = subprocess.run([
            'docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
            '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '256m', '--pids-limit', '64', '-e', 'NODE_PATH=/research/node_modules',
            '-v', str(root) + ':/research:ro', '-v', str(root / 'deps') + ':/research/node_modules:ro',
            '--entrypoint', 'node', IMAGE,
            '/research/release/scripts/officialPickupBackfill/verifyBrowserFailureClose.js',
            '/research', proof_name, proof_sha, str(at),
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if output.returncode or len(output.stdout) > http.MAX_BYTES:
            raise ValueError()
        return http.strict_json(output.stdout)
    finally:
        try:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=10)
        except Exception:
            pass


def runtime_boundary(root, sample, http_run):
    """允许旧 HTTP 结果和本次明确详情，其余成功/写入制品继续阻断。"""
    order = str(sample['targetOrderId'])
    allowed_results = {'order-' + order + '-run-' + str(value) + '.json'
                       for value in (http_run, sample['detailRunId'])}
    for path in (root / 'private/results').glob('order-' + order + '-run-*.json'):
        if path.name not in allowed_results:
            raise ValueError()
    for pattern in ('http-receipt-' + order + '-run-*.json', 'receipt-probe-' + order + '.json',
                    'browser-receipt-bind-' + order + '-*.json', 'browser-receipt-bind-intent-' + order + '.json'):
        if any((root / 'private').glob(pattern)):
            raise ValueError()
    if any((root / 'evidence').glob('receipt-probe-' + str(sample['receiptRunId']) + '.enc')):
        raise ValueError()
    output = subprocess.run(['docker', 'container', 'ls', '-a', '--format', '{{.Names}}'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    if output.returncode or len(output.stdout) > 65536:
        raise ValueError()
    names = output.stdout.decode('utf-8').splitlines()
    if (any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) for name in names) or
            sample['containerName'] in names):
        raise ValueError()


def verify_failure_close(root, plan_sha, started, sample_attempt, proof_name, proof_sha, at, expected=None):
    """日志开始记录、唯一原审计、新鲜双库证明及原密文共同绑定本次只读失败。"""
    try:
        order_id = started['orderId']
        source = started['source']
        if (not isinstance(started, dict) or set(started) != {
                'orderId', 'planSha256', 'batchAttemptId', 'proxyIndex', 'source', 'event', 'at'} or
                started['event'] != 'target_started' or started['planSha256'] != plan_sha or
                not http.valid_int(order_id) or not http.valid_int(started['proxyIndex'], 0) or
                not isinstance(source, dict) or set(source) != {'basis', 'httpSourceAudit', 'afterHash'} or
                not isinstance(source['afterHash'], str) or not re.fullmatch(r'[a-f0-9]{32}', source['afterHash']) or
                any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value)
                    for value in (started['batchAttemptId'], sample_attempt)) or
                not http.valid_time(started['at']) or not http.valid_time(at) or started['at'] > at):
            raise ValueError()
        candidates = []
        for path in (root / 'private').glob('browser-sample-' + str(order_id) + '-*.json'):
            match = re.fullmatch('browser-sample-' + str(order_id) + r'-([a-f0-9]{32})\.json', path.name)
            audit, audit_sha = read_json(root, path.name)
            if (not match or not isinstance(audit, dict) or audit.get('attemptId') != match[1] or
                    not http.valid_int(audit.get('targetOrderId')) or audit['targetOrderId'] != order_id or
                    not http.valid_time(audit.get('startedAt'))):
                raise ValueError()
            if audit['startedAt'] >= started['at']:
                candidates.append((audit, audit_sha))
        if len(candidates) != 1:
            raise ValueError()
        sample, audit_sha = candidates[0]
        audit_name = 'browser-sample-' + str(order_id) + '-' + sample_attempt + '.json'
        if (set(sample) != AUDIT_KEYS or sample['attemptId'] != sample_attempt or sample['auditFile'] != audit_name or
                sample['outcome'] != 'RECEIPT_SESSION_REDIRECT' or
                sample['receiptOutcome'] != 'RECEIPT_SESSION_REDIRECT' or
                sample['bootstrapMode'] != 'native-browser' or sample['persistSessions'] is not False or
                sample['passwordSubmitted'] is not True or sample['serverSessionRestored'] is not False or
                sample['receiptEgressVerifiedAfter'] is not False or sample['egressVerifiedAfter'] is not True or
                type(sample['businessWrites']) is not int or sample['businessWrites'] != 0 or
                not http.valid_int(sample['orderId']) or sample['orderId'] != order_id or
                not http.valid_int(sample['runId']) or type(sample['detailRunId']) is not int or
                sample['detailRunId'] != sample['runId'] or
                not http.valid_int(sample['receiptRunId']) or sample['receiptRunId'] <= sample['detailRunId'] or
                sample['resultFile'] != '/research/private/results/order-' + str(order_id) + '-run-' + str(sample['detailRunId']) + '.json' or
                not http.equal_json(sample['receipt'], {'outcome': 'RECEIPT_SESSION_REDIRECT', 'orderId': order_id,
                    'runId': sample['receiptRunId'], 'detailRun': sample['detailRunId']}) or
                not http.valid_int(sample['proxyIndex'], 0) or sample['proxyIndex'] != started['proxyIndex'] or
                any(not http.valid_hash(sample[key]) for key in ('egressHash', 'egressAfterHash', 'proxyHash')) or
                sample['egressHash'] != sample['egressAfterHash'] or
                not http.equal_json(sample['cleanup'], {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}) or
                sample['containerName'] != 'apple-official-browser-sample-' + sample_attempt or
                not http.valid_time(sample['finishedAt']) or
                not started['at'] <= sample['startedAt'] <= sample['finishedAt'] <= at):
            raise ValueError()
        intent, _intent_sha = read_json(root, 'http-apply-intent-' + str(order_id) + '.json')
        if (intent.get('state') != 'APPLIED' or type(intent.get('orderId')) is not int or intent['orderId'] != order_id or
                not http.valid_int(intent.get('runId')) or intent['runId'] >= sample['runId'] or
                not isinstance(intent.get('attemptId'), str) or not re.fullmatch(r'[a-f0-9]{32}', intent['attemptId']) or
                intent.get('resultFile') != 'http-apply-' + str(order_id) + '-' + intent['attemptId'] + '-result.json' or
                source['basis'] != 'http-apply-basis-' + str(order_id) + '-run-' + str(intent['runId']) + '.json' or
                intent.get('sourceAudit') != source['httpSourceAudit'] or
                not re.fullmatch('http-sample-' + str(order_id) + r'-[a-f0-9]{32}\.json', source['httpSourceAudit'])):
            raise ValueError()
        result, result_sha = read_json(root, intent['resultFile'])
        _http_audit, http_audit_sha = read_json(root, source['httpSourceAudit'])
        if result.get('afterHash') != source['afterHash']:
            raise ValueError()
        if (proof_name != 'browser-failure-close-proof-' + str(order_id) + '-' + sample_attempt + '.json' or
                not http.valid_hash(proof_sha)):
            raise ValueError()
        proof, actual_proof_sha = read_json(root, proof_name)
        required = {'planSha256': plan_sha, 'orderId': order_id, 'detailRunId': sample['detailRunId'], 'receiptRunId': sample['receiptRunId'],
                    'phase': 'DETAIL_READY_RECEIPT_FAILED',
                    'batchAttemptId': started['batchAttemptId'], 'sampleAttemptId': sample_attempt,
                    'sampleAuditSha256': audit_sha, 'httpSourceAuditSha256': http_audit_sha,
                    'httpResultSha256': result_sha}
        if (proof.get('version') != 1 or proof.get('kind') != 'BROWSER_FAILURE_CLOSE' or
                actual_proof_sha != proof_sha or any(not http.equal_json(proof.get(key), value) for key, value in required.items())):
            raise ValueError()
        runtime_boundary(root, sample, intent['runId'])
        evidence = verify_node(root, proof_name, proof_sha, at)
        if (not isinstance(evidence, dict) or evidence.get('outcome') != 'BROWSER_FAILURE_CLOSE_VERIFIED' or
                evidence.get('processExitVerified') is not False or
                any(not http.equal_json(evidence.get(key), value) for key, value in required.items()) or
                evidence.get('proofSha256') != proof_sha or evidence.get('egressHash') != sample['egressHash'] or
                evidence.get('egressAfterHash') != sample['egressAfterHash'] or evidence.get('proxyHash') != sample['proxyHash'] or
                not isinstance(evidence.get('files'), dict) or not evidence['files'] or
                (expected is not None and not http.equal_json(evidence, expected))):
            raise ValueError()
        return evidence
    except Exception:
        raise RuntimeError('BROWSER_BATCH_FAILURE_CLOSE_DENIED') from None
