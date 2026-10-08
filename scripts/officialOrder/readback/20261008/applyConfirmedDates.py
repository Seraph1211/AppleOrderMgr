"""四笔用户确认日期的单次原子补录；未知提交保留STOP且禁止重放。"""
import argparse
import contextlib
import fcntl
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

ROOT = pathlib.Path('/var/www/apple-order-mgr/shared/official-rebuild-20261008')
API = 'apple-order-mgr-prod-api-1'
MODULE = 'scripts/officialPickupBackfill/applyConfirmedPickupDates.js'
PLAN_SHA = '4c5ce536c17fab48df19a344e59b8e72b724353950a7576d7825f42fc977013d'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def command_json(command, script, timeout=200):
    result = subprocess.run(command, input=script.encode('utf8'), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode or len(result.stdout) > 16777216:
        raise RuntimeError('CONFIRMED_DATE_COMMAND_UNVERIFIED')
    return json.loads(result.stdout.decode('utf8'))


def execute(candidate, apply=False):
    sys.path.insert(0, str(ROOT / 'release/scripts/officialOrder'))
    sys.path.insert(0, str(candidate))
    from historicalDateChain import named, sha, raw_private, require
    from confirmedDateChain import CASES, INTENT
    from writeBoundary import checkWriteBoundary
    helper = load('confirmed_host_http', ROOT / 'release/scripts/officialOrder/applyHttpSample.py')
    batch = load('confirmed_host_batch', ROOT / 'release/scripts/officialOrder/runHttpBatch.py')
    progress = load('confirmed_host_progress', candidate / 'official-original-scope-progress-v7.py')
    manifest = json.loads((candidate / 'manifest.json').read_text(encoding='utf8'))
    def verify_files():
        for name, digest in manifest.items(): require(sha(raw_private(candidate / name)) == digest)
    verify_files()
    def readback():
        loaded = progress.load_progress(ROOT)
        plan, plan_hash, expected, issues, counters, metadata = loaded
        output = command_json(['docker', 'exec', '-i', API, 'node', '-'], progress.database_script(
            plan, expected, metadata.get('_externalPayerRecords', [])))
        report = progress.summarize(*loaded, output)
        require(report['anomalyIds'] in ([], [894]) and
                report['counts']['conflicts'] == len(report['anomalyIds']) and report['counts']['missingRows'] == 0)
        return progress.save_report(ROOT, report), report
    def existing_conflict():
        http,_=named(ROOT,'http-apply-intent-894.json')
        old,_=named(ROOT,http['resultFile'])
        require(http['state']=='APPLIED')
        expected=dict(old['snapshot']['order'])
        if old['dateFilled']:expected['actual_pickup_date']=old['proposedDate']
        if old['statusSaved']:
            expected['official_raw_status']=old['proposedOfficialStatus']
            expected['official_status_observed_at']=old['proposedObservedAt']
        script='const expected='+json.dumps(expected,ensure_ascii=True)+';\n'+r'''
const {Client}=require('pg');const c=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
(async()=>{try{await c.connect();await c.query('BEGIN READ ONLY');await c.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
 const {rows}=await c.query(`SELECT md5(to_jsonb(o)::text) AS hash,ARRAY(SELECT k FROM jsonb_object_keys(to_jsonb(o)) AS k WHERE CASE WHEN k='official_status_observed_at' THEN (to_jsonb(o)->>k)::timestamptz IS DISTINCT FROM ($1::jsonb->>k)::timestamptz ELSE to_jsonb(o)->k IS DISTINCT FROM $1::jsonb->k END) AS fields FROM orders o WHERE id=894`,[JSON.stringify(expected)]);
 if(rows.length!==1)throw Error();await c.query('ROLLBACK');process.stdout.write(JSON.stringify(rows[0]));}finally{await c.end()}})().catch(()=>{process.exitCode=1});
'''
        value=command_json(['docker','exec','-i',API,'node','-'],script)
        require(set(value['fields'])=={'updated_at','email_status_version','email_status_needs_review',
                'email_lifecycle_updated_at','email_status_review_reasons'})
        return value
    def database(payload, mode, preview=None):
        bundle = {name: (ROOT/'release'/name).read_text(encoding='utf8') for name in helper.SOURCES}
        bundle[MODULE] = (candidate/'applyConfirmedPickupDates.js').read_text(encoding='utf8')
        bridge = helper.BRIDGE.replace('applyHttpPayload', 'applyConfirmedPickupDates').replace(
            'scripts/officialPickupBackfill/applyHttpResult.js', MODULE).replace('HTTP_APPLY_', 'CONFIRMED_DATE_')
        script = 'const bundle='+json.dumps(bundle)+';const input='+json.dumps(
            {'payload':payload,'mode':mode,'preview':preview},ensure_ascii=True)+';\n'+bridge
        value = command_json(['docker','exec','-i',API,'node','-'],script)
        require(value.get('ok') is True)
        return value['result']
    with contextlib.ExitStack() as stack:
        for name in ('http-batch.lock','http-sample.lock','http-apply.lock'):
            fd=os.open(str(ROOT/'private'/name),os.O_RDWR|os.O_NOFOLLOW)
            handle=stack.enter_context(os.fdopen(fd,'a'));fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        require(not os.path.lexists(str(ROOT/'private'/INTENT)))
        checkWriteBoundary(ROOT,PLAN_SHA)
        plan,plan_hash=named(ROOT,'plan.json');require(plan_hash==PLAN_SHA)
        scope=set(batch.validate_plan(plan));require(len(scope)==489)
        for name in batch.JOURNALS:batch.journal_state(ROOT/'private'/name,plan_hash,scope)
        before_file,before_report=readback()
        prior_conflict=existing_conflict() if before_report['anomalyIds'] else None
        require(all(any(t['id']==i and t['statusHandled'] and not t['datePresent'] and
                    t['independentReadbackPassed'] for t in before_report['targets']) for i,_,_ in CASES))
        verify_script=r'''
const fs=require('fs'),assert=require('assert/strict');
const {verifyHttpEvidence}=require('/research/release/scripts/officialPickupBackfill/applyHttpResult');
const out=[];
for(const id of [1093,1094,1099,1183]){
 const intent=JSON.parse(fs.readFileSync('/research/private/http-apply-intent-'+id+'.json'));
 const audit=JSON.parse(fs.readFileSync('/research/private/'+intent.sourceAudit));
 const verified=verifyHttpEvidence('/research',intent.sourceAudit,audit.finishedAt*1000+1);
 const original=JSON.parse(fs.readFileSync('/research/private/'+intent.payloadFile));
 assert.deepEqual(verified,original);out.push({id,result:verified.result});
}
process.stdout.write(JSON.stringify(out));
'''
        sources=command_json(['docker','run','--rm','-i','--network','none','--read-only','--user','1000:1000',
            '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--pids-limit','64',
            '-v',str(ROOT)+':/research:ro','-v',str(ROOT/'deps')+':/research/node_modules:ro',
            '-e','NODE_PATH=/research/node_modules','--entrypoint','node',helper.IMAGE,'-'],verify_script)
        entries=[]
        for order_id,date,run_id in CASES:
            http,http_sha=named(ROOT,'http-apply-intent-%s.json'%order_id)
            result,_=named(ROOT,http['resultFile'])
            require(http['state']=='APPLIED' and http['runId']==run_id and result['dateFilled'] is False)
            entry=next(e for e in plan['entries'] if e['id']==order_id)
            entries.append({'orderId':order_id,'orderNumber':entry['orderNumber'],'proposedDate':date,
                'runId':run_id,'httpIntentSha256':http_sha,'priorHttpAfterHash':result['afterHash'],
                'sourceResult':next(s['result'] for s in sources if s['id']==order_id)})
        payload={'version':1,'authorization':'这4单按照原样保存即可','planSha256':plan_hash,'entries':entries}
        attempt=uuid.uuid4().hex;prefix='confirmed-pickup-dates-'+attempt
        names={kind:prefix+'-'+kind+'.json' for kind in ('payload','preview','result')}
        helper.writePrivate(ROOT/'private'/names['payload'],payload)
        if prior_conflict:helper.writePrivate(ROOT/'private'/(prefix+'-prior-conflict.json'),prior_conflict)
        preview=database(payload,'dry-run');require(preview['businessWrites']==0)
        helper.writePrivate(ROOT/'private'/names['preview'],preview)
        if not apply:return {'outcome':'CONFIRMED_DATES_PREVIEWED','businessWrites':0,'orderIds':[c[0] for c in CASES],'beforeReadback':before_file}
        checkWriteBoundary(ROOT,plan_hash);verify_files()
        for e in entries:require(named(ROOT,'http-apply-intent-%s.json'%e['orderId'])[1]==e['httpIntentSha256'])
        stop=json.dumps({'purpose':'user-confirmed-four-pickup-dates','attemptId':attempt}).encode('utf8')
        fd=os.open(str(ROOT/'private/STOP'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as h:h.write(stop);h.flush();os.fsync(h.fileno());os.fchown(h.fileno(),1000,1000)
        intent={'version':1,'state':'APPLY_STARTED','attemptId':attempt,'planSha256':plan_hash}
        intent.update({kind+'File':name for kind,name in names.items()})
        for kind in ('payload','preview'):intent[kind+'Sha256']=named(ROOT,names[kind])[1]
        helper.writePrivate(ROOT/'private'/INTENT,intent)
        require(raw_private(ROOT/'private/STOP')==stop)
        result=database(payload,'apply',preview)
        require(result['businessWrites']==4 and result['mode']=='apply')
        helper.writePrivate(ROOT/'private'/names['result'],result)
        intent.update(state='APPLIED',resultSha256=named(ROOT,names['result'])[1])
        helper.writePrivate(ROOT/'private'/INTENT,intent)
        after_file,after_report=readback()
        require(after_report['anomalyIds']==before_report['anomalyIds'])
        if prior_conflict:require(existing_conflict()==prior_conflict)
        require(all(any(t['id']==i and t['httpFieldsSatisfied'] and t['dateFilledThisTask'] and
                    t['independentReadbackPassed'] for t in after_report['targets']) for i,_,_ in CASES))
        require(after_report['counts']['dateFilledThisTask']==before_report['counts']['dateFilledThisTask']+4)
        require(raw_private(ROOT/'private/STOP')==stop);(ROOT/'private/STOP').unlink()
        fd=os.open(str(ROOT/'private'),os.O_RDONLY);os.fsync(fd);os.close(fd)
        return {'outcome':'CONFIRMED_DATES_APPLIED_VERIFIED','businessWrites':4,'orderIds':[c[0] for c in CASES],
                'attemptId':attempt,'evidenceFile':after_file,'counts':after_report['counts'],
                'preExistingConflictIds':after_report['anomalyIds']}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--candidate',required=True);parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    try:print(json.dumps(execute(pathlib.Path(args.candidate).resolve(),args.apply),ensure_ascii=True))
    except Exception:
        print(json.dumps({'outcome':'CONFIRMED_DATE_STOPPED','completionUnverified':True}));raise SystemExit(2)
