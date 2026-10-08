"""仅绑定同浏览器捕获且出口核验通过的收据，不再另起 HTTP 客户端。"""
import json
import pathlib
import re
from runtime import IMAGE, readJson, writeJson


def bindCaptured(root, work, orderId, receipt, egress, call):
    receipt = receipt or {'outcome': 'RECEIPT_NOT_ATTEMPTED'}
    if receipt['outcome'] != 'RECEIPT_CAPTURED':
        return {'orderId': orderId, 'outcome': receipt['outcome'], 'newBindings': 0}
    path = work / 'private' / ('receipt-probe-' + str(orderId) + '.json')
    metadata = readJson(path)
    if (metadata.get('systemOrderId') != orderId or metadata.get('egressHash') != egress or
            metadata.get('runId') != receipt.get('runId') or metadata.get('detailRun') != receipt.get('detailRun') or
            metadata.get('transport') != 'same-browser'):
        raise RuntimeError('RECEIPT_METADATA_INVALID')
    metadata['egressVerifiedAfter'] = True
    writeJson(path, metadata)
    # 保留中央元数据供终态核对；账号 Cookie 不离开各自槽。
    writeJson(root / 'private' / path.name, metadata)
    result = call(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                   '-v', str(work) + ':/research:ro',
                   '-v', str(root / 'evidence') + ':/research/evidence:ro',
                   '-v', str(root / 'private/results') + ':/research/private/results:ro',
                   '-v', str(root / 'release/src/services') + ':/app/src/services:ro',
                   '-v', str(root / 'release/scripts/officialPickupBackfill') + ':/ops:ro',
                   '--entrypoint', 'node', IMAGE, '/ops/verifyReceipt.js', str(orderId)], timeout=30)
    if result.returncode:
        code = result.stderr.decode().strip()
        return {'orderId': orderId, 'outcome': code if re.fullmatch('[A-Z_0-9]+', code) else 'RECEIPT_VERIFY_FAILED', 'newBindings': 0}
    payload = json.loads(result.stdout)
    code = 'const PAYLOAD=' + json.dumps(payload) + ';\n' + (root / 'release/scripts/officialPickupBackfill/bindReceipt.js').read_text(encoding='utf-8')
    result = call(['docker', 'exec', '-i', 'apple-order-mgr-prod-api-1', 'node'], input=code.encode(), timeout=45)
    for line in result.stdout.decode().splitlines():
        try:
            outcome = json.loads(line)
            if outcome.get('orderId') == orderId and 'outcome' in outcome:
                return outcome
        except ValueError:
            pass
    raise RuntimeError('RECEIPT_BIND_OUTPUT_MISSING')
