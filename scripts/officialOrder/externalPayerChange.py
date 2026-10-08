"""本次六笔合法付款登记的固定附加基线；不改原计划、业务行或历史HTTP审计。"""
import hashlib
import pathlib
import re
from writeBoundary import privateBytes, strictJson

PROOF_NAME = 'external-payer-change-20261008.json'
PROOF_SHA = '3c8eb38cc35e754ac7011cf010528c6858da7c8362e0f6c6e3a9d0ae58ef588f'
PLAN_SHA = '4c5ce536c17fab48df19a344e59b8e72b724353950a7576d7825f42fc977013d'
IDS = (220, 298, 366, 403, 677, 1113)


def require(value):
    if not value:
        raise RuntimeError('HTTP_APPLY_PAYER_CHANGE_INVALID')


def load_proof(root):
    """核对固定封存字节、原计划和原HTTP文件；缺少证明不授予例外。"""
    root = pathlib.Path(root)
    path = root / 'private' / PROOF_NAME
    if not path.exists():
        return None
    raw = privateBytes(path)
    require(hashlib.sha256(raw).hexdigest() == PROOF_SHA)
    proof = strictJson(raw)
    require(type(proof.get('version')) is int and proof['version'] == 1 and
            proof.get('kind') == 'VERIFIED_EXTERNAL_PAYER_CHANGE' and
            proof.get('planSha256') == PLAN_SHA and proof.get('businessWrites') == 0)
    plan_raw = privateBytes(root / 'private/plan.json')
    require(hashlib.sha256(plan_raw).hexdigest() == PLAN_SHA)
    plan = strictJson(plan_raw)
    records = proof.get('records')
    require(isinstance(records, list) and tuple(r.get('id') for r in records) == IDS)
    for record in records:
        require(record.get('entry') == next(e for e in plan['entries'] if e['id'] == record['id']))
        require(record.get('kind') == ('ORIGINAL' if record['id'] == 1113 else 'AFTER_HTTP'))
        files = record.get('sourceFiles')
        require(isinstance(files, dict) and len(files) == (0 if record['id'] == 1113 else 2))
        for name, digest in files.items():
            require(isinstance(name, str) and re.fullmatch(r'http-apply-[a-z0-9-]+\.json', name))
            require(hashlib.sha256(privateBytes(root / 'private' / name)).hexdigest() == digest)
    return proof


def apply_record(root, payload):
    """普通目标无例外；1113只能使用固定付款变更证明。"""
    if payload.get('entry', {}).get('id') != 1113:
        return None
    proof = load_proof(root)
    if proof is None:
        return None
    record = proof['records'][-1]
    require(payload.get('planSha256') == PLAN_SHA and payload.get('entry') == record['entry'])
    return record


def adjust_progress(root, expected, plan):
    """保留原证据链；附加变更仅派生五笔写后hash及未写1113的基线。"""
    proof = load_proof(root)
    if proof is None:
        return []
    by_id = {item['id']: item for item in expected}
    for record in proof['records']:
        item = by_id.get(record['id'])
        if record['kind'] == 'AFTER_HTTP':
            require(item and item.get('evidenceValid') is True and item.get('http') is True and
                    not item.get('receipt') and item['afterHash'] == record['beforeHash'] and
                    item['stableRowHash'] == record['httpStableHash'] and
                    item['devicesHash'] == record['devicesHash'])
            item['afterHash'] = record['acceptedFullHash']
            item['stableRowHash'] = record['acceptedStableHash']
        elif item:
            intent = strictJson(privateBytes(pathlib.Path(root) / 'private/http-apply-intent-1113.json'))
            require(intent.get('state') == 'APPLIED' and isinstance(intent.get('resultFile'), str) and
                    re.fullmatch(r'http-apply-1113-[a-f0-9]{32}-result\.json', intent['resultFile']))
            result = strictJson(privateBytes(pathlib.Path(root) / 'private' / intent['resultFile']))
            require(result.get('beforeHash') == record['acceptedFullHash'] and
                    result.get('snapshot', {}).get('order') == record['acceptedSnapshot'])
            require(item.get('evidenceValid') is True and item.get('http') is True and
                    not item.get('receipt') and
                    item['stableRowHash'] == record['acceptedStableHash'] and
                    item['devicesHash'] == record['devicesHash'])
    return proof['records']

CLOSE_NAME = 'external-payer-preview-close-1113.json'
CLOSE_SHA = 'c2160fb65634b88dbb0a55538382e4573a5140dc9ad7fa48b0bd019a6a55f923'
CLOSE_BATCH = '0f2089d1192c4cf9b5ac9cde5a74f0d7'
CLOSE_SAMPLE = '0ea4ea4c26f2477eaa22c3571f6f4f61'


def verify_preview_closure(root, event, sample, failure):
    """仅验证固定的零写preview失败；历史回放允许其后另有合法HTTP意图。"""
    root = pathlib.Path(root)
    require(load_proof(root) is not None)
    raw = privateBytes(root / 'private' / CLOSE_NAME)
    require(hashlib.sha256(raw).hexdigest() == CLOSE_SHA)
    proof = strictJson(raw)
    require(proof.get('version') == 1 and proof.get('kind') == 'DRY_PREVIEW_PAYER_CONFLICT' and
            proof.get('orderId') == 1113 and proof.get('batchAttemptId') == CLOSE_BATCH and
            proof.get('sample') == sample and proof.get('failure') == failure and
            proof.get('businessWrites') == 0 and proof.get('targetCompleted') is False)
    require(sample.get('attemptId') == CLOSE_SAMPLE and sample.get('runId') == 1437 and
            sample.get('outcome') == 'SUCCEEDED' and sample.get('businessWrites') == 0 and
            failure.get('outcome') == 'HTTP_APPLY_ORDER_CHANGED' and failure.get('businessWrites') == 0)
    required = {'event': 'payer_preview_failure_reconciled', 'orderId': 1113,
                'planSha256': PLAN_SHA, 'batchAttemptId': CLOSE_BATCH,
                'sampleAttemptId': CLOSE_SAMPLE, 'proofFile': CLOSE_NAME, 'proofSha256': CLOSE_SHA,
                'resolution': 'READ_ONLY_PREVIEW_PAYER_CONFLICT', 'businessWrites': 0, 'targetCompleted': False}
    require(set(event) == set(required) | {'at'} and
            all(type(event[k]) is type(v) and event[k] == v for k, v in required.items()))
    require(type(event['at']) in (int, float) and event['at'] >= sample['finishedAt'])
    for name, digest in proof['sourceFiles'].items():
        require(re.fullmatch(r'[a-z0-9-]+\.json', name) is not None and
                hashlib.sha256(privateBytes(root / 'private' / name)).hexdigest() == digest)
    return proof
