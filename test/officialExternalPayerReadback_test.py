"""第二批付款证明只读连接边界；不改变原计划或授予写入许可。"""
import copy
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'scripts/officialOrder'))
import externalPayerReadback as m

class ReadbackTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(tmp.name); (self.root / 'private').mkdir()
        self.plan = {'entries': [{'id': i} for i in m.IDS]}
        plan_sha = self.write('plan.json', self.plan)
        records = []
        for entry in self.plan['entries']:
            i = entry['id']
            files = {name: self.write(name, {'id': i}) for name in
                     ['http-apply-intent-%s.json' % i, 'http-apply-%s-test-result.json' % i]}
            records.append({'id': i, 'entry': entry, 'kind': 'AFTER_HTTP', 'sourceFiles': files,
                            'beforeHash': 'a'*32, 'httpStableHash': 'b'*32, 'devicesHash': 'c'*64,
                            'acceptedFullHash': 'd'*32, 'acceptedStableHash': 'e'*32})
        self.proof = {'version': 1, 'kind': 'VERIFIED_EXTERNAL_PAYER_CHANGE',
                      'planSha256': plan_sha, 'businessWrites': 0, 'records': records}
        for key, value in [('PLAN_SHA', plan_sha), ('PROOF_SHA', self.write(m.PROOF_NAME, self.proof)),
                           ('adjust_first', lambda *_: [{'id': 220}])]:
            p = patch.object(m, key, value); p.start(); self.addCleanup(p.stop)
    def write(self, name, value):
        raw = json.dumps(value).encode(); path = self.root / 'private' / name
        path.write_bytes(raw); path.chmod(0o600); return hashlib.sha256(raw).hexdigest()
    def expected(self):
        return [{'id': i, 'evidenceValid': True, 'http': True, 'afterHash': 'a'*32,
                 'stableRowHash': 'b'*32, 'devicesHash': 'c'*64} for i in m.IDS]
    def test_preserves_plan_and_prior_proof(self):
        original = copy.deepcopy(self.plan); expected = self.expected()
        records = m.adjust_progress(self.root, expected, self.plan)
        self.assertEqual(original, self.plan)
        self.assertEqual([r['id'] for r in records], [220] + list(m.IDS))
        self.assertTrue(all(e['afterHash'] == 'd'*32 and e['stableRowHash'] == 'e'*32 for e in expected))
    def test_missing_or_tampered_proof_rejected(self):
        self.write(m.PROOF_NAME, dict(self.proof, businessWrites=1))
        with self.assertRaises(RuntimeError): m.adjust_progress(self.root, self.expected(), self.plan)
        (self.root/'private'/m.PROOF_NAME).unlink()
        with self.assertRaises(Exception): m.adjust_progress(self.root, self.expected(), self.plan)
    def test_source_and_plan_tampering_rejected(self):
        for name in ['http-apply-intent-300.json', 'plan.json']:
            path = self.root/'private'/name; raw = path.read_bytes(); self.write(name, {})
            with self.assertRaises(RuntimeError): m.adjust_progress(self.root, self.expected(), self.plan)
            path.write_bytes(raw)
    def test_unverified_or_changed_http_chain_rejected(self):
        for key, value in [('evidenceValid', False), ('http', False), ('receipt', True),
                           ('afterHash', 'x'*32), ('stableRowHash', 'x'*32), ('devicesHash', 'x'*64)]:
            with self.subTest(key=key):
                expected = self.expected(); expected[0][key] = value
                with self.assertRaises(RuntimeError): m.adjust_progress(self.root, expected, self.plan)
    def test_fixed_targets_only(self):
        self.proof['records'][0]['id'] = 302
        with patch.object(m, 'PROOF_SHA', self.write(m.PROOF_NAME, self.proof)):
            with self.assertRaises(RuntimeError): m.adjust_progress(self.root, self.expected(), self.plan)
    def test_reject_duplicate_prior_proof(self):
        with patch.object(m, 'adjust_first', lambda *_: [{'id': 300}]):
            with self.assertRaises(RuntimeError): m.adjust_progress(self.root, self.expected(), self.plan)

if __name__ == '__main__': unittest.main()
