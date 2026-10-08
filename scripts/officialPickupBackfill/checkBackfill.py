#!/usr/bin/env python3
"""只读核对限定补录计划、日期与非目标字段，输出脱敏计数。"""
import collections
import json
import pathlib
import subprocess
import time
import os
from runtime import records, readJson, threeFieldScope, IMAGE

root = pathlib.Path(os.environ.get('OFFICIAL_BACKFILL_ROOT', '/var/www/apple-order-mgr/shared/official-pickup-backfill-20261007'))
plan = readJson(root / ('private/status-plan.json' if (root / 'private/status-plan.json').exists() else 'private/plan.json'))
applied = records(root / 'private/applied.jsonl')
processed = records(root / 'private/processed.jsonl')
query = """const{Client}=require('pg');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',async()=>{const c=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});try{await c.connect();await c.query('BEGIN READ ONLY');const ids=JSON.parse(raw);const r=await c.query(\"SELECT id,actual_pickup_date::text AS date,md5((to_jsonb(o)-'actual_pickup_date')::text) AS hash,md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text) AS stable,official_raw_status AS status,official_status_observed_at AS observed FROM orders o WHERE id=ANY($1::int[])\",[ids]);process.stdout.write(JSON.stringify(r.rows));}catch(e){process.stderr.write(e.code||e.name);process.exitCode=1;}finally{await c.query('ROLLBACK');await c.end();}});"""
result = subprocess.run(['docker', 'exec', '-i', 'apple-order-mgr-prod-api-1', 'node', '-e', query],
                        input=json.dumps([e['id'] for e in plan['entries']]).encode(),
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
rows = {e['id']: e for e in json.loads(result.stdout)}
filled = {e['orderId']: e for e in applied if e.get('outcome') in ('FILLED', 'UPDATED')}
issues = []
for entry in plan['entries']:
    row = rows.get(entry['id'])
    if not row:
        issues.append({'orderId': entry['id'], 'issue': 'ROW_MISSING'})
    elif entry.get('stableRowHash') and row['stable'] != entry['stableRowHash']:
        issues.append({'orderId': entry['id'], 'issue': 'NON_TARGET_FIELDS_CHANGED'})
    elif entry['id'] in filled:
        audit = filled[entry['id']]
        if (not entry.get('stableRowHash') and row['hash'] != audit['afterHash']) or row['date'] != audit['date']:
            issues.append({'orderId': entry['id'], 'issue': 'FILLED_ROW_CHANGED_SINCE_APPLY'})
    elif not entry.get('stableRowHash') and row['hash'] != entry['rowHash']:
        issues.append({'orderId': entry['id'], 'issue': 'UNPROCESSED_ROW_CHANGED'})
attempts = {e['orderId']: e for e in applied + processed}
last_proxy_failure = {item['orderId']: index for index, item in enumerate(processed)
                      if item['outcome'] in ('PROXY_CONNECTION_FAILED', 'HTTP_541')}
recovered_proxy_orders = {item['orderId'] for index, item in enumerate(processed)
                          if item['orderId'] in last_proxy_failure and index > last_proxy_failure[item['orderId']]
                          and item['outcome'] in ('FILLED', 'ALREADY_HAS_DATE')}
report = {'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
          'total': len(plan['entries']), 'auditFilled': len(filled),
          'databaseFilled': sum(bool(e['date']) for e in rows.values()),
          'remainingNull': sum(not e['date'] for e in rows.values()),
          'attemptOutcomes': dict(collections.Counter(e['outcome'] for e in attempts.values())),
          'outcomeMeaning': 'latest result per order; historical failures retained separately',
          'historicalFailureCounts': dict(collections.Counter(e['outcome'] for e in processed
                                           if e['outcome'] not in ('FILLED', 'ALREADY_HAS_DATE'))),
          'recoveredAfterProxyRetry': len(recovered_proxy_orders),
          'issues': issues}
receipt_path = root / 'private/receipt-applied.jsonl'
receipt_latest = {}
if receipt_path.exists():
    for item in records(receipt_path):
        receipt_latest[item['orderId']] = item
verified = {item['orderId']: item for item in records(receipt_path) if item.get('outcome') == 'SERIALS_VERIFIED'}
receipt_query = """const{Client}=require('pg');const crypto=require('crypto');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',async()=>{const c=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});try{await c.connect();const ids=JSON.parse(raw);const r=await c.query('SELECT order_id AS id,serial_number AS serial,stock_unit_id AS unit FROM pickup_devices WHERE order_id=ANY($1::int[])',[ids]);process.stdout.write(JSON.stringify(ids.map(id=>{const rows=r.rows.filter(row=>row.id===id);return{id,count:rows.length,linkedUnits:rows.filter(row=>row.unit).length,serialsHash:crypto.createHash('sha256').update(JSON.stringify(rows.map(row=>row.serial).sort())).digest('hex')};})));}finally{await c.end();}});"""
receipt_result = subprocess.run(['docker','exec','-i','apple-order-mgr-prod-api-1','node','-e',receipt_query],
                                input=json.dumps(list(verified)).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=30, check=True)
receipt_rows = json.loads(receipt_result.stdout)
receipt_issues = []
for row in receipt_rows:
    audit = verified[row['id']]
    if row['count'] != audit['serialCount'] or row['serialsHash'] != audit['serialsHash'] or row['linkedUnits'] != row['count']:
        receipt_issues.append({'orderId':row['id'],'issue':'RECEIPT_BINDING_READBACK_CHANGED'})
report['receiptConfirmedOrders'] = len(verified)
report['receiptConfirmedSerials'] = sum(item['serialCount'] for item in verified.values())
unique_bindings = {(item['orderId'], item.get('receiptRunId')): item for item in records(receipt_path) if item.get('newBindings', 0)}
report['receiptNewBindings'] = sum(item.get('newBindings',0) for item in unique_bindings.values())
report['receiptOutcomes'] = dict(collections.Counter(item['outcome'] for item in receipt_latest.values()))
report['receiptIssues'] = receipt_issues
report['issues'].extend(receipt_issues)
status_audits = {item['orderId']: item for item in applied if item.get('statusSaved')}
status_verified = 0
for order_id, audit in status_audits.items():
    row = rows.get(order_id, {})
    if row.get('status') == audit['officialRawStatus'] and row.get('observed') == audit['officialStatusObservedAt']:
        status_verified += 1
    elif not row.get('observed') or row['observed'] <= audit['officialStatusObservedAt']:
        report['issues'].append({'orderId': order_id, 'issue': 'STATUS_READBACK_MISMATCH'})
report['officialStatusVerified'] = status_verified
filled_ids = {key for key, row in rows.items() if row['date']}
deferred = {e['orderId']: e for e in records(root / 'private/deferred.jsonl')}
failed_ids = (set(attempts) | set(deferred)) - filled_ids
report['dateClassification'] = {'filled': len(filled_ids), 'failedOrDeferred': len(failed_ids),
                                'unprocessed': len(plan['entries']) - len(filled_ids | set(attempts) | set(deferred))}
if threeFieldScope(plan):
    # 守护中断可能来不及写本地 processed；从研究库回读真实尝试，不误报为从未处理。
    research_query = """const fs=require('fs');const{Client}=require('pg');const c=new Client(JSON.parse(fs.readFileSync('/research/private/db.json')));const p=JSON.parse(fs.readFileSync('/research/private/plan.json'));(async()=>{try{await c.connect();const r=await c.query(`SELECT DISTINCT ON(r.sample_id) r.sample_id AS id,coalesce(r.outcome,'RUN_INCOMPLETE') AS outcome,r.started_at AS \"startedAt\" FROM runs r JOIN collector_attempts a ON a.run_id=r.id WHERE r.sample_id::text=ANY($1::text[]) AND a.created_at>=$2::timestamptz ORDER BY r.sample_id,a.created_at DESC,r.id DESC`,[p.entries.map(e=>String(e.id)),p.startedAt]);process.stdout.write(JSON.stringify(r.rows));}catch(e){process.stderr.write(e.code||e.name);process.exitCode=1;}finally{await c.end();}})();"""
    actual_attempts = subprocess.run(['docker','run','--rm','--user','0:0','--read-only',
        '--network','apple-account-research-internal','-v',str(root)+':/research:ro',
        '--entrypoint','node',IMAGE,'-e',research_query], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=30, check=True)
    actual = {item['id']: item for item in json.loads(actual_attempts.stdout)}
    starts = [item for item in records(root / 'evidence/backfill.jsonl') if item.get('event') == 'started']
    active = False
    if starts:
        service = os.environ.get('OFFICIAL_BACKFILL_SERVICE', 'apple-picked-up-sync-20261008.service')
        service_state = subprocess.run(['systemctl', 'is-active', service],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).stdout.decode().strip()
        active = service_state in ('active', 'activating', 'deactivating')
    running_ids = set()
    for key, item in actual.items():
        if item['outcome'] == 'RUN_INCOMPLETE':
            live = active and item.get('startedAt', '')[:19] >= starts[-1]['time'][:19]
            item['outcome'] = 'RUNNING' if live else 'RUN_INTERRUPTED'
            if live:
                running_ids.add(key)
    date_verified = {item['orderId'] for item in applied if item.get('dateVerified') and
                     rows.get(item['orderId'], {}).get('date') == item.get('date')}
    status_ids = {key for key, item in status_audits.items() if
                  rows.get(key, {}).get('status') == item['officialRawStatus'] and
                  rows.get(key, {}).get('observed') == item['officialStatusObservedAt']}
    complete_ids = date_verified & status_ids & set(verified)
    failed_ids = (set(attempts) | set(deferred) | set(actual)) - complete_ids - running_ids
    report.update(scope=plan['scope'], dateVerifiedThisBatch=len(date_verified),
                  allFieldsVerified=len(complete_ids),
                  syncClassification={'verified':len(complete_ids), 'running':len(running_ids), 'failedOrDeferred':len(failed_ids),
                    'unprocessed':len(plan['entries'])-len(complete_ids | failed_ids | running_ids)},
                  deferredOutcomes=dict(collections.Counter(e['outcome'] for e in deferred.values())),
                  actualAttemptedThisBatch=len(actual),
                  researchLatestOutcomes=dict(collections.Counter(e['outcome'] for e in actual.values())))
print(json.dumps(report))
