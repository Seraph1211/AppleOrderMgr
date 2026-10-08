#!/usr/bin/env python3
"""生成不含私密输入的可校验电子收据发布目录；目标必须尚不存在。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


# 固定收据运行依赖，合入主区后不能把其他官网任务或运行材料打入制品。
RELEASE_FILES = (
    'scripts/collectOfficialReceipt.js',
    'scripts/officialOrder/httpTransport.py',
    'scripts/officialOrder/requirements.txt',
    'scripts/officialReceiptBatch.py',
    'scripts/officialReceiptBusiness.js',
    'scripts/officialReceiptGate.js',
    'src/services/officialOrderAccount.js',
    'src/services/officialOrderBrowserReceipt.js',
    'src/services/officialOrderCdp.js',
    'src/services/officialOrderCollector.js',
    'src/services/officialOrderGate.js',
    'src/services/officialOrderGuestAction.js',
    'src/services/officialOrderHttpBootstrap.js',
    'src/services/officialOrderHttpCollector.js',
    'src/services/officialOrderHttpTransport.js',
    'src/services/officialOrderParser.js',
    'src/services/officialOrderProxyTunnel.js',
    'src/services/officialOrderReceipt.js',
    'src/services/officialOrderReceiptDom.js',
    'src/services/officialOrderRequestEvidence.js',
    'src/services/officialOrderShield.js',
    'src/services/officialOrderSupport.js',
    'src/services/officialReceiptBinding.js',
    'src/services/officialReceiptCapture.js',
    'src/services/officialReceiptCollector.js',
    'src/services/officialReceiptEvidence.js',
)

def package(source, target):
    files = [source / name for name in RELEASE_FILES]
    target.mkdir(mode=0o755, parents=True, exist_ok=False)
    manifest = {'version': 1, 'files': {}}
    for file in sorted(files):
        relative = file.relative_to(source)
        output = target / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(file), str(output))
        manifest['files'][str(relative)] = hashlib.sha256(output.read_bytes()).hexdigest()
    (target / 'receiptRelease.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(files), 'output': str(target)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target')
    args = parser.parse_args()
    package(Path(__file__).resolve().parents[1], Path(args.target).resolve())
