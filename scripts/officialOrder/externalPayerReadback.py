"""第二批付款登记的只读验收附加证明，不授予任何采集或写入例外。"""
import hashlib
import pathlib
import re

from externalPayerChange import adjust_progress as adjust_first, PLAN_SHA, require
from writeBoundary import privateBytes, strictJson

PROOF_NAME = 'external-payer-change-second-20261008.json'
PROOF_SHA = '9c45e8f207c87f73393e8449148db3787a293fb476a0938a89855bfb2f3591dc'
IDS = (300, 301, 806, 1114)


def adjust_progress(root, expected, plan):
    """先保留第一批证明，再将固定四笔已验证HTTP结果连接至付款变更。"""
    records = adjust_first(root, expected, plan)
    root = pathlib.Path(root)
    raw = privateBytes(root / 'private' / PROOF_NAME)
    require(hashlib.sha256(raw).hexdigest() == PROOF_SHA)
    proof = strictJson(raw)
    require(type(proof.get('version')) is int and proof['version'] == 1 and
            proof.get('kind') == 'VERIFIED_EXTERNAL_PAYER_CHANGE' and
            proof.get('planSha256') == PLAN_SHA and
            type(proof.get('businessWrites')) is int and proof['businessWrites'] == 0 and
            hashlib.sha256(privateBytes(root / 'private/plan.json')).hexdigest() == PLAN_SHA)
    extra = proof.get('records')
    require(isinstance(extra, list) and tuple(r.get('id') for r in extra) == IDS)
    require(not set(IDS).intersection(r['id'] for r in records))
    by_id = {item['id']: item for item in expected}
    for record in extra:
        order_id = record['id']
        require(record.get('entry') == next(e for e in plan['entries'] if e['id'] == order_id) and
                record.get('kind') == 'AFTER_HTTP')
        files = record.get('sourceFiles')
        require(isinstance(files, dict) and len(files) == 2)
        for name, digest in files.items():
            require(isinstance(name, str) and re.fullmatch(r'http-apply-[a-z0-9-]+\.json', name) and
                    hashlib.sha256(privateBytes(root / 'private' / name)).hexdigest() == digest)
        item = by_id.get(order_id)
        require(item and item.get('evidenceValid') is True and item.get('http') is True and
                not item.get('receipt') and item['afterHash'] == record['beforeHash'] and
                item['stableRowHash'] == record['httpStableHash'] and
                item['devicesHash'] == record['devicesHash'])
        item['afterHash'] = record['acceptedFullHash']
        item['stableRowHash'] = record['acceptedStableHash']
    return records + extra
