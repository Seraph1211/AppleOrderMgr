#!/usr/bin/env python3
"""备份前现场预检：复用正式门禁，绑定候选、旧版和真实验收。兼容 Python 3.6。"""
import argparse
import importlib.util
import json
import locale
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def loadModule(name, filename):
    """从同一制品加载固定工具，避免 PATH 中的替代实现。"""
    spec = importlib.util.spec_from_file_location(name, str(Path(__file__).with_name(filename)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GATE = loadModule('preflightGate', 'productionFrontendGate.py')
RELEASE = loadModule('preflightRelease', 'productionRelease.py')
require = RELEASE.require


def safePath(value):
    """拒绝相对路径、点段及符号链接祖先，不用 resolve 隐藏链接。"""
    require(isinstance(value, str) and value.startswith('/')
            and all(part not in ('.', '..') for part in value.split('/')),
            'PREFLIGHT_PATH_INVALID')
    path = Path(value)
    require(not any(part.is_symlink() for part in [path] + list(path.parents)),
            'PREFLIGHT_PATH_SYMLINK')
    return path


def readPlan(path):
    """读取预检计划；候选验收与测试环境检查不可缺省。"""
    plan = json.loads(safePath(str(path)).read_text(encoding='utf-8'))
    require(plan.get('schemaVersion') == 1 and plan.get('releaseId'), 'PREFLIGHT_PLAN')
    for key in ('candidate', 'expectedCurrent', 'output'):
        safePath(plan.get(key))
    current = plan.get('current')
    require(isinstance(current, str) and Path(current).is_absolute()
            and '..' not in current.split('/'), 'PREFLIGHT_PATH_INVALID')
    safePath(str(Path(current).parent))
    users = plan.get('nginxUsers')
    require(isinstance(users, list) and users and len(set(users)) == len(users)
            and all(isinstance(user, str) and user not in ('', 'root', '0:0')
                    for user in users), 'PREFLIGHT_IDENTITIES')
    checks = plan.get('checks')
    require(isinstance(checks, list) and len(checks) == 2
            and {row.get('id') for row in checks}
            == {'test-environment', 'candidate-acceptance'}, 'PREFLIGHT_CHECKS_REQUIRED')
    for row in checks:
        RELEASE.validateArgv(row.get('argv'))
        safePath(row.get('cwd'))
        require(type(row.get('timeoutSeconds')) is int
                and 1 <= row['timeoutSeconds'] <= 1800, 'PREFLIGHT_TIMEOUT')
    require(isinstance(plan.get('inputs'), list) and plan['inputs'], 'PREFLIGHT_INPUTS')
    for row in plan['inputs']:
        safePath(row.get('path'))
        require(isinstance(row.get('sha256'), str) and len(row['sha256']) == 64,
                'PREFLIGHT_INPUT_DIGEST')
    inputs = {row['path'] for row in plan['inputs']}
    classification = safePath(plan.get('classification'))
    require(str(classification) in inputs, 'PREFLIGHT_CLASSIFICATION_UNBOUND')
    document = json.loads(classification.read_text(encoding='utf-8'))
    require(document.get('releaseId') == plan['releaseId']
            and document.get('releaseClass') in ('A', 'B', 'C', 'D'),
            'PREFLIGHT_CLASSIFICATION_INVALID')
    for name in ('source-capabilities.json', 'runtime-source-proof.json', 'capabilities.json'):
        require(str(Path(plan['candidate']) / name) in inputs, 'PREFLIGHT_PROOF_UNBOUND')
    return plan


def fingerprint(plan):
    """核验冻结输入并散列全部公开文件和能力证明，检查期间漂移即失败。"""
    require(Path(plan['current']).is_symlink()
            and str(Path(plan['current']).resolve()) == plan['expectedCurrent'],
            'PREFLIGHT_CURRENT_CHANGED')
    result = {}
    for row in plan['inputs']:
        path = safePath(row['path'])
        digest = RELEASE.sha256File(path)[0]
        require(digest == row['sha256'], 'PREFLIGHT_INPUT_CHANGED')
        result[str(path)] = digest
    runtime = json.loads((Path(plan['candidate']) / 'runtime-source-proof.json').read_text(encoding='utf-8'))
    require(runtime.get('passed') is True
            and runtime.get('sourceManifestSha256') == RELEASE.sha256File(
                Path(plan['candidate']) / 'source-capabilities.json')[0],
            'PREFLIGHT_RUNTIME_PROOF_INVALID')
    for key in ('candidate', 'expectedCurrent'):
        release, directories, files, _assets = GATE.inventory(plan[key])
        # inventory covers reachable and unreferenced public assets; bind proofs too.
        for name in ('source-capabilities.json', 'runtime-source-proof.json',
                     'capabilities.json', 'rollback-target.json'):
            path = release / name
            if path.exists():
                safePath(str(path))
                files.append(path)
        for path in files:
            result[str(path)] = [RELEASE.sha256File(path)[0], path.stat().st_mode]
        for path in directories:
            result[str(path)] = path.stat().st_mode
    for name in ('productionReleasePreflight.py', 'productionFrontendGate.py'):
        path = Path(__file__).with_name(name)
        result[str(path)] = RELEASE.sha256File(path)[0]
    return RELEASE.sha256Bytes(RELEASE.canonicalBytes(result))


def runPreflight(path):
    """现场执行，失败输出不会遗留旧 passed 证明。"""
    raw = json.loads(safePath(str(path)).read_text(encoding='utf-8'))
    output = safePath(raw['output'])
    require(str(output) != str(path) and not any(
        isinstance(row, dict) and row.get('path') == str(output)
        for row in raw.get('inputs', [])), 'PREFLIGHT_OUTPUT_CONFLICT')
    for key in ('candidate', 'expectedCurrent'):
        public = safePath(raw[key]) / 'frontend'
        require(output != public and public not in output.parents, 'PREFLIGHT_OUTPUT_CONFLICT')
    report = {'schemaVersion': 1, 'releaseId': raw.get('releaseId'), 'passed': False,
              'planSha256': RELEASE.sha256File(path)[0], 'startedAtUtc': RELEASE.utcNow(),
              'checks': []}
    started = time.monotonic()
    try:
        plan = readPlan(path)
        require(sys.getfilesystemencoding().lower().replace('-', '') == 'utf8'
                and locale.getpreferredencoding().lower().replace('-', '') == 'utf8',
                'PREFLIGHT_UTF8')
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='预检-', dir=str(output.parent)) as directory:
            probe = Path(directory) / '中文.json'
            probe.write_bytes(json.dumps({'检查': True}, ensure_ascii=False).encode('utf-8'))
            require(probe.name in os.listdir(directory), 'PREFLIGHT_UTF8')
        before = fingerprint(plan)
        for user in plan['nginxUsers']:
            GATE.check(plan['candidate'], nginxUser=user,
                       expectedCurrent=plan['expectedCurrent'])
        for row in sorted(plan['checks'], key=lambda item: item['id'] != 'test-environment'):
            begin = time.monotonic()
            with open(os.devnull, 'wb') as sink:
                try:
                    environment = os.environ.copy()
                    environment['RELEASE_CANDIDATE'] = plan['candidate']
                    environment['RELEASE_ID'] = plan['releaseId']
                    result = subprocess.run(row['argv'], cwd=row['cwd'], stdout=sink,
                                            stderr=sink, env=environment,
                                            timeout=row['timeoutSeconds'])
                except subprocess.TimeoutExpired:
                    raise RELEASE.ReleaseError('PREFLIGHT_CHECK_TIMEOUT', row['id'])
            report['checks'].append({'id': row['id'], 'passed': result.returncode == 0,
                                     'durationMs': int((time.monotonic() - begin) * 1000)})
            require(result.returncode == 0, 'PREFLIGHT_CHECK_FAILED:' + row['id'])
        require(before == fingerprint(plan), 'PREFLIGHT_CANDIDATE_CHANGED')
        require(report['planSha256'] == RELEASE.sha256File(path)[0], 'PREFLIGHT_PLAN_CHANGED')
        report.update(passed=True, inputDigest=before)
        return report
    except Exception as error:
        report['code'] = getattr(error, 'code', 'PREFLIGHT_FAILED')
        raise RELEASE.ReleaseError(report['code'])
    finally:
        report['finishedAtUtc'] = RELEASE.utcNow()
        report['durationMs'] = int((time.monotonic() - started) * 1000)
        attempt = output.with_name(output.stem + '-' + uuid.uuid4().hex + '.json')
        RELEASE.writeJsonAtomic(attempt, report)
        RELEASE.writeJsonAtomic(output, report)


def main():
    """只输出脱敏证明，不输出子进程内容。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['run'])
    parser.add_argument('--plan', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(runPreflight(args.plan), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({'passed': False, 'code': getattr(error, 'code', 'PREFLIGHT_FAILED')}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
