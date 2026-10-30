"""按白名单校验生产适配源码，不读取或输出业务配置。"""
import hashlib
import json
import sys
from pathlib import Path


def main():
    mode = sys.argv[1]
    if mode not in ['before', 'after']:
        raise ValueError('MODE_INVALID')
    root = Path(sys.argv[2]).resolve()
    manifest = json.loads(Path(__file__).with_name('制品白名单.json').read_text(encoding='utf-8'))
    for name, hashes in manifest['files'].items():
        path = root / name
        expected = hashes[mode + 'Sha256']
        if expected is None:
            if path.exists():
                raise ValueError('UNEXPECTED_EXISTING_SOURCE:' + name)
        elif not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('SOURCE_HASH_MISMATCH:' + name)
    print(json.dumps({'passed': True, 'mode': mode, 'files': len(manifest['files'])}))


if __name__ == '__main__':
    main()
