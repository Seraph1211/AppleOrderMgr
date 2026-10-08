"""冻结缺 SN 子集的有界顺序采集与绑定；未知结果持久阻断，不轮换代理。"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
import uuid

import runHttpBatch as http
from applyBrowserReceipt import validateBound
from browserFailureQuarantine import verify_failure as verify_browser_failure
from browserFailureClose import verify_failure_close

JOURNALS = ('browser-batch-apply.jsonl', 'browser-batch-dry-run.jsonl')
DEFERRED = frozenset(('ACCOUNT_COOLDOWN', 'LOGIN_COOLDOWN', 'RECEIPT_ATTEMPT_LIMIT'))
MAX_LIMIT = 20


def load(root, name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json', name):
        raise RuntimeError('BROWSER_BATCH_EVIDENCE_INVALID')
    return http.strict_json(http.read_private(root / 'private' / name))


def same(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def check_boundary(root, plan_sha):
    """长只读操作及持久化后再次检查；STOP 与未清理采集容器均禁止新子进程。"""
    if os.path.lexists(str(root / 'private/STOP')):
        raise RuntimeError('BATCH_STOP_REQUESTED')
    if os.path.lexists(str(root / 'private/http-cleanup-blocked.json')):
        raise RuntimeError('BROWSER_BATCH_CLEANUP_PENDING')
    http.check_boundary(root, plan_sha)


def child(command, timeout):
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode or len(result.stdout) > http.MAX_CHILD_BYTES:
            raise ValueError()
        value = http.strict_json(result.stdout.decode('utf-8'))
        if not isinstance(value, dict) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', value.get('outcome', '')):
            raise ValueError()
        return value
    except Exception:
        raise RuntimeError('BROWSER_BATCH_CHILD_FAILED') from None


def http_sources(root, plan, plan_sha):
    """沿用原 HTTP 完整已提交链；所有未知 HTTP 意图或未决日志阻断。"""
    for path in (root / 'private').glob('http-apply-intent-*.json'):
        try:
            if not re.fullmatch(r'http-apply-intent-[1-9][0-9]*\.json', path.name):
                raise ValueError()
            intent = load(root, path.name)
            if not isinstance(intent, dict) or intent.get('state') not in ('APPLIED', 'ROLLED_BACK'):
                raise ValueError()
        except Exception:
            raise RuntimeError('BROWSER_BATCH_RECONCILIATION_REQUIRED') from None
    quarantined = set()
    scope = set(http.validate_plan(plan))
    for name in http.JOURNALS:
        http.journal_state(root / 'private' / name, plan_sha, scope, quarantined=quarantined)
    confirmed = http.confirmed_applies(root, plan, plan_sha)
    sources = {}
    for order_id in confirmed:
        intent = load(root, 'http-apply-intent-' + str(order_id) + '.json')
        result = load(root, intent['resultFile'])
        sources[order_id] = {'basis': 'http-apply-basis-' + str(order_id) + '-run-' + str(intent['runId']) + '.json',
                             'httpSourceAudit': intent['sourceAudit'], 'afterHash': result['afterHash']}
    return sources, quarantined


def confirmed_bindings(root, plan, sources):
    """跳过成功绑定前，重验持久 payload、结果、公共审计及原浏览器关联。"""
    entries = {entry['id']: entry for entry in plan['entries']}
    confirmed = set()
    for path in (root / 'private').glob('browser-receipt-bind-intent-*.json'):
        try:
            intent = load(root, path.name)
            order_id = intent.get('orderId')
            attempt = intent.get('attemptId')
            if (intent.get('state') != 'APPLIED' or not http.valid_int(order_id) or order_id not in entries or
                    path.name != 'browser-receipt-bind-intent-' + str(order_id) + '.json' or
                    not isinstance(attempt, str) or not re.fullmatch(r'[a-f0-9]{32}', attempt)):
                raise ValueError()
            prefix = 'browser-receipt-bind-' + str(order_id) + '-' + attempt
            for field, suffix in (('payloadFile', '-payload.json'), ('resultFile', '-result.json'), ('auditFile', '-audit.json')):
                if intent.get(field) != prefix + suffix:
                    raise ValueError()
            payload = load(root, intent['payloadFile'])
            result = load(root, intent['resultFile'])
            audit = load(root, intent['auditFile'])
            raw = http.read_private(root / 'private' / intent['payloadFile'])
            source = load(root, intent.get('sourceAudit'))
            source_raw = http.read_private(root / 'private' / intent['sourceAudit'])
            entry = dict(entries[order_id])
            if order_id in sources:
                entry['stableRowHash'] = load(root, sources[order_id]['basis'])['stableRowHash']
            if (intent.get('payloadSha256') != hashlib.sha256(raw).hexdigest() or
                    not same(payload.get('entry'), entry) or payload.get('schemaVersion') != 3 or
                    payload.get('scope') != 'missing-fields' or payload.get('cutoff') is not None or
                    payload.get('startedAt') != plan['startedAt'] or
                    intent.get('sourceAudit') != source.get('auditFile') or
                    source.get('targetOrderId') != order_id or source.get('orderId') != order_id or
                    source.get('outcome') != 'SUCCEEDED' or source.get('receiptEgressVerifiedAfter') is not True or
                    source.get('cleanup', {}).get('removed') is not True or
                    payload.get('receipt', {}).get('browserAuditFile') != intent['sourceAudit'] or
                    payload['receipt'].get('browserAuditSha256') != hashlib.sha256(source_raw).hexdigest() or
                    payload['receipt'].get('runId') != intent.get('receiptRunId') or
                    payload['receipt'].get('sha256') != intent.get('receiptSha256') or
                    audit.get('outcome') != 'SERIALS_VERIFIED' or audit.get('mode') != 'apply' or
                    audit.get('resultFile') != intent['resultFile'] or audit.get('payloadFile') != intent['payloadFile'] or
                    audit.get('auditFile') != intent['auditFile'] or
                    any(not same(audit.get(key), value) for key, value in result.items())):
                raise ValueError()
            validateBound(result, payload)
            confirmed.add(order_id)
        except Exception:
            raise RuntimeError('BROWSER_BATCH_RECONCILIATION_REQUIRED') from None
    return confirmed


def check_state(root, plan, plan_sha, sources, quarantined):
    """长查询后重读全部提交意图，其他目标的未知写入也不能越过下一次调用。"""
    check_boundary(root, plan_sha)
    if http_sources(root, plan, plan_sha) != (sources, quarantined):
        raise RuntimeError('BROWSER_BATCH_EVIDENCE_CHANGED')
    confirmed = confirmed_bindings(root, plan, sources)
    check_boundary(root, plan_sha)
    return confirmed


SNAPSHOT_SCRIPT = r'''
const {Client}=require('pg');
let client;
(async()=>{try {
  if(process.env.NODE_ENV!=='production'||!process.env.DB_HOST||!process.env.DB_NAME||
     /research|study/i.test(process.env.DB_HOST+' '+process.env.DB_NAME)) throw Error();
  client=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,database:process.env.DB_NAME,
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,connectionTimeoutMillis:10000});
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='8s'");
  await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
  const {rows}=await client.query(`SELECT o.id,o.order_number AS number,o.email_order_status AS status,
    md5(to_jsonb(o)::text) AS full,md5((to_jsonb(o)-'actual_pickup_date')::text) AS original,
    o.actual_pickup_date::text AS date,(SELECT count(*)::int FROM pickup_devices d WHERE d.order_id=o.id) AS devices
    FROM orders o WHERE o.id=$1`,[EXPECTED.id]);
  const row=rows[0];
  if(rows.length!==1||row.id!==EXPECTED.id||row.number!==EXPECTED.orderNumber||row.status!=='picked_up'||row.devices!==0||
    (EXPECTED.afterHash?row.full!==EXPECTED.afterHash:row.original!==EXPECTED.rowHash||row.date!==EXPECTED.previousDate)) throw Error();
  await client.query('ROLLBACK');
  process.stdout.write(JSON.stringify({outcome:'BROWSER_BATCH_SNAPSHOT_VERIFIED',orderId:EXPECTED.id}));
}catch(error){process.stderr.write('BROWSER_BATCH_SNAPSHOT_INVALID');process.exitCode=1;}
finally{if(client)await client.end().catch(()=>{});}})();
'''


def verify_snapshot(root, entry, source):
    expected = {'id': entry['id'], 'orderNumber': entry['orderNumber'], 'rowHash': entry['rowHash'],
                'previousDate': entry['previousDate']}
    if source:
        expected['afterHash'] = source['afterHash']
    elif entry['dateMissing'] or not entry['serialsMissing'] or entry['previousDevices']:
        raise RuntimeError('BROWSER_BATCH_SCOPE_INVALID')
    script = ('const EXPECTED=' + json.dumps(expected, ensure_ascii=True) + ';\n' + SNAPSHOT_SCRIPT).encode('utf-8')
    try:
        result = subprocess.run(['docker', 'exec', '-i', 'apple-order-mgr-prod-api-1', 'node', '-'],
                                input=script, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if (result.returncode or len(result.stdout) > 4096 or
                not same(http.strict_json(result.stdout.decode('utf-8')),
                         {'outcome': 'BROWSER_BATCH_SNAPSHOT_VERIFIED', 'orderId': entry['id']})):
            raise ValueError()
    except Exception:
        raise RuntimeError('BROWSER_BATCH_SNAPSHOT_INVALID') from None


def validate_sample(root, sample, order_id, proxy, plan_sha, current=False):
    """新预检仅接受 v2；历史预检沿用其版本阈值，收据仍交原 verifier 重验。"""
    try:
        attempt = sample.get('attemptId')
        name = 'browser-sample-' + str(order_id) + '-' + str(attempt) + '.json'
        if (not isinstance(attempt, str) or not re.fullmatch(r'[a-f0-9]{32}', attempt) or
                type(sample.get('targetOrderId')) is not int or sample['targetOrderId'] != order_id or
                type(sample.get('proxyIndex')) is not int or sample['proxyIndex'] != proxy or
                sample.get('auditFile') != name or not same(load(root, name), sample) or
                type(sample.get('businessWrites')) is not int or sample['businessWrites'] != 0 or
                sample.get('bootstrapMode') != 'native-browser' or sample.get('persistSessions') is not False or
                not http.valid_time(sample.get('startedAt')) or not http.valid_time(sample.get('finishedAt')) or
                not sample['startedAt'] <= sample['finishedAt'] <= time.time()):
            raise ValueError()
        if sample.get('preflightOnly') is True:
            keys = {'outcome', 'requests', 'preflightOnly', 'preflight', 'attemptId', 'targetOrderId', 'proxyIndex',
                    'bootstrapMode', 'persistSessions', 'startedAt', 'finishedAt', 'egressHash', 'egressAfterHash',
                    'egressVerifiedAfter', 'businessWrites', 'cleanup', 'proxyHash', 'auditFile', 'receiptEgressVerifiedAfter'}
            pre = sample['preflight']
            if (set(sample) != keys or not isinstance(pre, dict) or set(pre) != {'version', 'mode', 'requiredAttempts',
                    'outcome', 'orderId', 'checkedAt', 'planSha256', 'inputSha256', 'accountPaused', 'loginPaused', 'attempts'} or
                    pre.get('mode') != 'browser' or type(pre.get('version')) is not int or pre['version'] not in (1, 2) or
                    (current and pre['version'] != 2) or
                    type(pre.get('requiredAttempts')) is not int or pre['requiredAttempts'] != 2 or
                    type(pre.get('orderId')) is not int or pre['orderId'] != order_id or
                    pre.get('planSha256') != plan_sha or not http.valid_hash(pre.get('inputSha256')) or
                    type(pre.get('accountPaused')) is not bool or type(pre.get('loginPaused')) is not bool or
                    type(pre.get('attempts')) is not int or pre['attempts'] < 0 or not http.valid_time(pre.get('checkedAt')) or
                    not sample['startedAt'] <= pre['checkedAt'] <= sample['finishedAt'] or
                    type(sample.get('requests')) is not int or sample['requests'] != 0 or
                    sample.get('egressHash') is not None or sample.get('egressAfterHash') is not None or
                    sample.get('proxyHash') is not None or sample.get('egressVerifiedAfter') is not False or
                    sample.get('receiptEgressVerifiedAfter') is not False or
                    not same(sample['cleanup'], {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'})):
                raise ValueError()
            attempt_limit = 2 if pre['version'] == 1 else 9
            reason = ('ACCOUNT_COOLDOWN' if pre['accountPaused'] else 'LOGIN_COOLDOWN' if pre['loginPaused'] else
                      'RECEIPT_ATTEMPT_LIMIT' if pre['attempts'] >= attempt_limit else 'BROWSER_PREFLIGHT_ALLOWED')
            if sample['outcome'] != reason or pre['outcome'] != reason or reason not in DEFERRED:
                raise ValueError()
            return 'DEFERRED'
        if ('preflight' in sample or 'preflightOnly' in sample or sample.get('outcome') != 'SUCCEEDED' or
                type(sample.get('orderId')) is not int or sample['orderId'] != order_id or
                not http.valid_int(sample.get('runId')) or sample.get('detailRunId') != sample['runId'] or
                not http.valid_int(sample.get('receiptRunId')) or sample['receiptRunId'] == sample['runId'] or
                sample.get('receiptOutcome') != 'RECEIPT_CAPTURED' or sample.get('receiptEgressVerifiedAfter') is not True or
                sample.get('egressVerifiedAfter') is not True or not http.valid_hash(sample.get('egressHash')) or
                sample.get('egressAfterHash') != sample['egressHash'] or
                sample.get('cleanup', {}).get('removed') is not True):
            raise ValueError()
        return 'RECEIPT_READY'
    except Exception:
        raise RuntimeError('BROWSER_BATCH_SAMPLE_INVALID') from None


def journal_state(root, name, plan_sha, scope, confirmed, pending=None, quarantined=None):
    path = root / 'private' / name
    closed = {}
    quarantined = set() if quarantined is None else quarantined
    if not os.path.lexists(str(path)):
        return closed
    try:
        raw = http.read_private(path)
        if not raw.endswith(b'\n'):
            raise ValueError()
        active = sample = None
        attempts = set()
        for line in raw.decode('utf-8').splitlines():
            row = http.strict_json(line)
            if (row.get('planSha256') != plan_sha or not http.valid_int(row.get('orderId')) or row['orderId'] not in scope or
                    not isinstance(row.get('batchAttemptId'), str) or not re.fullmatch(r'[a-f0-9]{32}', row['batchAttemptId']) or
                    not http.valid_time(row.get('at')) or row['at'] > time.time()):
                raise ValueError()
            key = (row['orderId'], row['batchAttemptId'])
            if row.get('event') == 'target_started':
                if active or row['orderId'] in closed or row['orderId'] in quarantined or row['batchAttemptId'] in attempts:
                    raise ValueError()
                active = row
                sample = None
                attempts.add(row['batchAttemptId'])
            elif row.get('event') == 'sample_finished':
                if not active or sample or key != (active['orderId'], active['batchAttemptId']):
                    raise ValueError()
                sample = row['sample']
                validate_sample(root, sample, row['orderId'], active['proxyIndex'], plan_sha)
                if row.get('auditSha256') != hashlib.sha256(http.read_private(root / 'private' / sample['auditFile'])).hexdigest():
                    raise ValueError()
            elif row.get('event') == 'target_finished':
                if not active or not sample or key != (active['orderId'], active['batchAttemptId']):
                    raise ValueError()
                applying = name == JOURNALS[0]
                if sample.get('preflightOnly') is True:
                    if row.get('outcome') != 'DEFERRED' or row.get('targetCompleted') is not False or row.get('apply') is not None:
                        raise ValueError()
                else:
                    result = row.get('apply')
                    expected = 'SERIALS_VERIFIED' if applying else 'DRY_RUN'
                    if (not isinstance(result, dict) or result.get('outcome') != expected or row.get('outcome') != expected or
                            result.get('orderId') != row['orderId'] or result.get('receiptRunId') != sample['receiptRunId'] or
                            result.get('mode') != ('apply' if applying else 'dry-run') or
                            row.get('targetCompleted') is not applying or not same(load(root, result['auditFile']), result) or
                            (applying and row['orderId'] not in confirmed)):
                        raise ValueError()
                closed[row['orderId']] = {'sample': sample, 'source': active.get('source'), 'outcome': row['outcome']}
                active = sample = None
            elif row.get('event') == 'failed_read_only_closed':
                if (not active or sample is not None or key != (active['orderId'], active['batchAttemptId']) or
                        row['orderId'] in confirmed or row['orderId'] in quarantined or
                        set(row) != {'orderId', 'planSha256', 'batchAttemptId', 'proxyIndex', 'source', 'event', 'at',
                            'sampleAttemptId', 'detailRunId', 'receiptRunId', 'phase', 'proofFile', 'proofSha256',
                            'sampleAuditSha256', 'verification', 'targetCompleted', 'apply', 'outcome',
                            'businessWrites', 'processExitVerified'} or
                        not same(row['source'], active.get('source')) or not same(row['proxyIndex'], active.get('proxyIndex')) or
                        row['phase'] != 'DETAIL_READY_RECEIPT_FAILED' or row['outcome'] != 'FAILED' or
                        row['targetCompleted'] is not False or row['apply'] is not None or
                        row['processExitVerified'] is not False or type(row['businessWrites']) is not int or row['businessWrites'] != 0):
                    raise ValueError()
                evidence = verify_failure_close(root, plan_sha, active, row['sampleAttemptId'],
                    row['proofFile'], row['proofSha256'], row['at'], expected=row['verification'])
                if any(not same(evidence.get(field), row[field]) for field in
                       ('detailRunId', 'receiptRunId', 'sampleAuditSha256', 'phase')):
                    raise ValueError()
                closed[row['orderId']] = {'sample': None, 'source': active.get('source'), 'outcome': 'FAILED',
                                          'verification': evidence}
                active = sample = None
            elif row.get('event') == 'failed_read_only_quarantined':
                if (not active or sample is not None or key != (active['orderId'], active['batchAttemptId']) or
                        row['orderId'] in confirmed or row['orderId'] in quarantined or
                        set(row) != {'orderId', 'planSha256', 'batchAttemptId', 'proxyIndex', 'source', 'event', 'at',
                                     'sampleAttemptId', 'runId', 'resolution', 'proofFile', 'proofSha256', 'verification',
                                     'targetCompleted', 'egressVerifiedAfter', 'businessWrites'} or
                        not same(row['source'], active.get('source')) or not same(row['proxyIndex'], active.get('proxyIndex')) or
                        row['resolution'] != 'FAILED_BEFORE_PASSWORD_WITH_CHANGED_EGRESS' or
                        row['targetCompleted'] is not False or row['egressVerifiedAfter'] is not False or
                        type(row['businessWrites']) is not int or row['businessWrites'] != 0 or
                        not http.valid_int(row['runId'])):
                    raise ValueError()
                evidence = verify_browser_failure(root, plan_sha, active, row['sampleAttemptId'],
                    row['proofFile'], row['proofSha256'], row['at'], expected=row['verification'])
                if not same(evidence.get('runId'), row['runId']):
                    raise ValueError()
                quarantined.add(row['orderId'])
                active = sample = None
            else:
                raise ValueError()
        if active:
            if pending is None:
                raise ValueError()
            pending.update(started=active, sample=sample)
        return closed
    except Exception:
        raise RuntimeError('BROWSER_BATCH_RECONCILIATION_REQUIRED') from None


def execute(root, ids=None, limit=1, apply=False, proxy_index=0):
    root = pathlib.Path(root)
    if not root.is_absolute() or not (root / 'private').is_dir() or (root / 'private').is_symlink():
        raise RuntimeError('INPUT_INVALID')
    root = root.resolve(strict=True)
    descriptor = os.open(str(root / 'private/http-batch.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('HTTP_BATCH_BUSY')
        raw = http.read_private(root / 'private/plan.json')
        plan = http.strict_json(raw)
        scope = set(http.validate_plan(plan))
        plan_sha = hashlib.sha256(raw).hexdigest()
        if (not http.valid_int(limit) or limit > MAX_LIMIT or not http.valid_int(proxy_index, 0) or
                (ids is not None and (not ids or len(ids) != len(set(ids)) or any(not http.valid_int(i) or i not in scope for i in ids)))):
            raise RuntimeError('BROWSER_BATCH_SCOPE_INVALID')
        sources, quarantined = http_sources(root, plan, plan_sha)
        confirmed = confirmed_bindings(root, plan, sources)
        browser_quarantined = set()
        states = {name: journal_state(root, name, plan_sha, scope, confirmed, quarantined=browser_quarantined)
                  for name in JOURNALS}
        if browser_quarantined.intersection(confirmed | set().union(*(set(value) for value in states.values()))):
            raise RuntimeError('BROWSER_BATCH_RECONCILIATION_REQUIRED')
        excluded = quarantined | browser_quarantined
        failed_closed = {order_id for state in states.values() for order_id, value in state.items()
                         if value.get('outcome') == 'FAILED'}
        if ids and failed_closed.intersection(ids):
            raise RuntimeError('BATCH_TARGET_FAILED_NO_RETRY')
        if ids and excluded.intersection(ids):
            raise RuntimeError('BATCH_TARGET_QUARANTINED')
        entries = {entry['id']: entry for entry in plan['entries']}
        eligible = [entry['id'] for entry in plan['entries'] if entry['serialsMissing'] and
                    (entry['id'] in sources or not entry['dateMissing']) and entry['id'] not in excluded]
        if ids is not None and not set(ids).issubset(set(eligible)):
            raise RuntimeError('BROWSER_BATCH_SCOPE_INVALID')
        selected = eligible if ids is None else ids
        journal = root / 'private' / JOURNALS[0 if apply else 1]
        processed = succeeded = deferred = 0
        for order_id in selected:
            if (order_id in confirmed or order_id in states[journal.name] or
                    any(state.get(order_id, {}).get('outcome') in ('DEFERRED', 'FAILED') for state in states.values())):
                continue
            if processed >= limit:
                break
            latest_confirmed = check_state(root, plan, plan_sha, sources, quarantined)
            if order_id in latest_confirmed:
                continue
            source = sources.get(order_id)
            verify_snapshot(root, entries[order_id], source)
            if order_id in check_state(root, plan, plan_sha, sources, quarantined):
                continue
            record = {'orderId': order_id, 'planSha256': plan_sha, 'batchAttemptId': uuid.uuid4().hex,
                      'proxyIndex': proxy_index, 'source': source}
            http.append(journal, dict(record, event='target_started', at=time.time()))
            old_dry = states[JOURNALS[1]].get(order_id) if apply else None
            if old_dry and old_dry['outcome'] == 'DRY_RUN':
                if not same(old_dry['source'], source):
                    raise RuntimeError('BROWSER_BATCH_EVIDENCE_CHANGED')
                sample = old_dry['sample']
            else:
                if order_id in check_state(root, plan, plan_sha, sources, quarantined):
                    raise RuntimeError('BROWSER_BATCH_EVIDENCE_CHANGED')
                sample = child(['python3', str(root / 'release/scripts/officialOrder/runBrowserSample.py'),
                    '--root', str(root), '--id', str(order_id), '--proxy-index', str(proxy_index), '--native-browser'], 420)
            audit_name = sample.get('auditFile')
            classification = validate_sample(root, sample, order_id, proxy_index, plan_sha, current=True)
            if sample.get('preflightOnly') is True and sample['preflight']['inputSha256'] != hashlib.sha256(
                    http.read_private(root / ('private/request-' + str(order_id) + '.json'))).hexdigest():
                raise RuntimeError('BROWSER_BATCH_SAMPLE_INVALID')
            http.append(journal, dict(record, event='sample_finished', at=time.time(), sample=sample,
                auditSha256=hashlib.sha256(http.read_private(root / 'private' / audit_name)).hexdigest()))
            result = None
            outcome = 'DEFERRED'
            if classification == 'RECEIPT_READY':
                if order_id in check_state(root, plan, plan_sha, sources, quarantined):
                    raise RuntimeError('BROWSER_BATCH_EVIDENCE_CHANGED')
                verify_snapshot(root, entries[order_id], source)
                if order_id in check_state(root, plan, plan_sha, sources, quarantined):
                    raise RuntimeError('BROWSER_BATCH_EVIDENCE_CHANGED')
                command = ['python3', str(root / 'release/scripts/officialOrder/applyBrowserReceipt.py'),
                           '--root', str(root), '--audit', audit_name]
                if source:
                    command.extend(['--basis', source['basis'], '--http-source-audit', source['httpSourceAudit']])
                if apply:
                    command.append('--apply')
                if order_id in check_state(root, plan, plan_sha, sources, quarantined):
                    raise RuntimeError('BROWSER_BATCH_EVIDENCE_CHANGED')
                result = child(command, 150)
                outcome = 'SERIALS_VERIFIED' if apply else 'DRY_RUN'
                if (result.get('outcome') != outcome or result.get('orderId') != order_id or
                        result.get('receiptRunId') != sample['receiptRunId'] or result.get('mode') != ('apply' if apply else 'dry-run') or
                        not same(load(root, result.get('auditFile')), result)):
                    raise RuntimeError('BROWSER_BATCH_APPLY_STOPPED')
                if apply and order_id not in confirmed_bindings(root, plan, sources):
                    raise RuntimeError('BROWSER_BATCH_APPLY_STOPPED')
                succeeded += 1
            else:
                deferred += 1
            http.append(journal, dict(record, event='target_finished', at=time.time(), outcome=outcome,
                                     targetCompleted=apply and outcome == 'SERIALS_VERIFIED', apply=result))
            processed += 1
        return {'outcome': 'BROWSER_BATCH_PASS_FINISHED', 'processedThisRun': processed,
                'verifiedThisRun': succeeded, 'deferredThisRun': deferred, 'mode': 'apply' if apply else 'dry-run',
                'previouslyConfirmedBindings': len(confirmed.intersection(selected)),
                'failedReadOnlyOrderIds': sorted(failed_closed),
                'quarantinedOrderIds': sorted(excluded), 'allFieldsComplete': False}


def quarantine_failed_read(root, journal_name, order_id, batch_attempt, sample_attempt, proof_name, proof_sha):
    """明确核验未提交密码的代理失败，只隔离原未决目标而不标为完成或重试。"""
    root = pathlib.Path(root)
    if (not root.is_absolute() or not (root / 'private').is_dir() or (root / 'private').is_symlink() or
            journal_name not in JOURNALS or not http.valid_int(order_id) or
            any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value)
                for value in (batch_attempt, sample_attempt)) or
            proof_name != 'browser-failure-proof-' + str(order_id) + '-' + sample_attempt + '.json' or
            not http.valid_hash(proof_sha)):
        raise RuntimeError('BROWSER_BATCH_QUARANTINE_ARGUMENT_INVALID')
    root = root.resolve(strict=True)
    with contextlib.ExitStack() as stack:
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            descriptor = os.open(str(root / 'private' / name), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            lock = stack.enter_context(os.fdopen(descriptor, 'a'))
            os.fchmod(lock.fileno(), 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('BROWSER_BATCH_RECONCILIATION_BUSY')
        raw = http.read_private(root / 'private/plan.json')
        plan = http.strict_json(raw)
        scope = set(http.validate_plan(plan))
        plan_sha = hashlib.sha256(raw).hexdigest()
        if (order_id not in scope or
                next(entry for entry in plan['entries'] if entry['id'] == order_id)['serialsMissing'] is not True):
            raise RuntimeError('BROWSER_BATCH_SCOPE_INVALID')
        check_boundary(root, plan_sha)
        sources, http_quarantined = http_sources(root, plan, plan_sha)
        confirmed = confirmed_bindings(root, plan, sources)
        if order_id in http_quarantined or order_id in confirmed or order_id not in sources:
            raise RuntimeError('BROWSER_BATCH_FAILURE_QUARANTINE_DENIED')
        pending = {}
        quarantined = set()
        closed = {}
        for name in JOURNALS:
            closed.update(journal_state(root, name, plan_sha, scope, confirmed,
                pending=pending if name == journal_name else None, quarantined=quarantined))
        started = pending.get('started')
        if (order_id in closed or order_id in quarantined or pending.get('sample') is not None or
                not isinstance(started, dict) or started.get('orderId') != order_id or
                started.get('batchAttemptId') != batch_attempt or not same(started.get('source'), sources[order_id])):
            raise RuntimeError('BROWSER_BATCH_FAILURE_QUARANTINE_DENIED')
        original_journals = {name: http.read_private(root / 'private' / name)
                             if os.path.lexists(str(root / 'private' / name)) else None for name in JOURNALS}
        at = time.time()
        evidence = verify_browser_failure(root, plan_sha, started, sample_attempt, proof_name, proof_sha, at)
        # 核验容器可异步运行；持久追加前不得越过新 STOP、清理失败、源链改变或未知写入。
        if order_id in check_state(root, plan, plan_sha, sources, http_quarantined):
            raise RuntimeError('BROWSER_BATCH_FAILURE_QUARANTINE_DENIED')
        for name, previous in original_journals.items():
            path = root / 'private' / name
            if previous != (http.read_private(path) if os.path.lexists(str(path)) else None):
                raise RuntimeError('BROWSER_BATCH_RECONCILIATION_REQUIRED')
        event = dict(started, event='failed_read_only_quarantined', at=at, sampleAttemptId=sample_attempt,
                     runId=evidence['runId'], resolution='FAILED_BEFORE_PASSWORD_WITH_CHANGED_EGRESS',
                     proofFile=proof_name, proofSha256=proof_sha, verification=evidence,
                     targetCompleted=False, egressVerifiedAfter=False, businessWrites=0)
        http.append(root / 'private' / journal_name, event)
        journal_state(root, journal_name, plan_sha, scope, confirmed)
        return {'outcome': 'BROWSER_BATCH_FAILURE_QUARANTINED', 'orderId': order_id, 'runId': evidence['runId'],
                'journal': journal_name, 'proofFile': proof_name, 'proofSha256': proof_sha,
                'targetCompleted': False, 'egressVerifiedAfter': False, 'businessWrites': 0, 'allFieldsComplete': False}


def close_failed_read(root, journal_name, order_id, batch_attempt, sample_attempt, proof_name, proof_sha):
    """显式关闭详情成功且收据被守卫拒绝的失败；不采集、绑定或重放密码。"""
    root = pathlib.Path(root)
    if (not root.is_absolute() or not (root / 'private').is_dir() or (root / 'private').is_symlink() or
            journal_name not in JOURNALS or not http.valid_int(order_id) or
            any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value)
                for value in (batch_attempt, sample_attempt)) or
            proof_name != 'browser-failure-close-proof-' + str(order_id) + '-' + sample_attempt + '.json' or
            not http.valid_hash(proof_sha)):
        raise RuntimeError('BROWSER_BATCH_FAILURE_CLOSE_ARGUMENT_INVALID')
    root = root.resolve(strict=True)
    with contextlib.ExitStack() as stack:
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            descriptor = os.open(str(root / 'private' / name), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            lock = stack.enter_context(os.fdopen(descriptor, 'a'))
            os.fchmod(lock.fileno(), 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('BROWSER_BATCH_RECONCILIATION_BUSY')
        raw = http.read_private(root / 'private/plan.json')
        plan = http.strict_json(raw)
        scope = set(http.validate_plan(plan))
        plan_sha = hashlib.sha256(raw).hexdigest()
        if (order_id not in scope or
                next(entry for entry in plan['entries'] if entry['id'] == order_id)['serialsMissing'] is not True):
            raise RuntimeError('BROWSER_BATCH_SCOPE_INVALID')
        check_boundary(root, plan_sha)
        sources, http_quarantined = http_sources(root, plan, plan_sha)
        confirmed = confirmed_bindings(root, plan, sources)
        if order_id in http_quarantined or order_id in confirmed or order_id not in sources:
            raise RuntimeError('BROWSER_BATCH_FAILURE_CLOSE_DENIED')
        pending = {}
        quarantined = set()
        closed = {}
        for name in JOURNALS:
            closed.update(journal_state(root, name, plan_sha, scope, confirmed,
                pending=pending if name == journal_name else None, quarantined=quarantined))
        started = pending.get('started')
        if (order_id in closed or order_id in quarantined or pending.get('sample') is not None or
                not isinstance(started, dict) or started.get('orderId') != order_id or
                started.get('batchAttemptId') != batch_attempt or not same(started.get('source'), sources[order_id])):
            raise RuntimeError('BROWSER_BATCH_FAILURE_CLOSE_DENIED')
        original_journals = {name: http.read_private(root / 'private' / name)
                             if os.path.lexists(str(root / 'private' / name)) else None for name in JOURNALS}
        at = time.time()
        evidence = verify_failure_close(root, plan_sha, started, sample_attempt, proof_name, proof_sha, at)
        # 核验容器可异步运行；持久追加前不得越过新 STOP、清理失败、源链改变或未知写入。
        if order_id in check_state(root, plan, plan_sha, sources, http_quarantined):
            raise RuntimeError('BROWSER_BATCH_FAILURE_CLOSE_DENIED')
        for name, previous in original_journals.items():
            path = root / 'private' / name
            if previous != (http.read_private(path) if os.path.lexists(str(path)) else None):
                raise RuntimeError('BROWSER_BATCH_RECONCILIATION_REQUIRED')
        closed_at = time.time()
        proof_raw = http.read_private(root / 'private' / proof_name)
        fresh_proof = http.strict_json(proof_raw)
        if (hashlib.sha256(proof_raw).hexdigest() != proof_sha or
                any(not http.valid_time(value) or not 0 <= closed_at - value <= 300 for value in
                    (fresh_proof.get('observedAt'), fresh_proof.get('business', {}).get('queriedAt'),
                     fresh_proof.get('research', {}).get('queriedAt')))):
            raise RuntimeError('BROWSER_BATCH_FAILURE_CLOSE_DENIED')
        http.validate_plan(plan)
        check_boundary(root, plan_sha)
        event = dict(started, event='failed_read_only_closed', at=closed_at, sampleAttemptId=sample_attempt,
                     detailRunId=evidence['detailRunId'], receiptRunId=evidence['receiptRunId'],
                     phase='DETAIL_READY_RECEIPT_FAILED', proofFile=proof_name, proofSha256=proof_sha,
                     sampleAuditSha256=evidence['sampleAuditSha256'], verification=evidence,
                     outcome='FAILED', targetCompleted=False, apply=None, businessWrites=0, processExitVerified=False)
        http.append(root / 'private' / journal_name, event)
        journal_state(root, journal_name, plan_sha, scope, confirmed)
        return {'outcome': 'BROWSER_BATCH_FAILURE_CLOSED', 'orderId': order_id,
                'detailRunId': evidence['detailRunId'], 'receiptRunId': evidence['receiptRunId'],
                'journal': journal_name, 'proofFile': proof_name, 'proofSha256': proof_sha,
                'phase': 'DETAIL_READY_RECEIPT_FAILED', 'targetCompleted': False, 'processExitVerified': False,
                'businessWrites': 0, 'allFieldsComplete': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--ids')
    parser.add_argument('--limit', type=int, default=1)
    parser.add_argument('--proxy-index', type=int)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--quarantine-failed-read', action='store_true')
    parser.add_argument('--close-failed-read', action='store_true')
    parser.add_argument('--journal', choices=('apply', 'dry-run'))
    parser.add_argument('--order-id', type=int)
    parser.add_argument('--batch-attempt-id')
    parser.add_argument('--sample-attempt-id')
    parser.add_argument('--proof')
    parser.add_argument('--proof-sha256')
    args = parser.parse_args()
    try:
        quarantine_values = (args.journal, args.order_id, args.batch_attempt_id, args.sample_attempt_id, args.proof, args.proof_sha256)
        if args.close_failed_read:
            if (args.quarantine_failed_read or not all(value is not None for value in quarantine_values) or
                    args.ids is not None or args.apply or args.proxy_index is not None or args.limit != 1):
                raise RuntimeError('BROWSER_BATCH_FAILURE_CLOSE_ARGUMENT_INVALID')
            result = close_failed_read(args.root, JOURNALS[0 if args.journal == 'apply' else 1],
                args.order_id, args.batch_attempt_id, args.sample_attempt_id, args.proof, args.proof_sha256)
        elif args.quarantine_failed_read:
            if (not all(value is not None for value in quarantine_values) or args.ids is not None or
                    args.apply or args.proxy_index is not None or args.limit != 1):
                raise RuntimeError('BROWSER_BATCH_QUARANTINE_ARGUMENT_INVALID')
            result = quarantine_failed_read(args.root, JOURNALS[0 if args.journal == 'apply' else 1],
                args.order_id, args.batch_attempt_id, args.sample_attempt_id, args.proof, args.proof_sha256)
        else:
            if any(value is not None for value in quarantine_values) or args.proxy_index is None:
                raise RuntimeError('BROWSER_BATCH_SCOPE_INVALID')
            if args.ids is not None and not re.fullmatch(r'[1-9]\d*(?:,[1-9]\d*)*', args.ids):
                raise RuntimeError('BROWSER_BATCH_SCOPE_INVALID')
            result = execute(args.root, [int(value) for value in args.ids.split(',')] if args.ids else None,
                             args.limit, args.apply, args.proxy_index)
    except Exception as error:
        code = str(error)
        result = {'outcome': code if re.fullmatch(r'(?:BROWSER_BATCH_|BATCH_|BACKFILL_|HTTP_BATCH_)[A-Z_]{1,80}', code)
                  else 'BROWSER_BATCH_FAILED', 'allFieldsComplete': False}
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
