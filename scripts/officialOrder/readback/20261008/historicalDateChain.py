"""独立核验605历史日期填空链；既有HTTP提交原文与最新官网状态保持。"""
import hashlib
import json
import math
import os
import pathlib
import re
import stat

LEGACY_ROOT = pathlib.Path('/var/www/apple-order-mgr/shared/official-orders')
BODY_SHA = '67ac30a975598bd02dfe0ddf0932f8bdaa68ceb082f60fa72a6d2ecc821ea6b0'
SEALED_SHA = '1f31632357fcc929d2ba5d08128b80db01ef97198911baebcdfe3e00b89eefbf'
EVENTS_SHA = '23d1d1ac4f50286dbcf4cae2bdd6afeb1589371501313665d8d154c4bb1a0845'
STATE_SHA = '0d7b966700029b3bab7ef3be714cb5720014d5cdaa41521b601ae005472b7ec1'
SOURCE_FILES = frozenset(('private/results/order-605-run-47.json', 'private/evidence.key',
    'evidence/run-47/body-6-67ac30a975598bd0.enc', 'evidence/run-47/official-result-1f31632357fcc929.enc',
    'evidence/run-47/events.jsonl', 'evidence/run-47/state.json'))
MAX_BYTES = 16777216


def require(value):
    if not value:
        raise RuntimeError('HISTORICAL_DATE_CHAIN_INVALID')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def raw_private(path):
    require(not path.is_symlink())
    with os.fdopen(os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_size <= MAX_BYTES)
        raw = source.read(MAX_BYTES + 1)
        require(len(raw) == info.st_size)
    return raw


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    def decimal(value):
        number = float(value)
        require(math.isfinite(number))
        return number
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=lambda _: require(False), parse_float=decimal)


def named(root, name):
    require(isinstance(name, str) and re.fullmatch(r'[a-zA-Z0-9_-]+\.json', name))
    raw = raw_private(root / 'private' / name)
    return strict_json(raw), sha(raw)


def valid_hash(value, length=64):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{' + str(length) + '}', value) is not None


def verify_proof(proof, plan_hash, order_number, http_intent_hash):
    """复核已认证旧原文及原run固定身份；文件摘要变化时不能继续认领。"""
    require(proof.get('version') == 1 and proof.get('orderId') == 605 and
            proof.get('planSha256') == plan_hash and proof.get('httpIntentSha256') == http_intent_hash)
    legacy = proof.get('legacy', {})
    require(legacy.get('outcome') == 'HISTORICAL_LEGACY_SEALED_CHAIN_VERIFIED' and
            legacy.get('orderId') == 605 and legacy.get('runId') == 47 and
            legacy.get('bodySha256') == BODY_SHA and legacy.get('sealedResultSha256') == SEALED_SHA and
            legacy.get('eventsSha256') == EVENTS_SHA and legacy.get('stateSha256') == STATE_SHA and
            legacy.get('date') == '2026-09-23' and legacy.get('reason') is None and
            legacy.get('observedAt') == '2026-10-03T17:06:42.294Z' and legacy.get('products') == 2 and
            legacy.get('businessWrites') == 0 and legacy.get('network') == 'none' and
            legacy.get('currentHttpAuditCompatible') is False and legacy.get('missingEncryptedResponse') is True)
    research = proof.get('research', {})
    require(research.get('database') == 'apple_account_research' and research.get('attemptCount') == 1)
    require(research.get('run') == {'id': 47, 'sampleId': 605, 'mode': 'collect', 'outcome': 'SUCCEEDED',
            'requests': 43, 'startedAt': '2026-10-03T17:06:24.302Z', 'finishedAt': '2026-10-03T17:06:42.807Z'})
    files = proof.get('sourceFiles')
    require(isinstance(files, dict) and set(files) == SOURCE_FILES)
    require(files['evidence/run-47/events.jsonl'] == EVENTS_SHA and
            files['evidence/run-47/state.json'] == STATE_SHA)
    for relative, expected in files.items():
        require(valid_hash(expected) and sha(raw_private(LEGACY_ROOT / relative)) == expected)
    source = proof.get('sourceResult', {})
    require(source.get('orderNumber') == order_number and source.get('identityMatched') is True and
            source.get('sourceModel') == 'orderDetail' and source.get('completeItemCount') == 2 and
            isinstance(source.get('products'), list) and len(source['products']) == 2)
    require(all(item.get('rawStatus') == 'PICKED_UP' and type(item.get('quantity')) is int and
                item['quantity'] > 0 and isinstance(item.get('pickupDateText'), str) for item in source['products']))


def apply_historical_chain(root, expected, metadata, plan_hash):
    """保持原HTTP验证结果，仅在额外链完整时派生最新整行hash及日期归因。"""
    paths = list((root / 'private').glob('historical-date-intent-*.json'))
    if not paths:
        return
    require(len(paths) == 1 and paths[0].name == 'historical-date-intent-605.json')
    item = next((entry for entry in expected if entry['id'] == 605), None)
    require(item and item.get('http') is True and item.get('evidenceValid') is True and not item.get('receipt'))
    intent, _ = named(root, paths[0].name)
    require(set(intent) == {'version', 'state', 'orderId', 'attemptId', 'planSha256',
                           'proofFile', 'payloadFile', 'previewFile', 'resultFile', 'httpIntentSha256'})
    require(intent['version'] == 1 and intent['state'] == 'APPLIED' and intent['orderId'] == 605 and
            valid_hash(intent['attemptId'], 32) and intent['planSha256'] == plan_hash)
    prefix = 'historical-date-605-' + intent['attemptId']
    values = {}
    digests = {}
    for kind in ('proof', 'payload', 'preview', 'result'):
        require(intent[kind + 'File'] == prefix + '-' + kind + '.json')
        values[kind], digests[kind] = named(root, intent[kind + 'File'])
    http_intent, http_hash = named(root, 'http-apply-intent-605.json')
    require(http_intent['state'] == 'APPLIED' and intent['httpIntentSha256'] == http_hash)
    proof, payload, preview, result = (values[k] for k in ('proof', 'payload', 'preview', 'result'))
    verify_proof(proof, plan_hash, item['orderNumber'], http_hash)
    require(payload.get('version') == 1 and payload.get('kind') == 'VERIFIED_LEGACY_PICKUP_DATE' and
            payload.get('orderId') == 605 and payload.get('orderNumber') == item['orderNumber'] and
            payload.get('planSha256') == plan_hash and payload.get('proofSha256') == digests['proof'] and
            payload.get('sourceResult') == proof['sourceResult'] and payload.get('sourceRunId') == 47 and
            payload.get('sourceBodySha256') == BODY_SHA and
            payload.get('sourceObservedAt') == proof['legacy']['observedAt'] and
            payload.get('proposedDate') == proof['legacy']['date'] and
            payload.get('priorHttpAfterHash') == item['afterHash'])
    for value, mode, writes in ((preview, 'dry-run', 0), (result, 'apply', 1)):
        require(value.get('version') == 1 and value.get('mode') == mode and value.get('orderId') == 605 and
                valid_hash(value.get('payloadSha256')) and value.get('proofSha256') == digests['proof'] and
                value.get('beforeHash') == item['afterHash'] and valid_hash(value.get('afterHash'), 32) and
                value.get('previousDate') is None and value.get('proposedDate') == '2026-09-23' and
                type(value.get('dateFilled')) is bool and value['dateFilled'] == bool(writes) and
                type(value.get('businessWrites')) is int and value['businessWrites'] == writes and
                isinstance(value.get('beforeSnapshot'), dict) and isinstance(value.get('afterSnapshot'), dict) and
                isinstance(value.get('devices'), list) and value.get('devicesHash') == item['devicesHash'])
    require(preview['afterHash'] == preview['beforeHash'] and preview['afterSnapshot'] == preview['beforeSnapshot'])
    require(result['payloadSha256'] == preview['payloadSha256'] and
            result['beforeSnapshot'] == preview['beforeSnapshot'] and result['devices'] == preview['devices'] and
            result['beforeSnapshot'].get('actual_pickup_date') is None and
            result['afterSnapshot'] == dict(result['beforeSnapshot'], actual_pickup_date='2026-09-23') and
            result['afterHash'] != result['beforeHash'])
    item['historicalDate'] = {'payload': payload, 'result': result, 'originalHttpAfterHash': item['afterHash']}
    item['afterHash'] = result['afterHash']
    metadata.setdefault(605, {})['dateFilledThisTask'] = True


HISTORY_QUERY_JS = r'''
for(const e of expected){
 if(!e.historicalDate)continue;
 const h=e.historicalDate,r=h.result;
 h.hashesVerified=false;
 const digest=await client.query(`SELECT
   md5(jsonb_set(to_jsonb(o),'{actual_pickup_date}','null'::jsonb)::text) AS before,
   md5(to_jsonb(o)::text) AS after,
   jsonb_set(to_jsonb(o),'{actual_pickup_date}','null'::jsonb)=$1::jsonb AS before_equal,
   to_jsonb(o)=$2::jsonb AS after_equal
   FROM orders o WHERE id=$3 AND order_number=$4 AND actual_pickup_date=$5::date`,
   [JSON.stringify(r.beforeSnapshot),JSON.stringify(r.afterSnapshot),e.id,h.payload.orderNumber,h.payload.proposedDate]);
 if(digest.rows.length!==1||digest.rows[0].before!==h.originalHttpAfterHash||digest.rows[0].after!==r.afterHash||
    digest.rows[0].before_equal!==true||digest.rows[0].after_equal!==true)
   throw Error('HISTORICAL_DATE_SNAPSHOT_HASH_INVALID');
 h.hashesVerified=true;
}
'''
HISTORY_CHECK_JS = r'''
const baseHistoricalCheck=checkRow;
checkRow=function(e,row,plan){
 const result=baseHistoricalCheck(e,row,plan);
 if(!e.historicalDate)return result;
 const h=e.historicalDate,r=h.result;
 const historicalDateVerified=h.hashesVerified===true&&hash(h.payload)===r.payloadSha256&&
   hash(r.devices)===r.devicesHash&&equal(r.afterSnapshot,{...r.beforeSnapshot,actual_pickup_date:'2026-09-23'});
 return {...result,historicalDateVerified,ok:result.ok&&historicalDateVerified};
};
'''
