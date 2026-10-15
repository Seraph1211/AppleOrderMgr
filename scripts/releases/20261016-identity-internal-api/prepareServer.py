"""服务器预检：导入核准制品、只改两项镜像、生成并隔离验证Nginx候选。"""
import argparse
import json
import re
import shutil
import tarfile
from pathlib import Path
from common import assert_current, capture, compose, config, hashes, log_run, read_json, server_paths, sha, write_json
from patchNginx import patch_site


def extract_safe(archive, destination):
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            target = (destination / member.name).resolve()
            assert target.is_relative_to(destination.resolve())
            assert not member.issym() and not member.islnk(), 'ARTIFACT_LINK_NOT_ALLOWED'
        source.extractall(destination, filter='data')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    args = parser.parse_args()
    c = config(args.config)
    assert_current(c)
    root, old, new, backup = server_paths(c)
    assert (backup / 'backup-manifest.json').is_file(), 'BACKUP_REQUIRED'
    assert new.is_dir() and new != old
    extract_safe(new / 'release-files.tar.gz', new)
    manifest = read_json(new / 'artifact-manifest.json')
    assert manifest['commit'] == c['approvedCommit'] and manifest['baselineRelease'] == c['baselineRelease']
    assert manifest['baselineImages'] == c['baselineImages']
    assert sha(new / 'images.tar.gz') == manifest['imagesSha256'], 'TRANSFER_CHECKSUM_MISMATCH'
    log_run(['docker', 'load', '-i', str(new / 'images.tar.gz')], backup / 'docker-load.log')
    for service, image in manifest['images'].items():
        assert capture(['docker', 'image', 'inspect', image, '--format', '{{.Id}}']) == manifest['imageIds'][service], 'SERVER_IMAGE_CONFIG_DIGEST_MISMATCH'
    for name in ['release.env', 'images.override.yml', 'docker-compose.prod.yml']:
        shutil.copy2(old / name, new / name)
    raw = (new / 'images.override.yml').read_text()
    for service, image in {'api': manifest['images']['api'], 'migrate': manifest['images']['migrator']}.items():
        match = re.search(r'(^  ' + service + r':\n)(.*?)(?=^  [A-Za-z_-]+:|\Z)', raw, re.M | re.S)
        assert match, 'COMPOSE_SERVICE_NOT_FOUND'
        block, count = re.subn(r'^    image:.*$', '    image: "' + image + '"', match.group(2), flags=re.M)
        assert count == 1, 'AMBIGUOUS_IMAGE_OVERRIDE'
        raw = raw[:match.start(2)] + block + raw[match.end(2):]
    (new / 'images.override.yml').write_text(raw)
    def effective(directory):
        return json.loads(capture(compose(directory) + ['--profile', '*', 'config', '--format', 'json'], cwd=directory))
    before, after = effective(old), effective(new)
    for service in ['api', 'migrate']:
        before['services'][service]['image'] = after['services'][service]['image']
    assert before == after, 'COMPOSE_DIFF_BEYOND_API_MIGRATOR_IMAGES'
    assert hashes(new / 'frontend') == manifest['frontend']
    site = Path(c['nginxSite'])
    assert site.is_relative_to('/etc/nginx')
    assert sha(site) == sha(backup / 'nginx.conf'), 'NGINX_CHANGED_SINCE_BACKUP'
    candidate = patch_site(site.read_text(), c['serverName'])
    (new / 'nginx-candidate.conf').write_text(candidate)
    shadow = new / 'nginx-validation'
    assert not shadow.exists(), 'NGINX_VALIDATION_ALREADY_EXISTS'
    shutil.copytree('/etc/nginx', shadow, symlinks=False)
    (shadow / site.relative_to('/etc/nginx')).write_text(candidate)
    # 只重写include路径到隔离副本，证书、上游及其他站点规则保持原值。
    for path in shadow.rglob('*'):
        if not path.is_file(): continue
        try: content = path.read_text()
        except UnicodeError: continue
        content = re.sub(r'(\binclude\s+["\']?)/etc/nginx/', lambda m: m.group(1) + str(shadow) + '/', content)
        path.write_text(content)
    log_run(['nginx', '-t', '-p', str(shadow) + '/', '-c', str(shadow / 'nginx.conf')], backup / 'nginx-candidate-test.log')
    write_json(backup / 'candidate-preflight.json', {'commit': manifest['commit'], 'composeOnlyImageChanges': True, 'staticFilesVerified': len(manifest['frontend']), 'nginxBaselineSha256': sha(site), 'nginxCandidateSha256': sha(new / 'nginx-candidate.conf'), 'nginxCandidateTestPassed': True, 'productionPointerUnchanged': str(old)})
    print(json.dumps({'candidatePrepared': True, 'nginxCandidateTestPassed': True, 'productionPointerUnchanged': True}))


if __name__ == '__main__':
    main()
