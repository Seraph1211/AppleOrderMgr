#!/usr/bin/env python3
"""校验已发布能力、记录源码来源，并把前端能力证明绑定到实际可达资源。"""
import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import io
import tarfile
from pathlib import Path

SOURCE_SUFFIXES = ('.js', '.jsx', '.cjs', '.mjs', '.py', '.json', '.css', '.sql', '.sh')


class SourceGuardError(Exception):
    """固定错误码；不输出源码、业务信息或凭据。"""


def digest(data):
    """返回 SHA-256。"""
    return hashlib.sha256(data).hexdigest()


def readContract(root):
    """读取版本控制中的能力要求，拒绝空表和重复编号。"""
    contract = json.loads((Path(root) / 'config/productionCapabilities.json').read_text(encoding='utf-8'))
    rows = contract.get('capabilities', [])
    ids = [row['id'] for row in rows]
    if contract.get('schemaVersion') != 1 or not ids or len(set(ids)) != len(ids):
        raise SourceGuardError('CAPABILITY_CONTRACT_INVALID')
    return contract


def checkSource(root):
    """检查每项能力的关键实现，并记录全部业务源码以供运行镜像对照。"""
    root = Path(root).resolve()
    contract = readContract(root)
    for row in contract['capabilities']:
        for relative, tokens in row['source'].items():
            path = root / relative
            if path.is_symlink() or not path.is_file() or root not in path.resolve().parents:
                raise SourceGuardError('CAPABILITY_SOURCE_MISSING:' + row['id'])
            source = path.read_text(encoding='utf-8')
            if not tokens or not all(token in source for token in tokens):
                raise SourceGuardError('CAPABILITY_SOURCE_REGRESSED:' + row['id'])
    inventory = {}
    for directory in ('src', 'scripts', 'migrations', 'frontend/src', 'config'):
        for path in sorted((root / directory).rglob('*')):
            if path.is_file() and path.suffix in SOURCE_SUFFIXES:
                if path.is_symlink():
                    raise SourceGuardError('SOURCE_SYMLINK_REJECTED')
                inventory[str(path.relative_to(root))] = digest(path.read_bytes())
    commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
    return {'schemaVersion': 1, 'sourceCommit': commit,
            'contractSha256': digest((root / 'config/productionCapabilities.json').read_bytes()),
            'capabilities': contract['capabilities'], 'sourceInventory': inventory}


def frontendProof(root, release):
    """源码检查通过后，要求实际可达 JS 包也包含对应能力的可识别行为文案。"""
    result = checkSource(root)
    gatePath = Path(__file__).with_name('productionFrontendGate.py')
    spec = importlib.util.spec_from_file_location('sourceGuardFrontendGate', str(gatePath))
    gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gate)
    _release, _directories, _files, assets = gate.inventory(release)
    scripts = {url: path.read_text(encoding='utf-8') for url, path in assets.items()
               if path.suffix == '.js'}
    proofs = []
    for row in result['capabilities']:
        tokens = row['frontendTokens']
        matches = {}
        for token in tokens:
            urls = [url for url, source in scripts.items() if token in source]
            if not urls:
                raise SourceGuardError('CAPABILITY_BUILD_REGRESSED:' + row['id'])
            matches[token] = urls[0]
        proofs.append({'id': row['id'], 'tokens': matches})
    result['capabilities'] = proofs
    result['assets'] = {url: digest(path.read_bytes()) for url, path in assets.items()}
    return result


def runtimeProof(image, manifest):
    """在断网只读容器读取源码，拒绝运行镜像与已检查源码不一致。"""
    expected = json.loads(Path(manifest).read_text(encoding='utf-8'))
    source = {name: value for name, value in expected['sourceInventory'].items()
              if name.startswith(('src/', 'scripts/'))}
    archive = subprocess.check_output(['docker', 'run', '--rm', '--network', 'none',
                                      '--read-only', '--entrypoint', 'tar', image,
                                      '-C', '/app', '-cf', '-', 'src', 'scripts'])
    actual = {}
    with tarfile.open(fileobj=io.BytesIO(archive), encoding='utf-8') as stream:
        for entry in stream:
            if entry.isfile() and entry.name.endswith(SOURCE_SUFFIXES):
                actual[entry.name] = digest(stream.extractfile(entry).read())
    if source != actual:
        raise SourceGuardError('RUNTIME_SOURCE_MISMATCH')
    imageId = subprocess.check_output(['docker', 'image', 'inspect', image,
                                      '--format', '{{.Id}}']).decode().strip()
    return {'schemaVersion': 1, 'passed': True, 'imageId': imageId,
            'sourceManifestSha256': digest(Path(manifest).read_bytes()),
            'sourceFiles': len(source)}


def main():
    """生成源码或制品证明；失败时阻断构建。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('source', 'frontend', 'runtime'))
    parser.add_argument('--root', default='.')
    parser.add_argument('--release')
    parser.add_argument('--output')
    parser.add_argument('--image')
    parser.add_argument('--manifest')
    args = parser.parse_args()
    try:
        if args.command == 'runtime':
            result = runtimeProof(args.image, args.manifest)
        else:
            result = (checkSource(args.root) if args.command == 'source'
                      else frontendProof(args.root, args.release))
        if args.output:
            path = Path(args.output)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'passed': True, 'capabilities': len(result.get('capabilities', [])),
                          'sourceFiles': result.get('sourceFiles')}))
        return 0
    except Exception as error:
        print(json.dumps({'passed': False, 'code': str(error) if isinstance(error, SourceGuardError)
                          else 'SOURCE_GUARD_FAILED'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
