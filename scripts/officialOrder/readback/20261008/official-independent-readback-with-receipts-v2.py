"""独立只读回读：按原证据区分 HTTP／收据先后，完整行与设备快照仍须一致。"""
import argparse
import collections
import datetime
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import subprocess
import time
import uuid

ROOT = '/var/www/apple-order-mgr/shared/official-rebuild-20261008'
API_CONTAINER = 'apple-order-mgr-prod-api-1'
MAX_BYTES = 16777216
PUBLIC_BOUND = ('orderId', 'outcome', 'serialCount', 'newBindings', 'serialsHash', 'deviceIds',
                'actorUserId', 'receiptRunId', 'receiptSha256', 'detailSha256', 'orderBeforeHash',
                'orderAfterHash', 'manualPickupUnchanged', 'inventoryReceiveCreated')


def require(condition, code='EVIDENCE_INVALID'):
    if not condition:
        raise RuntimeError(code)


def positive(value):
    return type(value) is int and 0 < value <= 9007199254740991


def digest(value, length=64):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{' + str(length) + '}', value) is not None


def sha(value):
    return hashlib.sha256(value).hexdigest()


def json_hash(value):
    return sha(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))


def exact_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def read_private(root, relative):
    target = root / relative
    require(str(target.resolve()).startswith(str(root.resolve()) + os.sep), 'PRIVATE_PATH_INVALID')
    descriptor = os.open(str(target), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_size <= MAX_BYTES,
                'PRIVATE_FILE_INVALID')
        raw = source.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, 'PRIVATE_FILE_INVALID')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=exact_object,
                      parse_constant=lambda _: require(False, 'JSON_NUMBER_INVALID')), sha(raw)


def named(root, name):
    require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json', name),
            'PRIVATE_PATH_INVALID')
    return read_private(root, 'private/' + name)


def timestamp(value):
    require(isinstance(value, str), 'TIME_INVALID')
    for pattern in ('%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ'):
        try:
            parsed = datetime.datetime.strptime(value, pattern).replace(tzinfo=datetime.timezone.utc)
            return parsed.timestamp()
        except ValueError:
            pass
    raise RuntimeError('TIME_INVALID')


def valid_uuid(value):
    try:
        return isinstance(value, str) and uuid.UUID(value).int > 0 and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def sample_audit(root, name, prefix, entry, plan):
    match = re.fullmatch(prefix + '-sample-' + str(entry['id']) + r'-([a-f0-9]{32})\.json', name or '')
    require(match, 'SAMPLE_AUDIT_INVALID')
    audit, audit_hash = named(root, name)
    require(audit.get('attemptId') == match.group(1) and audit.get('outcome') == 'SUCCEEDED' and
            audit.get('orderId') == entry['id'] and audit.get('targetOrderId') == entry['id'] and
            positive(audit.get('runId')) and type(audit.get('businessWrites')) is int and
            audit['businessWrites'] == 0 and audit.get('cleanup', {}).get('removed') is True and
            audit.get('egressVerifiedAfter') is True and digest(audit.get('egressHash')) and
            audit.get('egressAfterHash') == audit['egressHash'] and
            audit.get('resultFile') == '/research/private/results/order-{}-run-{}.json'.format(entry['id'], audit['runId']),
            'SAMPLE_AUDIT_INVALID')
    started, finished = audit.get('startedAt'), audit.get('finishedAt')
    require(type(started) in (int, float) and type(finished) in (int, float) and
            math.isfinite(started) and math.isfinite(finished) and
            timestamp(plan['startedAt']) <= started <= finished <= time.time() and finished - started <= 360,
            'SAMPLE_AUDIT_INVALID')
    return audit, audit_hash


def http_evidence(root, intent, entry, plan, plan_hash):
    order_id = entry['id']
    require(intent.get('state') == 'APPLIED' and intent.get('orderId') == order_id and
            digest(intent.get('attemptId'), 32) and positive(intent.get('runId')), 'HTTP_INTENT_INVALID')
    prefix = 'http-apply-{}-{}'.format(order_id, intent['attemptId'])
    values = {}
    for kind in ('payload', 'preview', 'result', 'audit'):
        require(intent.get(kind + 'File') == prefix + '-' + kind + '.json', 'HTTP_INTENT_INVALID')
        values[kind] = named(root, intent[kind + 'File'])[0]
    payload, preview, result, applied = (values[k] for k in ('payload', 'preview', 'result', 'audit'))
    source, source_hash = sample_audit(root, intent.get('sourceAudit'), 'http', entry, plan)
    basis_name = 'http-apply-basis-{}-run-{}.json'.format(order_id, intent['runId'])
    basis = named(root, basis_name)[0]
    require(basis == result.get('basis') == preview.get('basis') and basis.get('version') == 1 and
            basis.get('planSha256') == plan_hash and basis.get('orderId') == order_id and
            basis.get('originalRowHash') == entry['rowHash'] and digest(basis.get('stableRowHash'), 32) and
            basis.get('runId') == source['runId'] == intent['runId'] and basis.get('auditSha256') == source_hash,
            'HTTP_BASIS_INVALID')
    require(payload.get('version') == 1 and payload.get('planSha256') == plan_hash and
            payload.get('plan') == plan and payload.get('entry') == entry and payload.get('audit') == source and
            payload.get('evidence', {}).get('auditSha256') == source_hash and
            payload.get('result', {}).get('systemOrderId') == order_id and
            payload['result'].get('orderNumber') == entry['orderNumber'] and
            payload['result'].get('source', {}).get('runId') == source['runId'], 'HTTP_PAYLOAD_INVALID')
    # HTTP 使用 JSON.stringify 摘要；留给 Node 原生计算，避免 Python 浮点 JSON 表示差异。
    payload_hash = result.get('payloadSha256')
    require(digest(payload_hash), 'HTTP_RESULT_INVALID')
    for value, mode in ((preview, 'dry-run'), (result, 'apply')):
        require(value.get('version') == 1 and value.get('mode') == mode and value.get('orderId') == order_id and
                value.get('runId') == intent['runId'] and value.get('payloadSha256') == payload_hash and
                value.get('stableRowHash') == basis['stableRowHash'] and digest(value.get('beforeHash'), 32) and
                digest(value.get('devicesHash')) and isinstance(value.get('snapshot', {}).get('devices'), list),
                'HTTP_RESULT_INVALID')
    require(preview.get('businessWrites') == 0 and type(result.get('businessWrites')) is int and
            result['businessWrites'] in (0, 1) and preview['beforeHash'] == result['beforeHash'] and
            preview['devicesHash'] == result['devicesHash'] and preview['snapshot'] == result['snapshot'] and
            json_hash(result['snapshot']['devices']) == result['devicesHash'] and
            digest(result.get('afterHash'), 32) and applied.get('outcome') == 'SUCCEEDED' and
            applied.get('mode') == 'apply' and applied.get('orderId') == order_id and
            applied.get('runId') == intent['runId'] and applied.get('resultFile') == intent['resultFile'] and
            applied.get('basisFile') == basis_name and applied.get('beforeHash') == result['beforeHash'] and
            applied.get('afterHash') == result['afterHash'] and applied.get('businessWrites') == result['businessWrites'],
            'HTTP_RESULT_INVALID')
    return {'id': order_id, 'orderNumber': entry['orderNumber'], 'http': True,
            'afterHash': result['afterHash'], 'beforeHash': result['beforeHash'],
            'httpRunId': source['runId'], 'httpStartedAt': source['startedAt'],
            'stableRowHash': result['stableRowHash'],
            'devicesHash': result['devicesHash'], 'previousDevices': result['snapshot']['devices'],
            'httpPayload': dict(payload, plan=None), 'httpPayloadHash': payload_hash,
            'basis': basis, 'basisFile': basis_name, 'sourceAudit': intent['sourceAudit'],
            'sourceAuditSha256': source_hash, 'httpApplyAuditFile': intent['auditFile']}


def receipt_evidence(root, intent, entry, plan, http):
    order_id = entry['id']
    require(intent.get('state') == 'APPLIED' and intent.get('orderId') == order_id and
            digest(intent.get('attemptId'), 32), 'RECEIPT_INTENT_INVALID')
    prefix = 'browser-receipt-bind-{}-{}'.format(order_id, intent['attemptId'])
    values = {}
    for kind in ('payload', 'result', 'audit'):
        require(intent.get(kind + 'File') == prefix + '-' + kind + '.json', 'RECEIPT_INTENT_INVALID')
        values[kind] = named(root, intent[kind + 'File'])
    payload, payload_hash = values['payload']
    result, applied = values['result'][0], values['audit'][0]
    require(intent.get('payloadSha256') == payload_hash, 'RECEIPT_PAYLOAD_HASH_INVALID')
    audit, audit_hash = sample_audit(root, intent.get('sourceAudit'), 'browser', entry, plan)
    receipt = payload.get('receipt', {})
    require(payload.get('schemaVersion') == 3 and payload.get('scope') == 'missing-fields' and
            payload.get('cutoff') is None and payload.get('startedAt') == plan['startedAt'], 'RECEIPT_SCOPE_INVALID')
    expected_entry = dict(entry)
    provenance = ('basisFile', 'basisSha256', 'httpSourceAudit', 'httpSourceAuditSha256', 'httpApplyAuditFile')
    has_http_provenance = any(key in receipt for key in provenance)
    receipt_first = bool(http and not has_http_provenance)
    if http and not receipt_first:
        expected_entry['stableRowHash'] = http['stableRowHash']
        require(receipt.get('basisFile') == http['basisFile'] and
                receipt.get('basisSha256') == named(root, http['basisFile'])[1] and
                receipt.get('httpSourceAudit') == http['sourceAudit'] and
                receipt.get('httpSourceAuditSha256') == http['sourceAuditSha256'] and
                receipt.get('httpApplyAuditFile') == http['httpApplyAuditFile'], 'RECEIPT_HTTP_BASIS_INVALID')
    else:
        require(not has_http_provenance,
                'RECEIPT_HTTP_BASIS_INVALID')
    require(payload.get('entry') == expected_entry, 'RECEIPT_ENTRY_INVALID')
    require(audit.get('auditFile') == intent['sourceAudit'] and audit.get('receiptEgressVerifiedAfter') is True and
            audit.get('detailRunId') == audit['runId'] and positive(audit.get('receiptRunId')) and
            audit['receiptRunId'] > audit['runId'] and audit.get('receiptOutcome') == 'RECEIPT_CAPTURED' and
            audit.get('receipt', {}).get('outcome') == 'RECEIPT_CAPTURED' and
            audit['receipt'].get('orderId') == order_id and audit['receipt'].get('detailRun') == audit['runId'] and
            audit['receipt'].get('runId') == audit['receiptRunId'] and digest(audit.get('proxyHash')) and
            audit.get('receiptFile') == '/research/private/receipt-probe-{}.json'.format(order_id),
            'RECEIPT_SOURCE_AUDIT_INVALID')
    lease = audit.get('leaseContext', {})
    require(lease.get('provider') == 'iproyal' and lease.get('proxyHash') == audit['proxyHash'] and
            lease.get('egressHash') == audit['egressHash'] and
            timestamp(lease.get('startedAt')) <= audit['startedAt'] and
            audit['finishedAt'] - timestamp(lease['startedAt']) <= 86400 - 30, 'RECEIPT_LEASE_INVALID')
    require(receipt.get('systemOrderId') == order_id and receipt.get('orderNumber') == entry['orderNumber'] and
            receipt.get('runId') == audit['receiptRunId'] == intent.get('receiptRunId') and
            receipt.get('detailRun') == audit['runId'] and receipt.get('status') == 200 and
            re.match(r'^text/html(?:\s*;|$)', receipt.get('contentType', ''), re.I) and
            receipt.get('transport') == 'same-browser' and receipt.get('egressVerifiedAfter') is True and
            receipt.get('egressHash') == audit['egressHash'] and receipt.get('egressAfterHash') == audit['egressAfterHash'] and
            receipt.get('proxyHash') == audit['proxyHash'] and receipt.get('leaseStartedAt') == lease['startedAt'] and
            receipt.get('browserAuditFile') == intent['sourceAudit'] and receipt.get('browserAuditSha256') == audit_hash and
            receipt.get('browserAttemptId') == audit['attemptId'] and digest(receipt.get('sha256')) and
            receipt['sha256'] == intent.get('receiptSha256') and digest(receipt.get('detailSha256')) and
            digest(receipt.get('urlHash')) and receipt.get('file') == 'receipt-probe-{}.enc'.format(receipt['runId']),
            'RECEIPT_METADATA_INVALID')
    observed = timestamp(receipt.get('observedAt'))
    require(type(intent.get('startedAt')) in (int, float) and math.isfinite(intent['startedAt']) and
            audit['startedAt'] <= observed <= audit['finishedAt'] <= intent['startedAt'] <= time.time() and
            intent['startedAt'] - observed <= 300, 'RECEIPT_APPLY_TIME_INVALID')
    detail = read_private(root, 'private/results/order-{}-run-{}.json'.format(order_id, audit['runId']))[0]
    source = detail.get('source', {})
    require(detail.get('systemOrderId') == order_id and detail.get('orderNumber') == entry['orderNumber'] and
            source.get('provider') == 'Apple official website' and source.get('runId') == audit['runId'] and
            source.get('sampleId') == order_id and source.get('sha256') == receipt['detailSha256'] and
            source.get('cached') is False and audit['startedAt'] <= timestamp(source.get('observedAt')) <= observed,
            'RECEIPT_DETAIL_INVALID')
    parsed = payload.get('parsed', {})
    require(parsed.get('orderNumber') == entry['orderNumber'] and isinstance(parsed.get('items'), list) and
            0 < len(parsed['items']) <= 1000, 'RECEIPT_SERIALS_INVALID')
    serials = [item.get('serialNumber') for item in parsed['items']]
    require(all(isinstance(value, str) and re.fullmatch(r'(?:[A-Z0-9]{10}|[A-Z0-9]{12})', value) and re.search('[A-Z]', value)
                for value in serials) and len(set(serials)) == len(serials), 'RECEIPT_SERIALS_INVALID')
    serials.sort()
    require(result.get('outcome') == 'SERIALS_VERIFIED' and result.get('orderId') == order_id and
            result.get('receiptRunId') == receipt['runId'] and result.get('receiptSha256') == receipt['sha256'] and
            result.get('detailSha256') == receipt['detailSha256'] and result.get('serialCount') == len(serials) and
            result.get('serialsHash') == json_hash(serials) and type(result.get('newBindings')) is int and
            0 <= result['newBindings'] <= len(serials) and positive(result.get('actorUserId')) and
            isinstance(result.get('deviceIds'), list) and len(result['deviceIds']) == len(serials) and
            all(valid_uuid(value) for value in result['deviceIds']) and len(set(result['deviceIds'])) == len(serials) and
            digest(result.get('orderBeforeHash'), 32) and result['orderBeforeHash'] == result.get('orderAfterHash') and
            result.get('manualPickupUnchanged') is True and result.get('inventoryReceiveCreated') is False,
            'RECEIPT_RESULT_INVALID')
    require(all(applied.get(key) == result[key] for key in PUBLIC_BOUND) and applied.get('mode') == 'apply' and
            applied.get('payloadFile') == intent['payloadFile'] and applied.get('resultFile') == intent['resultFile'] and
            applied.get('auditFile') == intent['auditFile'] and applied.get('businessWrites') is None and
            applied.get('businessWriteCountKnown') is False, 'RECEIPT_APPLY_AUDIT_INVALID')
    if receipt_first:
        # 无后来 HTTP 来源的历史收据只能连接到 HTTP 写前行及完整设备快照。
        # intent 没有完成时间；设备已出现在 HTTP 快照才是先绑定的独立依据。
        require(result['orderAfterHash'] == http['beforeHash'] and
                http['httpRunId'] > receipt['runId'] and intent['startedAt'] < http['httpStartedAt'],
                'RECEIPT_BEFORE_HTTP_ORDER_INVALID')
        devices = http['previousDevices']
        require(isinstance(devices, list) and len(devices) == len(serials) and
                all(isinstance(device, dict) and valid_uuid(device.get('id')) and
                    device.get('order_id') == order_id and valid_uuid(device.get('stock_unit_id')) and
                    isinstance(device.get('serial_number'), str) for device in devices) and
                sorted(device['id'] for device in devices) == sorted(result['deviceIds']) and
                sorted(device['serial_number'] for device in devices) == serials,
                'RECEIPT_BEFORE_HTTP_DEVICES_INVALID')
        for old in entry['previousDevices']:
            current = next((device for device in devices if device['id'] == old.get('id')), None)
            require(current is not None and all(
                key == 'stock_unit_id' and value is None and valid_uuid(current.get(key)) or
                type(current.get(key)) is type(value) and current.get(key) == value
                for key, value in old.items()), 'RECEIPT_BEFORE_HTTP_DEVICES_INVALID')
    elif http:
        require(result['orderAfterHash'] == http['afterHash'], 'RECEIPT_HTTP_ROW_HASH_MISMATCH')
    return {'serials': serials, 'serialsHash': result['serialsHash'], 'deviceIds': sorted(result['deviceIds']),
            'afterHash': result['orderAfterHash'], 'originalHash': entry['rowHash'],
            'sequence': 'RECEIPT_THEN_HTTP' if receipt_first else 'HTTP_THEN_RECEIPT' if http else 'RECEIPT_ONLY',
            'previousDevices': http['previousDevices'] if http else entry['previousDevices']}


def load_evidence(root):
    plan, plan_hash = named(root, 'plan.json')
    require(plan.get('schemaVersion') == 3 and plan.get('scope') == 'missing-fields' and plan.get('cutoff') is None and
            plan.get('policy') == {'loginCooldown': True, 'apiHealthCheck': True, 'proxy541Limit': 3} and
            isinstance(plan.get('entries'), list) and 0 < len(plan['entries']) <= 10000, 'PLAN_INVALID')
    timestamp(plan.get('startedAt'))
    entries = {}
    for entry in plan['entries']:
        require(positive(entry.get('id')) and entry['id'] not in entries and
                re.fullmatch(r'W\d{10}', entry.get('orderNumber', '')) and digest(entry.get('rowHash'), 32) and
                type(entry.get('dateMissing')) is bool and type(entry.get('serialsMissing')) is bool and
                (entry['dateMissing'] or entry['serialsMissing']) and isinstance(entry.get('previousDevices'), list) and
                entry['serialsMissing'] == (len(entry['previousDevices']) == 0) and
                entry['dateMissing'] == (entry.get('previousDate') is None), 'PLAN_INVALID')
        entries[entry['id']] = entry
    expected = {}
    issues = {}
    counters = {'httpIntentStates': collections.Counter(), 'receiptIntentStates': collections.Counter()}
    for prefix, counter in (('http-apply', 'httpIntentStates'), ('browser-receipt-bind', 'receiptIntentStates')):
        for file in sorted((root / 'private').glob(prefix + '-intent-*.json')):
            match = re.fullmatch(prefix + r'-intent-([1-9]\d*)\.json', file.name)
            require(match, 'INTENT_FILENAME_INVALID')
            order_id = int(match.group(1))
            item = expected.setdefault(order_id, {'id': order_id, 'evidenceValid': True, 'http': False})
            try:
                require(order_id in entries, 'INTENT_OUTSIDE_PLAN')
                intent = named(root, file.name)[0]
                state = intent.get('state')
                require(state in ('APPLIED', 'ROLLED_BACK', 'APPLY_STARTED'), 'INTENT_STATE_UNKNOWN')
                counters[counter][state] += 1
                require(state == 'APPLIED', 'INTENT_NOT_APPLIED')
                if prefix == 'http-apply':
                    item.update(http_evidence(root, intent, entries[order_id], plan, plan_hash))
                else:
                    require(item['evidenceValid'], 'HTTP_EVIDENCE_INVALID')
                    receipt = receipt_evidence(root, intent, entries[order_id], plan, item if item['http'] else None)
                    item['receipt'] = receipt
                    if not item['http']:
                        item.update(orderNumber=entries[order_id]['orderNumber'], afterHash=receipt['afterHash'],
                                    originalHash=entries[order_id]['rowHash'], previousDevices=entries[order_id]['previousDevices'])
            except Exception as error:
                item['evidenceValid'] = False
                code = str(error) if re.fullmatch(r'[A-Z_]{1,80}', str(error)) else 'EVIDENCE_INVALID'
                issues.setdefault(order_id, []).append(code)
    for item in expected.values():
        item.pop('basis', None)
        for name in ('basisFile', 'sourceAudit', 'sourceAuditSha256', 'httpApplyAuditFile',
                     'beforeHash', 'httpRunId', 'httpStartedAt'):
            item.pop(name, None)
    ordered = sorted(expected.values(), key=lambda value: value['id'])
    if ordered:
        ordered[0]['frozenPlan'] = plan
    return ordered, issues, {key: dict(value) for key, value in counters.items()}


DATABASE_JS = r'''
const crypto=require('crypto');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal=(left,right)=>require('util').isDeepStrictEqual(left,right);
function checkRow(e,r,plan){
  if(!r)return {id:e.id,missing:true,ok:false};
  if(!e.evidenceValid)return {id:e.id,evidenceValid:false,ok:false};
  const fullHashMatches=r.hash===e.afterHash;
  const stableHashMatches=e.http?r.stable===e.stableRowHash:r.original===e.originalHash;
  const identityMatches=r.orderNumber===e.orderNumber;
  const httpPayloadHashMatches=!e.http||hash({...e.httpPayload,plan:plan||e.frozenPlan})===e.httpPayloadHash;
  const originalDevicesHashMatches=!e.http||hash(r.devices)===e.devicesHash;
  let devicesHashMatches=originalDevicesHashMatches;
  let receiptIdsMatch=null,receiptSerialsHashMatches=null,receiptCountsMatch=null,previousDevicesMatch=null,stockBridgesMatch=null;
  if(e.receipt){
    const receipt=e.receipt,ids=r.devices.map(d=>d.id).sort(),serials=r.devices.map(d=>d.serial_number).sort();
    receiptIdsMatch=equal(ids,receipt.deviceIds)&&new Set(ids).size===ids.length;
    receiptSerialsHashMatches=hash(serials)===receipt.serialsHash&&equal(serials,receipt.serials);
    receiptCountsMatch=ids.length===receipt.serials.length&&new Set(serials).size===serials.length;
    previousDevicesMatch=receipt.previousDevices.every(old=>{
      const current=r.devices.find(d=>d.id===old.id);
      if(!current)return false;
      return Object.keys(old).every(k=>k==='stock_unit_id'&&old[k]===null?
        (current[k]===null||typeof current[k]==='string'):equal(old[k],current[k]));
    });
    stockBridgesMatch=r.devices.every(d=>{
      const unit=r.units.find(u=>u.id===d.stock_unit_id);
      return d.order_id===e.id&&!!d.stock_unit_id&&!!unit&&unit.serial_number===d.serial_number&&!unit.order_number_text;
    });
    const postReceiptHttpUnchanged=receipt.sequence!=='RECEIPT_THEN_HTTP'||originalDevicesHashMatches;
    devicesHashMatches=receiptIdsMatch&&receiptSerialsHashMatches&&receiptCountsMatch&&previousDevicesMatch&&stockBridgesMatch&&postReceiptHttpUnchanged;
  }
  return {id:e.id,missing:false,evidenceValid:true,fullHashMatches,stableHashMatches,identityMatches,httpPayloadHashMatches,
    originalDevicesHashMatches,devicesHashMatches,receiptIdsMatch,receiptSerialsHashMatches,receiptCountsMatch,
    previousDevicesMatch,stockBridgesMatch,receipt:!!e.receipt,
    // Binder未保存PickupRecord或StockUnit完整前后值，不把其布尔断言冒充独立比对。
    manualPickupIndependentBaselineMissing:!!e.receipt,stockIndependentBaselineMissing:!!e.receipt,
    ok:fullHashMatches&&stableHashMatches&&identityMatches&&httpPayloadHashMatches&&devicesHashMatches};
}
async function queryReadback(client, expected){
  const checked=[];
  const plan=expected.length?expected[0].frozenPlan:undefined;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
    for(let offset=0;offset<expected.length;offset+=25){
      const group=expected.slice(offset,offset+25);
      const {rows}=await client.query(`SELECT o.id,order_number AS "orderNumber",md5(to_jsonb(o)::text) AS hash,
        md5((to_jsonb(o)-'actual_pickup_date')::text) AS original,
        md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text) AS stable,
        (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM pickup_devices d WHERE d.order_id=o.id) AS devices,
        (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM stock_units s
          WHERE EXISTS(SELECT 1 FROM pickup_devices d WHERE d.order_id=o.id AND d.stock_unit_id=s.id)) AS units
        FROM orders o WHERE id=ANY($1::int[]) ORDER BY id`,[group.map(e=>e.id)]);
      for(const e of group)checked.push(checkRow(e,rows.find(r=>r.id===e.id),plan));
    }
    const {rows}=await client.query(`SELECT count(*)::int AS "pickedUp",
      count(*)FILTER(WHERE actual_pickup_date IS NULL)::int AS "dateMissing",
      count(*)FILTER(WHERE NOT EXISTS(SELECT 1 FROM pickup_devices p WHERE p.order_id=o.id))::int AS "serialMissing",
      count(*)FILTER(WHERE actual_pickup_date IS NULL OR NOT EXISTS(SELECT 1 FROM pickup_devices p WHERE p.order_id=o.id))::int AS "eitherMissing"
      FROM orders o WHERE email_order_status='picked_up'`);
    return {checked,stats:rows[0]};
  }finally{await client.query('ROLLBACK');}
}
'''


def database_script(expected):
    return ('const expected=' + json.dumps(expected, ensure_ascii=True, allow_nan=False) + ';\n' + DATABASE_JS + r'''
const {Client}=require('pg');
if(process.env.NODE_ENV!=='production'||!process.env.DB_HOST||!process.env.DB_NAME||
   /research|study/i.test(process.env.DB_HOST+' '+process.env.DB_NAME))throw Error('DATABASE_INVALID');
const client=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,
 password:process.env.DB_PASSWORD,database:process.env.DB_NAME,connectionTimeoutMillis:8000});
(async()=>{try{await client.connect();process.stdout.write(JSON.stringify(await queryReadback(client,expected)));}
 finally{await client.end();}})().catch(()=>{process.stderr.write('READBACK_FAILED');process.exitCode=1;});
''')


def summarize(expected, issues, counters, result):
    checked = result.get('checked')
    require(isinstance(checked, list) and len(checked) == len(expected) and
            sorted(item.get('id') for item in checked) == [item['id'] for item in expected], 'READBACK_COVERAGE_INVALID')
    failed = sorted(set(issues) | {item['id'] for item in checked if item.get('ok') is not True})
    fields = ('fullHashMatches', 'stableHashMatches', 'identityMatches', 'httpPayloadHashMatches', 'originalDevicesHashMatches', 'devicesHashMatches',
              'receiptIdsMatch', 'receiptSerialsHashMatches', 'receiptCountsMatch', 'previousDevicesMatch', 'stockBridgesMatch')
    return dict(counters, observedAt=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                counts={'expected': len(expected), 'checked': len(checked), 'matched': len(checked) - len(failed),
                        'missingRows': sum(item.get('missing') is True for item in checked),
                        'httpApplied': sum(bool(item.get('http')) for item in expected),
                        'receiptApplied': sum(bool(item.get('receipt')) for item in expected),
                        'receiptAuthorizedDeviceHashChanges': sum(item.get('receipt') is True and item.get('ok') is True and
                                                                 item.get('originalDevicesHashMatches') is False for item in checked),
                        'manualPickupIndependentBaselineMissing': sum(item.get('manualPickupIndependentBaselineMissing') is True for item in checked),
                        'stockIndependentBaselineMissing': sum(item.get('stockIndependentBaselineMissing') is True for item in checked)},
                hashMatchCounts={field: sum(item.get(field) is True for item in checked) for field in fields},
                stats=result.get('stats'), mismatchIds=failed,
                evidenceExceptionIds=sorted(issues), evidenceExceptionCounts=dict(collections.Counter(code for codes in issues.values() for code in codes)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=ROOT)
    args = parser.parse_args()
    locks = []
    try:
        root = pathlib.Path(args.root).resolve()
        # 仅打开既有锁，不创建文件；避免采样/绑定正在覆盖私密证据时读到混合版本。
        for name in ('http-sample.lock', 'http-apply.lock'):
            handle = open(str(root / 'private' / name), 'rb')
            locks.append(handle)
            fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        expected, issues, counters = load_evidence(root)
        response = subprocess.run(['docker', 'exec', '-i', API_CONTAINER, 'node', '-'],
                                  input=database_script(expected).encode('utf-8'), stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, timeout=120)
        require(response.returncode == 0 and len(response.stdout) <= MAX_BYTES, 'READBACK_FAILED')
        output = summarize(expected, issues, counters, json.loads(response.stdout.decode('utf-8')))
        name = 'independent-readback-with-receipts-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.json'
        target = root / 'evidence' / name
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as destination:
            json.dump(output, destination, indent=2, allow_nan=False)
            destination.flush()
            os.fsync(destination.fileno())
        os.chown(str(target), 1000, 1000)
        print(json.dumps(output, ensure_ascii=True, allow_nan=False))
        return 1 if output['mismatchIds'] else 0
    except Exception as error:
        code = str(error) if re.fullmatch(r'[A-Z_]{1,80}', str(error)) else 'READBACK_FAILED'
        print(json.dumps({'outcome': code}))
        return 2
    finally:
        for handle in reversed(locks):
            handle.close()


if __name__ == '__main__':
    raise SystemExit(main())
