"""原始冻结范围进度：只读业务库，复用成功链与独立行/设备核验；不采样官网。"""
import argparse
import copy
import datetime
import fcntl
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import uuid

from externalPayerReadback import adjust_progress
from confirmedDateChain import apply_confirmed_chain, CONFIRMED_QUERY_JS, CONFIRMED_CHECK_JS

from historicalDateChain import apply_historical_chain, HISTORY_QUERY_JS, HISTORY_CHECK_JS

READBACK_PATH = str(pathlib.Path(__file__).resolve().with_name('official-independent-readback-with-receipts-v2.py'))
SPEC = importlib.util.spec_from_file_location('official_progress_readback', READBACK_PATH)
READBACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READBACK)
require = READBACK.require
ORIGINAL_SCOPE = 489


def load_progress(root, expected_scope=ORIGINAL_SCOPE):
    """完整来源链仍由既有独立回读器核验；此处只增加字段归因元数据。"""
    plan, plan_hash = READBACK.named(root, 'plan.json')
    expected, issues, counters = READBACK.load_evidence(root)
    require(len(plan['entries']) == expected_scope, 'ORIGINAL_SCOPE_INVALID')
    require(READBACK.named(root, 'plan.json')[1] == plan_hash, 'PLAN_CHANGED')
    metadata = {}
    entries = {entry['id']: entry for entry in plan['entries']}
    for item in expected:
        if not item.get('evidenceValid'):
            continue
        order_id = item['id']
        meta = metadata.setdefault(order_id, {})
        if item.get('http'):
            intent = READBACK.named(root, 'http-apply-intent-{}.json'.format(order_id))[0]
            result = READBACK.named(root, intent['resultFile'])[0]
            applied = READBACK.named(root, intent['auditFile'])[0]
            try:
                bound = ('statusSaved', 'dateFilled', 'statusAction', 'dateAction', 'previousDate', 'proposedDate')
                require(all(key in result and key in applied and type(result[key]) is type(applied[key]) and
                            result[key] == applied[key] for key in bound), 'HTTP_ATTRIBUTION_INVALID')
                require(type(result.get('statusSaved')) is bool and type(result.get('dateFilled')) is bool and
                        result.get('statusAction') in ('UPDATE_STATUS', 'UNCHANGED', 'KEEP_NEWER_STATUS') and
                        result['statusSaved'] == (result['statusAction'] == 'UPDATE_STATUS') and
                        result['businessWrites'] == int(result['statusSaved'] or result['dateFilled']) and
                        (not result['dateFilled'] or entries[order_id]['dateMissing'] and
                         result.get('dateAction') == 'FILL_DATE' and result['previousDate'] is None and
                         isinstance(result['proposedDate'], str) and bool(result['proposedDate'].strip())),
                        'HTTP_ATTRIBUTION_INVALID')
                meta.update(statusWrittenThisTask=result['statusSaved'],
                            statusPreservedNewer=result['statusAction'] == 'KEEP_NEWER_STATUS',
                            dateFilledThisTask=result['dateFilled'])
            except Exception:
                item['evidenceValid'] = False
                issues.setdefault(order_id, []).append('HTTP_ATTRIBUTION_INVALID')
        if item.get('receipt'):
            intent = READBACK.named(root, 'browser-receipt-bind-intent-{}.json'.format(order_id))[0]
            result = READBACK.named(root, intent['resultFile'])[0]
            # 既有链已验证 newBindings 的整数范围及与公开审计的一致性。
            # SERIALS_VERIFIED 可以是纯核验；newBindings=0 不能宣称本任务新增。
            meta['serialDevicesBoundThisTask'] = result['newBindings']
    apply_historical_chain(root, expected, metadata, plan_hash)
    apply_confirmed_chain(root, expected, metadata, plan_hash)
    plan = copy.deepcopy(plan)
    payer_records = adjust_progress(root, expected, plan)
    metadata['_externalPayerRecords'] = payer_records
    return plan, plan_hash, expected, issues, counters, metadata


PROGRESS_JS = r'''
async function queryOriginalProgress(client,plan,expected){
  const checked=[],targets=[],byId=new Map(expected.map(e=>[e.id,e]));
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
    const database=await client.query('SELECT current_database() AS name');
    if(database.rows.length!==1||database.rows[0].name!==process.env.DB_NAME)throw Error('DATABASE_INVALID');
    const entries=[...plan.entries].sort((a,b)=>a.id-b.id);
    for(let offset=0;offset<entries.length;offset+=25){
      const group=entries.slice(offset,offset+25);
      const {rows}=await client.query(`SELECT o.id,order_number AS "orderNumber",md5(to_jsonb(o)::text) AS hash,
        md5((to_jsonb(o)-'actual_pickup_date')::text) AS original,
        md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text) AS stable,
        (email_order_status='picked_up') IS TRUE AS "pickedUp",actual_pickup_date IS NOT NULL AS "datePresent",
        (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM pickup_devices d WHERE d.order_id=o.id) AS devices,
        (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM stock_units s
          WHERE EXISTS(SELECT 1 FROM pickup_devices d WHERE d.order_id=o.id AND d.stock_unit_id=s.id)) AS units
        FROM orders o WHERE id=ANY($1::int[]) ORDER BY id`,[group.map(e=>e.id)]);
      if(new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!group.some(e=>e.id===r.id)))throw Error('READBACK_COVERAGE_INVALID');
      for(const entry of group){
        const row=rows.find(r=>r.id===entry.id),e=byId.get(entry.id);
        if(e)checked.push(checkRow(e,row,plan));
        if(!row){targets.push({id:entry.id,exists:false,pickedUp:false,datePresent:false,deviceCount:0,
          serialPresent:false,identityMatches:false,baselineMatches:false});continue;}
        if(typeof row.pickedUp!=='boolean'||typeof row.datePresent!=='boolean'||!Array.isArray(row.devices))throw Error('READBACK_ROW_INVALID');
        targets.push({id:entry.id,exists:true,pickedUp:row.pickedUp,datePresent:row.datePresent,
          deviceCount:row.devices.length,serialPresent:row.devices.length>0,identityMatches:row.orderNumber===entry.orderNumber,
          baselineMatches:e&&e.http?row.stable===e.stableRowHash:row.original===(payerRecords.find(record=>record.id===entry.id&&record.kind==='ORIGINAL')?.acceptedOriginalHash||entry.rowHash)});
      }
    }
    // 范围外意图也必须进入失败列表，不能因只查询原始范围而遗漏。
    for(const e of expected)if(!plan.entries.some(entry=>entry.id===e.id))checked.push(checkRow(e,undefined,plan));
    checked.sort((a,b)=>a.id-b.id);
    return {checked,targets};
  }finally{await client.query('ROLLBACK');}
}
'''


PAYER_JS = pathlib.Path(__file__).with_name('verifyExternalPayerChange.js').read_text(encoding='utf-8')
PROGRESS_JS = PROGRESS_JS.replace('    const entries=[...plan.entries]', HISTORY_QUERY_JS + CONFIRMED_QUERY_JS + r'''
    for(const record of payerRecords){
      await verifyExternalPayerRecord(client,record,record.id===1113&&expected.some(e=>e.id===1113));
    }
    const entries=[...plan.entries]''')

def database_script(plan, expected, payer_records=None):
    return ('const plan=' + json.dumps(plan, ensure_ascii=True, allow_nan=False) + ';\nconst expected=' +
            json.dumps(expected, ensure_ascii=True, allow_nan=False) + ';\nconst payerRecords=' + json.dumps(payer_records or [], ensure_ascii=True) + ';\n' + PAYER_JS + READBACK.DATABASE_JS + HISTORY_CHECK_JS + CONFIRMED_CHECK_JS + PROGRESS_JS + r'''
const {Client}=require('pg');
if(process.env.NODE_ENV!=='production'||!process.env.DB_HOST||!process.env.DB_NAME||
   /research|study/i.test(process.env.DB_HOST+' '+process.env.DB_NAME))throw Error('DATABASE_INVALID');
const client=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,
 password:process.env.DB_PASSWORD,database:process.env.DB_NAME,connectionTimeoutMillis:8000});
(async()=>{try{await client.connect();process.stdout.write(JSON.stringify(await queryOriginalProgress(client,plan,expected)));}
 finally{await client.end();}})().catch(()=>{process.stderr.write('READBACK_FAILED');process.exitCode=1;});
''')


def summarize(plan, plan_hash, expected, issues, counters, metadata, result):
    """只返回计数/标志/系统 ID；真实日期、订单号、设备标识均不得进入报告。"""
    independent = READBACK.summarize(expected, issues, counters, result)
    targets = result.get('targets')
    ids = sorted(entry['id'] for entry in plan['entries'])
    require(isinstance(targets, list) and len(targets) == len(ids) and
            all(isinstance(row, dict) and READBACK.positive(row.get('id')) for row in targets) and
            sorted(row['id'] for row in targets) == ids, 'PROGRESS_COVERAGE_INVALID')
    expected_by_id = {item['id']: item for item in expected}
    checked = {item['id']: item for item in result['checked']}
    entries = {entry['id']: entry for entry in plan['entries']}
    rows = []
    bool_fields = ('exists', 'pickedUp', 'datePresent', 'serialPresent', 'identityMatches', 'baselineMatches')
    for target in sorted(targets, key=lambda row: row['id']):
        require(all(type(target.get(key)) is bool for key in bool_fields) and
                type(target.get('deviceCount')) is int and target['deviceCount'] >= 0 and
                target['serialPresent'] == (target['deviceCount'] > 0) and
                (target['exists'] or not any(target[key] for key in bool_fields[1:])), 'PROGRESS_ROW_INVALID')
        order_id, entry = target['id'], entries[target['id']]
        item, check = expected_by_id.get(order_id, {}), checked.get(order_id, {})
        passed = bool(item) and item.get('evidenceValid') is True and check.get('ok') is True and order_id not in issues
        meta = metadata.get(order_id, {})
        status_handled = passed and item.get('http') is True
        receipt_handled = passed and bool(item.get('receipt'))
        conflict = (not target['exists'] or not target['pickedUp'] or not target['identityMatches'] or
                    not target['baselineMatches'] or bool(item) and not passed)
        row = {key: target[key] for key in ('id',) + bool_fields + ('deviceCount',)}
        row.update(statusHandled=status_handled,
                   statusWrittenThisTask=status_handled and meta.get('statusWrittenThisTask') is True,
                   statusPreservedNewer=status_handled and meta.get('statusPreservedNewer') is True,
                   dateOriginallyPresent=not entry['dateMissing'], serialOriginallyPresent=not entry['serialsMissing'],
                   dateFilledThisTask=status_handled and entry['dateMissing'] and meta.get('dateFilledThisTask') is True,
                   serialBoundThisTask=receipt_handled and entry['serialsMissing'] and meta.get('serialDevicesBoundThisTask', 0) > 0,
                   serialDevicesBoundThisTask=meta.get('serialDevicesBoundThisTask', 0) if receipt_handled else 0,
                   receiptBindingVerified=receipt_handled, independentReadbackRequired=bool(item),
                   independentReadbackPassed=passed, conflict=conflict,
                   httpFieldsSatisfied=bool(status_handled and target['datePresent'] and not conflict),
                   allThreeSatisfied=bool(status_handled and target['datePresent'] and target['serialPresent'] and not conflict))
        # 当前有值但没有本次填充证明的字段，仅标为来源未由本任务证明。
        row['datePresentWithoutTaskFillProof'] = bool(target['datePresent'] and entry['dateMissing'] and not row['dateFilledThisTask'])
        row['serialPresentWithoutTaskBindProof'] = bool(target['serialPresent'] and entry['serialsMissing'] and not row['serialBoundThisTask'])
        rows.append(row)
    count_fields = ('statusHandled', 'statusWrittenThisTask', 'statusPreservedNewer', 'datePresent', 'serialPresent',
                    'httpFieldsSatisfied', 'allThreeSatisfied', 'dateOriginallyPresent', 'serialOriginallyPresent', 'dateFilledThisTask',
                    'serialBoundThisTask', 'serialDevicesBoundThisTask', 'datePresentWithoutTaskFillProof', 'serialPresentWithoutTaskBindProof')
    counts = {key: sum(row[key] for row in rows) for key in count_fields}
    counts.update(remainingHttpTargets=len(rows) - counts['httpFieldsSatisfied'], originalScope=len(rows), remainingOriginalTargets=len(rows) - counts['allThreeSatisfied'],
                  currentPickedUp=sum(row['pickedUp'] for row in rows), conflicts=sum(row['conflict'] for row in rows),
                  missingRows=sum(not row['exists'] for row in rows))
    anomaly_ids = sorted(set(independent['mismatchIds']) | {row['id'] for row in rows if row['conflict']})
    return {'version': 2, 'currentPhase': 'HTTP_STATUS_AND_PICKUP_DATE', 'outcome': 'PROGRESS_WITH_CONFLICTS' if anomaly_ids else 'ORIGINAL_SCOPE_PROGRESS_RECORDED',
            'readOnly': True, 'businessWrites': 0, 'fullBusinessAcceptance': False,
            'observedAt': independent['observedAt'], 'planSha256': plan_hash,
            'counts': counts, 'anomalyIds': anomaly_ids,
            'independentReadback': {key: independent[key] for key in ('counts', 'hashMatchCounts', 'mismatchIds',
                                   'evidenceExceptionIds', 'evidenceExceptionCounts')},
            'targets': rows}


def acquire_locks(root):
    handles = []
    try:
        for name in ('http-sample.lock', 'http-apply.lock'):
            target = root / 'private' / name
            require(str(target.resolve()).startswith(str(root.resolve()) + os.sep), 'LOCK_INVALID')
            descriptor = os.open(str(target), os.O_RDONLY | os.O_NOFOLLOW)
            handle = os.fdopen(descriptor, 'rb')
            handles.append(handle)
            require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode), 'LOCK_INVALID')
            try:
                fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('SHARED_OPERATION_BUSY')
        return handles
    except Exception:
        for handle in reversed(handles):
            handle.close()
        raise


def save_report(root, output):
    directory = root / 'evidence'
    require(directory.is_dir() and not directory.is_symlink(), 'EVIDENCE_DIRECTORY_INVALID')
    name = 'original-scope-progress-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex + '.json'
    target = directory / name
    descriptor = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as destination:
        json.dump(output, destination, ensure_ascii=True, indent=2, allow_nan=False)
        destination.flush()
        if os.geteuid() == 0:
            os.fchown(destination.fileno(), 1000, 1000)
        os.fsync(destination.fileno())
    descriptor = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=READBACK.ROOT)
    args = parser.parse_args()
    locks = []
    try:
        root = pathlib.Path(args.root).resolve()
        locks = acquire_locks(root)
        plan, plan_hash, expected, issues, counters, metadata = load_progress(root)
        response = subprocess.run(['docker', 'exec', '-i', READBACK.API_CONTAINER, 'node', '-'],
                                  input=database_script(plan, expected, metadata.get('_externalPayerRecords', [])).encode('utf-8'), stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, timeout=200)
        require(response.returncode == 0 and len(response.stdout) <= READBACK.MAX_BYTES, 'READBACK_FAILED')
        require(READBACK.named(root, 'plan.json')[1] == plan_hash, 'PLAN_CHANGED')
        result = json.loads(response.stdout.decode('utf-8'), object_pairs_hook=READBACK.exact_object,
                            parse_constant=lambda _: require(False, 'JSON_NUMBER_INVALID'))
        output = summarize(plan, plan_hash, expected, issues, counters, metadata, result)
        name = save_report(root, output)
        # 日志只含汇总/异常 ID；逐目标标志留在 0600 证据文件。
        public = {key: output[key] for key in ('outcome', 'readOnly', 'businessWrites', 'fullBusinessAcceptance', 'counts', 'anomalyIds')}
        public['evidenceFile'] = name
        print(json.dumps(public, ensure_ascii=True, allow_nan=False))
        return 1 if output['anomalyIds'] else 0
    except Exception as error:
        code = str(error) if re.fullmatch(r'[A-Z_]{1,80}', str(error)) else 'PROGRESS_REPORT_FAILED'
        print(json.dumps({'outcome': code, 'readOnly': True, 'businessWrites': 0}))
        return 2
    finally:
        for handle in reversed(locks):
            handle.close()


if __name__ == '__main__':
    raise SystemExit(main())
