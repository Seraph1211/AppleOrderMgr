"""收据制品只包含显式依赖，不混入主区其他官网任务或私密输入。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('receiptPackage', str(Path(__file__).parents[1] / 'scripts/packageOfficialReceipt.py'))
receiptPackage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiptPackage)


class PackageTests(unittest.TestCase):
    def test_only_explicit_runtime_files_are_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            for name in receiptPackage.RELEASE_FILES:
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('synthetic fixture: ' + name)
            unrelated = source / 'src/services/officialOrderUnrelated.js'
            unrelated.write_text('must not enter receipt release')
            private = source / 'private/credentials.json'
            private.parent.mkdir()
            private.write_text('{"fixture":"not a real credential"}')
            target = root / 'release'
            receiptPackage.package(source, target)
            manifest = json.loads((target / 'receiptRelease.json').read_text())
            self.assertEqual(set(manifest['files']), set(receiptPackage.RELEASE_FILES))
            self.assertFalse((target / unrelated.relative_to(source)).exists())
            self.assertFalse((target / private.relative_to(source)).exists())
            for name, digest in manifest['files'].items():
                self.assertEqual(hashlib.sha256((target / name).read_bytes()).hexdigest(), digest)

    def test_existing_release_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'release'
            target.mkdir()
            marker = target / 'unchanged'
            marker.write_text('existing release')
            with self.assertRaises(FileExistsError):
                receiptPackage.package(root, target)
            self.assertEqual(marker.read_text(), 'existing release')


if __name__ == '__main__':
    unittest.main()
