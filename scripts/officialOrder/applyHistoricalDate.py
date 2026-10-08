"""历史605日期补录宿主入口；三锁、STOP、独立证据、事务与全范围回读。"""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import uuid

from historicalDateChain import (LEGACY_ROOT, SOURCE_FILES, raw_private, strict_json,
    named, sha, verify_proof, require)

IMAGE = 'mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
ROOT = pathlib.Path('/var/www/apple-order-mgr/shared/official-rebuild-20261008')
API = 'apple-order-mgr-prod-api-1'
MAX_BYTES = 16777216
MODULE_NAME = 'scripts/officialPickupBackfill/applyHistoricalDate.js'

LEGACY_VERIFY_SCRIPT = "\nconst fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto');\nconst {decrypt}=require('/research/release/src/services/officialOrderSupport');\nconst {parseOfficialOrderDetail}=require('/research/release/src/services/officialOrderParser');\nconst {deriveOfficialPickupDate}=require('/research/release/src/services/officialPickupDate');\nconst hash=x=>crypto.createHash('sha256').update(x).digest('hex');\nlet key,stage='FILES';\ntry{\n const read=p=>{const st=fs.lstatSync(p);assert(st.isFile()&&!(st.mode&0o077)&&st.size<16777216);return fs.readFileSync(p)};\n const plan=JSON.parse(read('/research/private/plan.json'));const entry=plan.entries.find(x=>x.id===605);assert(entry&&entry.previousDate===null);\n const old=JSON.parse(read('/old/private/results/order-605-run-47.json'));assert.equal(old.systemOrderId,605);assert.equal(old.orderNumber,entry.orderNumber);assert.equal(old.identityMatched,true);assert.equal(old.source.runId,47);\n key=read('/old/private/evidence.key');assert.equal(key.length,32);const src=old.source;\n const match=/^body-([1-9]\\d*)-([a-f0-9]{16})\\.enc$/.exec(src.file);assert(match);assert.equal(src.sha256.slice(0,16),match[2]);\n stage='GCM';const dir='/old/evidence/run-47/';stage='BODY';const body=decrypt(read(dir+src.file),key);assert.equal(hash(body),src.sha256);\n stage='LEGACY_CHAIN';\n stage='SEALED_RESULT';const sealedFiles=fs.readdirSync(dir).filter(x=>/^official-result-[a-f0-9]{16}\\.enc$/.test(x));assert.equal(sealedFiles.length,1);\n const sealedResult=decrypt(read(dir+sealedFiles[0]),key);assert.equal(hash(sealedResult).slice(0,16),sealedFiles[0].slice(16,32));assert.deepEqual(JSON.parse(sealedResult),old);\n stage='STATE';const eventsRaw=read(dir+'events.jsonl');const events=eventsRaw.toString().trim().split('\\n').map(JSON.parse);const stateRaw=read(dir+'state.json');const state=JSON.parse(stateRaw);\n assert.equal(state.outcome,'SUCCEEDED');assert.equal(Number(state.runId),47);assert.equal(state.systemOrderId,605);assert.equal(state.requests,43);assert.equal(state.resultFile.split('/').at(-1),'order-605-run-47.json');\n stage='STATE_RESULT';const legacyResult={...old};delete legacyResult.source;delete legacyResult.systemOrderId;delete legacyResult.orderNumber;assert.deepEqual(state.result,legacyResult);\n stage='FINISH';const finish=events.filter(e=>e.message==='finished');assert.equal(finish.length,1);for(const [k,v] of Object.entries(state))assert.deepEqual(finish[0][k],v);\n stage='BODY_EVENT';const bodyEvents=events.filter(e=>e.message==='body'&&e.file===src.file);assert.equal(bodyEvents.length,1);for(const k of ['action','bytes','cached','file','host','path','sha256','status','type','urlHash'])assert.deepEqual(bodyEvents[0][k],src[k]);assert.equal(src.bytes,body.length);assert.equal(src.status,200);assert.equal(src.cached,false);assert.equal(src.provider,'Apple official website');assert(/^(?:secure\\d*\\.)?www\\.apple\\.com\\.cn$/.test(src.host));stage='ACTION';assert.equal(src.action,'fetchOrder');assert.equal(src.type,'Fetch');\n stage='TIME';assert(Date.parse(events[0].timestamp)<=Date.parse(bodyEvents[0].timestamp));assert(Date.parse(bodyEvents[0].timestamp)<=Date.parse(src.observedAt));assert(Date.parse(src.observedAt)<=Date.parse(finish[0].timestamp));\n stage='REPARSE';const parsed=parseOfficialOrderDetail(body.toString('utf8'),entry.orderNumber);assert(parsed);assert.equal(parsed.completeItemCount,old.completeItemCount);assert.deepEqual(parsed.products.map(({pickupDateText,...p})=>p),old.products);\n const derived=deriveOfficialPickupDate(parsed,src.observedAt);\n const legacy={outcome:'HISTORICAL_LEGACY_SEALED_CHAIN_VERIFIED',currentHttpAuditCompatible:false,researchRunChecked:false,missingEncryptedResponse:true,orderId:605,runId:47,observedAt:src.observedAt,bodySha256:src.sha256,sealedResultSha256:hash(sealedResult),eventsSha256:hash(eventsRaw),stateSha256:hash(stateRaw),date:derived.date,reason:derived.reason,products:parsed.products.length,businessWrites:0,network:'none'};process.stdout.write(JSON.stringify({legacy,sourceResult:parsed}));\n}catch(e){process.stdout.write(JSON.stringify({outcome:'HISTORICAL_DATE_CHECK_FAILED',stage,errorType:e.name,errorCode:/^[A-Z_]{1,40}$/.test(e.code||'')?e.code:null,businessWrites:0}));process.exitCode=2;}finally{if(key)key.fill(0)}\n"
RESEARCH_SCRIPT = 'const fs=require(\'fs\');const {Client}=require(\'pg\');const config=JSON.parse(fs.readFileSync(\'/research/private/db.json\'));\nif(config.host!==\'apple-account-research-db\'||config.database!==\'apple_account_research\')process.exit(1);\nconst c=new Client({...config,connectionTimeoutMillis:10000});\n(async()=>{try{await c.connect();await c.query(\'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY\');await c.query("SET LOCAL statement_timeout=\'8s\'");await c.query("SET LOCAL TIME ZONE \'UTC\'");\nconst {rows}=await c.query(\'SELECT id::int,sample_id::int AS "sampleId",mode,outcome,requests::int,started_at AS "startedAt",finished_at AS "finishedAt" FROM runs WHERE id=$1\',[47]);if(rows.length!==1)throw Error();\nconst attempts=await c.query(\'SELECT run_id::int AS "runId",order_hash AS "orderHash",account_hash AS "accountHash",proxy_hash AS "proxyHash",login_at AS "loginAt" FROM collector_attempts WHERE run_id=$1 ORDER BY created_at\',[47]);\nconst db=await c.query(\'SELECT current_database() AS name\');await c.query(\'ROLLBACK\');process.stdout.write(JSON.stringify({queriedAt:Date.now()/1000,database:db.rows[0].name,run:rows[0],attemptCount:attempts.rows.length}));\n}finally{await c.end()}})().catch(()=>{process.exitCode=1});'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command_json(command, script, timeout=60):
    result = subprocess.run(command, input=script.encode('utf-8'), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0 and len(result.stdout) <= MAX_BYTES)
    return strict_json(result.stdout)


def sync_directory(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def exclusive_file(path, raw):
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(raw)
        target.flush()
        if os.geteuid() == 0:
            os.fchown(target.fileno(), 1000, 1000)
        os.fsync(target.fileno())
    sync_directory(path.parent)


def source_digests():
    return {name: sha(raw_private(LEGACY_ROOT / name)) for name in sorted(SOURCE_FILES)}


def docker_read(root, script, network='none', legacy=False):
    command = ['docker', 'run', '--rm', '-i', '--network', network, '--read-only', '--user', '1000:1000',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64',
               '-v', str(root) + ':/research:ro', '-v', str(root / 'deps') + ':/research/node_modules:ro',
               '-e', 'NODE_PATH=/research/node_modules']
    if legacy:
        command += ['-v', str(LEGACY_ROOT) + ':/old:ro']
    return command_json(command + [IMAGE, 'node', '-'], script)


def make_proof(root, plan_hash, entry, http_intent_hash):
    """先后摘要一致，再认领纯离线GCM核验和只读研究run。"""
    files = source_digests()
    verified = docker_read(root, LEGACY_VERIFY_SCRIPT, legacy=True)
    research = docker_read(root, RESEARCH_SCRIPT, network='apple-account-research-internal')
    require(source_digests() == files)
    proof = {'version': 1, 'orderId': 605, 'planSha256': plan_hash, 'httpIntentSha256': http_intent_hash,
             'sourceFiles': files, 'legacy': verified['legacy'], 'sourceResult': verified['sourceResult'],
             'research': research}
    verify_proof(proof, plan_hash, entry['orderNumber'], http_intent_hash)
    return proof


def own_boundary(root, plan_hash, stop_raw, http_hash, boundary):
    """仅豁免本次原字节STOP；全局未知HTTP/收据意图仍阻断。"""
    require(raw_private(root / 'private/STOP') == stop_raw)
    require(sha(raw_private(root / 'private/plan.json')) == plan_hash)
    require(named(root, 'http-apply-intent-605.json')[1] == http_hash)
    require(not os.path.lexists(str(root / 'private/http-cleanup-blocked.json')))
    for prefix in ('http-apply-intent-', 'browser-receipt-bind-intent-'):
        for path in (root / 'private').glob(prefix + '*.json'):
            boundary.validateIntent(path, strict_json(raw_private(path)))


def database(root, helper, module_path, payload, mode, preview=None):
    """源码走stdin，复用既有API DB连接与提交未知判定，不写API安装目录。"""
    bundle = {name: (root / 'release' / name).read_text(encoding='utf-8') for name in helper.SOURCES}
    bundle[MODULE_NAME] = module_path.read_text(encoding='utf-8')
    bridge = helper.BRIDGE.replace('applyHttpPayload', 'applyHistoricalDate').replace(
        'scripts/officialPickupBackfill/applyHttpResult.js', MODULE_NAME).replace('HTTP_APPLY_', 'HISTORICAL_DATE_')
    data = {'payload': payload, 'mode': mode, 'preview': preview}
    script = ('const bundle=' + json.dumps(bundle, ensure_ascii=True, allow_nan=False) + ';\nconst input=' +
              json.dumps(data, ensure_ascii=True, allow_nan=False) + ';\n' + bridge)
    output = command_json(['docker', 'exec', '-i', API, 'node', '-'], script, timeout=60)
    require(output.get('ok') is True and isinstance(output.get('result'), dict))
    return output['result']


def readback_locked(root, progress):
    """调用者持有三把排他锁；执行同一独立v4全范围检查，不另取共享锁。"""
    loaded = progress.load_progress(root)
    plan, plan_hash, expected, issues, counters, metadata = loaded
    output = command_json(['docker', 'exec', '-i', API, 'node', '-'],
                          progress.database_script(plan, expected), timeout=200)
    require(named(root, 'plan.json')[1] == plan_hash)
    report = progress.summarize(*loaded, output)
    require(report['outcome'] == 'ORIGINAL_SCOPE_PROGRESS_RECORDED' and not report['anomalyIds'] and
            report['counts']['conflicts'] == 0 and report['counts']['missingRows'] == 0)
    row = next(item for item in report['targets'] if item['id'] == 605)
    require(row['dateFilledThisTask'] is True and row['httpFieldsSatisfied'] is True and
            row['independentReadbackPassed'] is True)
    name = progress.save_report(root, report)
    return name, report['counts']


def execute(root, candidate, apply=False):
    """明确一次性目标；已有意图拒绝自动再提交，任何提交期异常保留STOP。"""
    require(root == ROOT and root.is_absolute() and root.resolve() == root and candidate.is_absolute())
    private = root / 'private'
    require(private.is_dir() and not private.is_symlink())
    module_path = candidate / 'applyHistoricalDate.js'
    require(module_path.is_file() and not module_path.is_symlink())
    module_sha = sha(module_path.read_bytes())
    sys.path.insert(0, str(root / 'release/scripts/officialOrder'))
    helper = load_module('historical_host_http_helper', root / 'release/scripts/officialOrder/applyHttpSample.py')
    batch = load_module('historical_host_batch', root / 'release/scripts/officialOrder/runHttpBatch.py')
    boundary = load_module('historical_host_boundary', root / 'release/scripts/officialOrder/writeBoundary.py')
    progress = load_module('historical_host_progress', candidate / 'official-original-scope-progress-v4.py')
    with contextlib.ExitStack() as stack:
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            fd = os.open(str(private / name), os.O_RDWR | os.O_NOFOLLOW)
            handle = stack.enter_context(os.fdopen(fd, 'a'))
            require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode))
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan, plan_hash = named(root, 'plan.json')
        scope = batch.validate_plan(plan)
        require(len(scope) == 489 and 605 in scope)
        boundary.checkWriteBoundary(root, plan_hash)
        require(not list(private.glob('historical-date-intent-*.json')))
        for name in batch.JOURNALS:
            batch.journal_state(private / name, plan_hash, set(scope))
        require(605 in batch.confirmed_applies(root, plan, plan_hash))
        entry = next(item for item in plan['entries'] if item['id'] == 605)
        require(entry['previousDate'] is None and entry['dateMissing'] is True)
        http, http_hash = named(root, 'http-apply-intent-605.json')
        old_result, _ = named(root, http['resultFile'])
        require(http['state'] == 'APPLIED' and old_result['dateFilled'] is False and
                old_result['proposedDate'] is None and old_result['previousDate'] is None)
        # 新补录前先复用原独立链认证全部既有证据，605不得有例外。
        loaded = progress.load_progress(root)
        require(not loaded[3] and any(item['id'] == 605 and item['evidenceValid'] for item in loaded[2]))
        proof = make_proof(root, plan_hash, entry, http_hash)
        attempt = uuid.uuid4().hex
        prefix = 'historical-date-605-' + attempt
        names = {kind: prefix + '-' + kind + '.json' for kind in ('proof', 'payload', 'preview', 'result')}
        helper.writePrivate(private / names['proof'], proof)
        proof_sha = named(root, names['proof'])[1]
        payload = {'version': 1, 'kind': 'VERIFIED_LEGACY_PICKUP_DATE', 'orderId': 605,
                   'orderNumber': entry['orderNumber'], 'sourceRunId': 47,
                   'sourceBodySha256': proof['legacy']['bodySha256'],
                   'sourceObservedAt': proof['legacy']['observedAt'], 'sourceResult': proof['sourceResult'],
                   'planSha256': plan_hash, 'proofSha256': proof_sha,
                   'priorHttpAfterHash': old_result['afterHash'], 'proposedDate': proof['legacy']['date']}
        helper.writePrivate(private / names['payload'], payload)
        preview = database(root, helper, module_path, payload, 'dry-run')
        require(preview.get('mode') == 'dry-run' and preview.get('orderId') == 605 and
                preview.get('businessWrites') == 0 and preview.get('dateFilled') is False and
                preview.get('beforeHash') == old_result['afterHash'])
        helper.writePrivate(private / names['preview'], preview)
        boundary.checkWriteBoundary(root, plan_hash)
        require(source_digests() == proof['sourceFiles'] and sha(module_path.read_bytes()) == module_sha)
        require(named(root, 'http-apply-intent-605.json')[1] == http_hash)
        if not apply:
            return {'outcome': 'HISTORICAL_DATE_DRY_RUN', 'orderId': 605, 'businessWrites': 0,
                    'proofFile': names['proof'], 'previewFile': names['preview'], 'moduleSha256': module_sha}
        stop_raw = json.dumps({'purpose': 'historical-date-605', 'attemptId': attempt,
                               'planSha256': plan_hash}, sort_keys=True).encode('utf-8')
        exclusive_file(private / 'STOP', stop_raw)
        intent = {'version': 1, 'state': 'APPLY_STARTED', 'orderId': 605, 'attemptId': attempt,
                  'planSha256': plan_hash, 'httpIntentSha256': http_hash}
        intent.update({kind + 'File': name for kind, name in names.items()})
        intent_path = private / 'historical-date-intent-605.json'
        require(not os.path.lexists(str(intent_path)))
        helper.writePrivate(intent_path, intent)
        own_boundary(root, plan_hash, stop_raw, http_hash, boundary)
        result = database(root, helper, module_path, payload, 'apply', preview)
        require(result.get('mode') == 'apply' and result.get('orderId') == 605 and
                result.get('businessWrites') == 1 and result.get('dateFilled') is True and
                result.get('beforeHash') == preview['beforeHash'] and result.get('afterHash') != result['beforeHash'] and
                result.get('payloadSha256') == preview['payloadSha256'])
        helper.writePrivate(private / names['result'], result)
        intent['state'] = 'APPLIED'
        helper.writePrivate(intent_path, intent)
        own_boundary(root, plan_hash, stop_raw, http_hash, boundary)
        report_name, counts = readback_locked(root, progress)
        own_boundary(root, plan_hash, stop_raw, http_hash, boundary)
        helper.writePrivate(private / (prefix + '-completion.json'),
                            {'orderId': 605, 'state': 'VERIFIED', 'attemptId': attempt,
                             'reportFile': report_name, 'reportSha256': sha(raw_private(root / 'evidence' / report_name))})
        require(raw_private(private / 'STOP') == stop_raw)
        (private / 'STOP').unlink()
        sync_directory(private)
        return {'outcome': 'HISTORICAL_DATE_APPLIED_VERIFIED', 'orderId': 605, 'businessWrites': 1,
                'dateFilled': True, 'evidenceFile': report_name, 'counts': counts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(ROOT))
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        result = execute(pathlib.Path(args.root), pathlib.Path(args.candidate), args.apply)
        print(json.dumps(result, allow_nan=False))
    except Exception as error:
        # 不删除STOP、不重放SQL、不把异常提交宣称零写入。
        code = str(error)
        safe = code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code) else 'HISTORICAL_DATE_STOPPED'
        print(json.dumps({'outcome': safe, 'completionUnverified': True}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
