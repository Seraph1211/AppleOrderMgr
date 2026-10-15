"""本地独立只读回查：版本、静态资源、源码、Worker、匿名拒绝与安全头。"""
import argparse
import hashlib
import json
import shlex
import urllib.error
import urllib.request
from pathlib import Path
from common import MIGRATION, capture, config, read_json, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('artifact')
    args = parser.parse_args()
    c, artifact = config(args.config), Path(args.artifact)
    manifest = read_json(artifact / 'artifact-manifest.json')
    # 服务端只输出白名单非敏感字段和文件摘要；不打印配置/环境/令牌。
    remote = '''
import hashlib,json,subprocess
from pathlib import Path
c=CONFIG
root=Path(c['root']);new=root/'releases'/c['release'];backup=Path(c['backupRoot'])/c['release']
def inspect(name): return json.loads(subprocess.check_output(['docker','inspect',name]))[0]
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
a=inspect(c['apiContainer'])
others=[]
for old in json.loads((backup/'containers-before.json').read_text()):
 if old['name']==a['Name']: continue
 now=inspect(old['id']);assert now['Id']==old['id'] and now['Image']==old['image'] and now['State']['StartedAt']==old['startedAt'];others.append(old['name'])
node="const fs=require('fs'),p=require('path'),crypto=require('crypto'),out={};function walk(d){for(const f of fs.readdirSync(d)){const n=p.join(d,f);if(fs.statSync(n).isDirectory())walk(n);else out[p.relative('/app/src',n)]=crypto.createHash('sha256').update(fs.readFileSync(n)).digest('hex')}}walk('/app/src');process.stdout.write(JSON.stringify(out));"
files=json.loads(subprocess.check_output(['docker','exec',c['apiContainer'],'node','-e',node]))
protected_before=json.loads((backup/'protected-business-before.json').read_text())
protected_after=json.loads((backup/'protected-business-after.json').read_text())
protected_check=json.loads((backup/'protected-business-check.json').read_text())
activity_preflight=json.loads((backup/'identity-activity-preflight.json').read_text())
activity_cutover=json.loads((backup/'identity-activity-cutover.json').read_text())
assert protected_check['migration']=='20261016000002-add-identity-internal-api.js'
assert protected_check['beforeSha256']==sha(backup/'protected-business-before.json')
assert protected_check['afterSha256']==sha(backup/'protected-business-after.json')
expected_tables={'identity_verification_batches','identity_verification_items','users','user_permissions','user_permission_events'}
assert set(protected_before['tables'])==set(protected_after['tables'])==expected_tables
assert protected_check['protectedTables']==sorted(expected_tables)
assert protected_check['tablesMatched'] is True and protected_before['tables']==protected_after['tables']
assert protected_before['batchColumnsOmitted']==protected_after['batchColumnsOmitted']==['api_token_id']
assert protected_check['tasksIdleBefore'] is True and protected_check['tasksIdleAfter'] is True
def idle(activity):
 keys=['processingItems','pendingActiveItems','queuedOrRunningBatches']
 assert all(isinstance(activity[key],int) and activity[key]>=0 for key in keys)
 return not any(activity[key] for key in keys)
assert idle(protected_before['activity']) and idle(protected_after['activity'])
assert idle(activity_preflight) and idle(activity_cutover)
cutover=json.loads((backup/'production-cutover.json').read_text())
assert cutover['protectedEvidenceSha256']==sha(backup/'protected-business-check.json')
migrations=json.loads(subprocess.check_output(['runuser','-u','postgres','--','psql','-X','-qAt','-d',c['database'],'-c','SELECT json_agg(name ORDER BY name) FROM "SequelizeMeta"']))
print(json.dumps({'current':str((root/'current').resolve()),'image':a['Image'],'healthy':a['State'].get('Health',{}).get('Status'),'source':files,'nginxSha256':sha(c['nginxSite']),'expectedNginxSha256':json.loads((backup/'candidate-preflight.json').read_text())['nginxCandidateSha256'],'migrations':migrations,'otherContainersUnchanged':len(others),'protectedTablesMatched':len(expected_tables),'protectedEvidenceVerified':True,'identityIdleAtPreflightAndCutover':True}))
'''.replace('CONFIG', repr({key: c[key] for key in ['root', 'release', 'backupRoot', 'apiContainer', 'database', 'nginxSite']}))
    remote_result = json.loads(capture(['ssh', c['host'], '/usr/local/bin/python3.11 -c ' + shlex.quote(remote)]))
    assert remote_result['current'] == str(Path(c['root']) / 'releases' / c['release'])
    assert remote_result['image'] == manifest['imageIds']['api'] and remote_result['healthy'] == 'healthy'
    assert remote_result['source'] == manifest['sourceFingerprints']['api']
    assert MIGRATION in remote_result['migrations']
    assert remote_result['nginxSha256'] == remote_result['expectedNginxSha256']
    assert remote_result['protectedEvidenceVerified'] is True
    assert remote_result['identityIdleAtPreflightAndCutover'] is True
    assert remote_result['protectedTablesMatched'] == 5
    for rel, expected in manifest['frontend'].items():
        data = urllib.request.urlopen(c['origin'].rstrip('/') + '/' + rel, timeout=30).read()
        assert hashlib.sha256(data).hexdigest() == expected, 'PUBLIC_STATIC_MISMATCH'
    assert urllib.request.urlopen(c['origin'] + '/api/health/ready', timeout=15).status == 200
    # 不使用任何令牌/姓名/证件。缺失参数和错误方法在供应商调用前被拒绝。
    probes = [(c['origin'] + '/api/internal/v1/identity/verify', 'GET', {400, 401}), (c['origin'] + '/api/internal/v1/identity/verify', 'HEAD', {405}), (c['origin'].replace('https://', 'http://') + '/api/internal/v1/identity/verify', 'GET', {400}), (c['origin'] + '/api/identity-verifications/api-token', 'GET', {401})]
    for url, method, expected in probes:
        try:
            urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=20)
            raise AssertionError('ANONYMOUS_PROBE_NOT_REJECTED')
        except urllib.error.HTTPError as error:
            assert error.code in expected
            assert 'no-store' in error.headers.get('Cache-Control', ''), 'MISSING_NO_STORE'
            if '/internal/' in url:
                assert error.headers.get('Referrer-Policy') == 'no-referrer'
    report = {'commit': manifest['commit'], 'runningSourceFilesMatched': len(remote_result['source']), 'publicStaticFilesMatched': len(manifest['frontend']), 'anonymousSafeProbes': len(probes), 'otherContainersUnchanged': remote_result['otherContainersUnchanged'], 'providerCalled': False, 'nginxSha256': remote_result['nginxSha256'], 'protectedBusinessTablesMatched': remote_result['protectedTablesMatched'], 'protectedEvidenceVerified': True, 'identityIdleAtPreflightAndCutover': True}
    write_json(artifact.parent / '独立回查.json', report)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
