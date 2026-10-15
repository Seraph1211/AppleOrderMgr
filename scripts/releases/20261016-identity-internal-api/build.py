"""仅在核准的干净 main 上构建；不执行远程发布。"""
import argparse
import gzip
import json
import shutil
import subprocess
import tarfile
from pathlib import Path
from common import RELEASE_DIR, archive_image_ids, capture, config, hashes, read_json, run, sha, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    args = parser.parse_args()
    c = config(args.config)
    root = Path.cwd()
    assert capture(['git', 'branch', '--show-current']) == 'main', 'BUILD_REQUIRES_MAIN'
    assert not capture(['git', 'status', '--porcelain']), 'BUILD_REQUIRES_CLEAN_TREE'
    assert capture(['git', 'rev-parse', 'HEAD']) == c['approvedCommit'], 'MAIN_HEAD_NOT_APPROVED'
    run(['git', 'merge-base', '--is-ancestor', c['baselineCommit'], c['approvedCommit']])
    whitelist = read_json(root / RELEASE_DIR / '制品白名单.json')
    approved_files = set(sum(whitelist.values(), []))
    runtime_changes = capture(['git', 'diff', '--name-only', c['baselineCommit'], c['approvedCommit'], '--', 'src', 'frontend/src', 'migrations']).splitlines()
    assert set(runtime_changes) <= approved_files, 'RUNTIME_CHANGE_OUTSIDE_WHITELIST'
    out = root / '.tmp/identity-api/release/artifact'
    out.mkdir(exist_ok=False)
    context = out / 'context'
    context.mkdir()
    baseline_archive = out / 'baseline-images.tar'
    run(['docker', 'save', '-o', str(baseline_archive)] + [v['tag'] for v in c['baselineImages'].values()])
    baseline_config_ids = archive_image_ids(baseline_archive)
    baseline_fingerprints = {}
    for service, files in whitelist.items():
        base = c['baselineImages'][service]
        assert capture(['docker', 'image', 'inspect', base['tag'], '--format', '{{.Id}}']) == base['localId'], 'BASE_IMAGE_TAG_DRIFT'
        if base.get('id'):
            assert baseline_config_ids[base['tag']] == base['id'], 'BASE_IMAGE_CONFIG_DIGEST_DRIFT'
        cid = capture(['docker', 'create', '--platform', 'linux/amd64', base['localId']])
        baseline = out / ('baseline-' + service)
        baseline.mkdir()
        try:
            inside = '/app/migrations' if service == 'migrator' else '/app/src'
            run(['docker', 'cp', cid + ':' + inside, str(baseline / 'tree')], stdout=subprocess.DEVNULL)
            baseline_fingerprints[service] = hashes(baseline / 'tree')
            for rel in files:
                inside_rel = rel.removeprefix('frontend/src/') if service == 'frontend' else rel.removeprefix('src/') if service == 'api' else rel.removeprefix('migrations/')
                image_file = baseline / 'tree' / inside_rel
                previous = subprocess.run(['git', 'show', c['baselineCommit'] + ':' + rel], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                if previous.returncode == 0:
                    assert image_file.is_file() and image_file.read_bytes() == previous.stdout, 'IMAGE_MAIN_BASELINE_DRIFT:' + rel
                else:
                    assert not image_file.exists(), 'NEW_FILE_ALREADY_PRESENT_IN_IMAGE:' + rel
                target = context / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(subprocess.check_output(['git', 'show', c['approvedCommit'] + ':' + rel]))
        finally:
            run(['docker', 'rm', cid], stdout=subprocess.DEVNULL)
    baseline_tags = {}
    for service in whitelist:
        base = c['baselineImages'][service]
        assert capture(['docker', 'image', 'inspect', base['tag'], '--format', '{{.Id}}']) == base['localId']
        baseline_tags[service] = 'apple-order-mgr-identity-baseline-' + service + ':' + base['localId'][7:19]
        run(['docker', 'tag', base['tag'], baseline_tags[service]])
        assert capture(['docker', 'image', 'inspect', baseline_tags[service], '--format', '{{.Id}}']) == base['localId']
        dockerfile = root / RELEASE_DIR / ('Dockerfile.' + service)
        with (out / (service + '-build.log')).open('w') as log:
            run(['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--load', '--build-arg', 'BASE_IMAGE=' + baseline_tags[service], '-t', c['images'][service], '-f', str(dockerfile), str(context)], stdout=log, stderr=log)
        assert capture(['docker', 'image', 'inspect', baseline_tags[service], '--format', '{{.Id}}']) == c['baselineImages'][service]['localId']
        assert capture(['docker', 'image', 'inspect', c['baselineImages'][service]['tag'], '--format', '{{.Id}}']) == c['baselineImages'][service]['localId']
    fingerprints, image_ids = {}, {}
    for service, files in whitelist.items():
        image_ids[service] = capture(['docker', 'image', 'inspect', c['images'][service], '--format', '{{.Id}}'])
        cid = capture(['docker', 'create', '--platform', 'linux/amd64', c['images'][service]])
        candidate = out / ('candidate-' + service)
        candidate.mkdir()
        try:
            run(['docker', 'cp', cid + (':/app/migrations' if service == 'migrator' else ':/app/src'), str(candidate / 'tree')], stdout=subprocess.DEVNULL)
            fingerprints[service] = hashes(candidate / 'tree')
            prior, after = baseline_fingerprints[service], fingerprints[service]
            changed = {f for f in set(prior) | set(after) if prior.get(f) != after.get(f)}
            prefix = 'frontend/src/' if service == 'frontend' else 'src/' if service == 'api' else 'migrations/'
            assert changed == {f.removeprefix(prefix) for f in files}, 'UNEXPECTED_CANDIDATE_DIFF:' + service
            for rel in files:
                assert (candidate / 'tree' / rel.removeprefix(prefix)).read_bytes() == (context / rel).read_bytes(), 'CANDIDATE_SOURCE_MISMATCH'
            if service == 'frontend':
                run(['docker', 'cp', cid + ':/app/dist', str(out / 'frontend')], stdout=subprocess.DEVNULL)
        finally:
            run(['docker', 'rm', cid], stdout=subprocess.DEVNULL)
    # 生产前端仅发布dist，不导入累计多层的构建镜像，避免服务器overlay2层数上限。
    deployed_images = {service: c['images'][service] for service in ['api', 'migrator']}
    frontend_build_local_id = image_ids['frontend']
    run(['docker', 'save', '-o', str(out / 'images.tar')] + list(deployed_images.values()))
    config_ids = archive_image_ids(out / 'images.tar')
    image_ids = {service: config_ids[tag] for service, tag in deployed_images.items()}
    with (out / 'images.tar').open('rb') as source, gzip.open(out / 'images.tar.gz', 'wb', compresslevel=6) as target:
        shutil.copyfileobj(source, target)
    manifest = {'release': c['release'], 'commit': c['approvedCommit'], 'baselineCommit': c['baselineCommit'], 'baselineRelease': c['baselineRelease'], 'baselineImages': c['baselineImages'], 'images': deployed_images, 'frontendBuildLocalId': frontend_build_local_id, 'imageIds': image_ids, 'imagesSha256': sha(out / 'images.tar.gz'), 'frontend': hashes(out / 'frontend'), 'sourceFingerprints': fingerprints, 'baselineSourceFingerprints': baseline_fingerprints, 'whitelist': whitelist}
    write_json(out / 'artifact-manifest.json', manifest)
    shutil.copy2(args.config, out / 'release-config.json')
    with tarfile.open(out / 'release-files.tar.gz', 'w:gz') as archive:
        for name in ['frontend', 'artifact-manifest.json', 'release-config.json']:
            archive.add(out / name, arcname=name)
    print(json.dumps({'prepared': True, 'commit': c['approvedCommit'], 'staticFiles': len(manifest['frontend'])}))


if __name__ == '__main__':
    main()
