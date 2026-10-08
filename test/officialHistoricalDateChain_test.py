"""历史填空独立链合成回归；无官网、生产或真实账号访问。"""
import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import pathlib
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('history', pathlib.Path(__file__).resolve().parents[1] / 'scripts/officialOrder/historicalDateChain.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


class HistoricalDateChainTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name) / 'current'
        self.legacy = pathlib.Path(self.directory.name) / 'legacy'
        (self.root / 'private').mkdir(parents=True)
        files = {}
        for name in M.SOURCE_FILES:
            path = self.legacy / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
            path.chmod(0o600)
            files[name] = M.sha(path.read_bytes())
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(M, 'LEGACY_ROOT', self.legacy).start()
        mock.patch.object(M, 'EVENTS_SHA', files['evidence/run-47/events.jsonl']).start()
        mock.patch.object(M, 'STATE_SHA', files['evidence/run-47/state.json']).start()
        self.plan_hash = 'a' * 64
        self.before_hash = 'c' * 32
        self.prefix = 'historical-date-605-' + 'd' * 32
        self.source = {'orderNumber': 'W1234567890', 'identityMatched': True, 'sourceModel': 'orderDetail',
                       'completeItemCount': 2, 'orderPlacedDateText': '2026年9月20日',
                       'products': [{'quantity': 1, 'rawStatus': 'PICKED_UP', 'pickupDateText': '已取货 9月23日'}] * 2}
        http_hash = self.write('http-apply-intent-605.json', {'state': 'APPLIED'})
        proof = {'version': 1, 'orderId': 605, 'planSha256': self.plan_hash, 'httpIntentSha256': http_hash,
                 'sourceFiles': files, 'sourceResult': self.source,
                 'legacy': {'outcome': 'HISTORICAL_LEGACY_SEALED_CHAIN_VERIFIED', 'orderId': 605, 'runId': 47,
                 'bodySha256': M.BODY_SHA, 'sealedResultSha256': M.SEALED_SHA, 'eventsSha256': M.EVENTS_SHA,
                 'stateSha256': M.STATE_SHA, 'date': '2026-09-23', 'reason': None,
                 'observedAt': '2026-10-03T17:06:42.294Z', 'products': 2, 'businessWrites': 0, 'network': 'none',
                 'currentHttpAuditCompatible': False, 'missingEncryptedResponse': True},
                 'research': {'database': 'apple_account_research', 'attemptCount': 1, 'run': {'id': 47,
                  'sampleId': 605, 'mode': 'collect', 'outcome': 'SUCCEEDED', 'requests': 43,
                  'startedAt': '2026-10-03T17:06:24.302Z', 'finishedAt': '2026-10-03T17:06:42.807Z'}}}
        proof_hash = self.write(self.prefix + '-proof.json', proof)
        payload = {'version': 1, 'kind': 'VERIFIED_LEGACY_PICKUP_DATE', 'orderId': 605,
                   'orderNumber': self.source['orderNumber'], 'sourceRunId': 47, 'sourceBodySha256': M.BODY_SHA,
                   'sourceObservedAt': proof['legacy']['observedAt'], 'sourceResult': self.source,
                   'planSha256': self.plan_hash, 'proofSha256': proof_hash, 'proposedDate': '2026-09-23',
                   'priorHttpAfterHash': self.before_hash}
        self.write(self.prefix + '-payload.json', payload)
        before = {'id': 605, 'actual_pickup_date': None, 'official_raw_status': 'RETURN_STARTED', 'manual_note': 'unchanged'}
        preview = {'version': 1, 'mode': 'dry-run', 'orderId': 605, 'payloadSha256': digest(payload),
                   'proofSha256': proof_hash, 'beforeHash': self.before_hash, 'afterHash': self.before_hash,
                   'previousDate': None, 'proposedDate': '2026-09-23', 'dateFilled': False, 'businessWrites': 0,
                   'beforeSnapshot': before, 'afterSnapshot': before, 'devices': [], 'devicesHash': digest([])}
        result = dict(preview, mode='apply', afterHash='e' * 32, dateFilled=True, businessWrites=1,
                      afterSnapshot=dict(before, actual_pickup_date='2026-09-23'))
        self.write(self.prefix + '-preview.json', preview)
        self.write(self.prefix + '-result.json', result)
        intent = {'version': 1, 'state': 'APPLIED', 'orderId': 605, 'attemptId': 'd' * 32,
                  'planSha256': self.plan_hash, 'httpIntentSha256': http_hash}
        for kind in ('proof', 'payload', 'preview', 'result'):
            intent[kind + 'File'] = self.prefix + '-' + kind + '.json'
        self.write('historical-date-intent-605.json', intent)
        self.expected = [{'id': 605, 'orderNumber': self.source['orderNumber'], 'http': True,
                          'evidenceValid': True, 'afterHash': self.before_hash, 'devicesHash': digest([])}]
        self.metadata = {605: {'dateFilledThisTask': False, 'statusWrittenThisTask': True}}

    def write(self, name, value):
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        path = self.root / 'private' / name
        path.write_bytes(raw)
        path.chmod(0o600)
        return M.sha(raw)

    def change(self, kind, callback):
        name = 'historical-date-intent-605.json' if kind == 'intent' else self.prefix + '-' + kind + '.json'
        value = M.named(self.root, name)[0]
        callback(value)
        self.write(name, value)

    def load(self):
        M.apply_historical_chain(self.root, self.expected, self.metadata, self.plan_hash)

    def test_valid_separate_chain_preserves_http_and_attributes_date(self):
        self.load()
        self.assertEqual(self.expected[0]['afterHash'], 'e' * 32)
        self.assertEqual(self.expected[0]['historicalDate']['originalHttpAfterHash'], self.before_hash)
        self.assertTrue(self.metadata[605]['dateFilledThisTask'])
        self.assertTrue(self.metadata[605]['statusWrittenThisTask'])
        self.assertEqual(M.named(self.root, 'http-apply-intent-605.json')[0], {'state': 'APPLIED'})

    def test_no_history_keeps_existing_results(self):
        (self.root / 'private/historical-date-intent-605.json').unlink()
        before = copy.deepcopy(self.expected)
        self.load()
        self.assertEqual(self.expected, before)
        self.assertFalse(self.metadata[605]['dateFilledThisTask'])

    def test_invalid_variants_rejected_without_attribution(self):
        cases = [('intent', lambda x: x.update(state='APPLY_STARTED')),
                 ('intent', lambda x: x.update(orderId=606)),
                 ('intent', lambda x: x.update(httpIntentSha256='f' * 64)),
                 ('payload', lambda x: x.update(priorHttpAfterHash='f' * 32)),
                 ('result', lambda x: x.update(previousDate='2026-09-22')),
                 ('result', lambda x: x.update(businessWrites=True)),
                 ('result', lambda x: x.update(dateFilled=False)),
                 ('result', lambda x: x['afterSnapshot'].update(official_raw_status='PICKED_UP')),
                 ('result', lambda x: x['afterSnapshot'].update(manual_note='changed')),
                 ('result', lambda x: x.update(devices=[{'id': 'unexpected'}])),
                 ('preview', lambda x: x.update(payloadSha256='f' * 64)),
                 ('proof', lambda x: x['research']['run'].update(sampleId=606)),
                 ('proof', lambda x: x['legacy'].update(bodySha256='f' * 64))]
        original = {p.name: p.read_bytes() for p in (self.root / 'private').iterdir()}
        for kind, mutate in cases:
            with self.subTest(kind=kind):
                self.change(kind, mutate)
                with self.assertRaises(RuntimeError): self.load()
                self.assertEqual(self.expected[0]['afterHash'], self.before_hash)
                self.assertFalse(self.metadata[605]['dateFilledThisTask'])
                for name, raw in original.items(): (self.root / 'private' / name).write_bytes(raw)

    def test_changed_original_cipher_rejected(self):
        (self.legacy / 'evidence/run-47/body-6-67ac30a975598bd0.enc').write_bytes(b'changed')
        with self.assertRaises(RuntimeError): self.load()

    def test_symlink_source_rejected(self):
        path = self.legacy / 'private/evidence.key'
        path.unlink()
        path.symlink_to(self.legacy / 'evidence/run-47/state.json')
        with self.assertRaises(RuntimeError): self.load()

    def test_other_target_intent_not_silently_ignored(self):
        self.write('historical-date-intent-606.json', {})
        with self.assertRaises(RuntimeError): self.load()

    @unittest.skipUnless(os.environ.get('RUN_HISTORICAL_NODE_TEST') == '1', 'explicit isolated Node/PG test')
    def test_native_json_hash_and_real_pg_snapshot_hashes(self):
        self.load()
        script = 'const expected=' + json.dumps(self.expected, ensure_ascii=True) + ';\n'
        script += "const crypto=require('crypto'),{isDeepStrictEqual:equal}=require('util');const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');function checkRow(){return {ok:true}};\n"
        script += M.HISTORY_CHECK_JS
        script += "const {Client}=require('pg');if(process.env.DB_HOST!=='official-order-rebuild-postgres')throw Error('DB_DENIED');const client=new Client({host:process.env.DB_HOST,user:'postgres',password:'test-only',database:'postgres'});(async()=>{try{await client.connect();await client.query(\"CREATE TEMP TABLE orders(id int,order_number text,actual_pickup_date date,official_raw_status text,amount numeric(12,2));INSERT INTO orders VALUES(605,'W1234567890','2026-09-23','RETURN_STARTED',123.00)\");await client.query('BEGIN READ ONLY');const h=expected[0].historicalDate;const original=await client.query(\"SELECT md5(jsonb_set(to_jsonb(o),'{actual_pickup_date}','null'::jsonb)::text) AS before,md5(to_jsonb(o)::text) AS after,to_jsonb(o) AS after_snapshot,jsonb_set(to_jsonb(o),'{actual_pickup_date}','null'::jsonb) AS before_snapshot FROM orders o\");h.originalHttpAfterHash=original.rows[0].before;h.result.afterHash=original.rows[0].after;h.result.beforeSnapshot=original.rows[0].before_snapshot;h.result.afterSnapshot=original.rows[0].after_snapshot;const oldSerialization=await client.query('SELECT md5(($1::jsonb)::text) AS hash',[JSON.stringify(h.result.afterSnapshot)]);const numericScaleRegression=oldSerialization.rows[0].hash!==h.result.afterHash;\n"
        script += M.HISTORY_QUERY_JS
        script += "const good=checkRow(expected[0]);h.payload.proposedDate='2026-09-24';const badPayload=checkRow(expected[0]);h.payload.proposedDate='2026-09-23';h.result.afterHash='f'.repeat(32);h.hashesVerified=true;let failed=false;try{\n"
        script += M.HISTORY_QUERY_JS
        script += "}catch(_){failed=true;}process.stdout.write(JSON.stringify({good,badPayload,failed,verifiedAfterMismatch:h.hashesVerified,numericScaleRegression}));await client.query('ROLLBACK');}finally{await client.end();}})().catch(()=>{process.exitCode=1});"
        response = subprocess.run(['docker','compose','-p','apple-official-rebuild','-f','/tmp/apple-official-rebuild-compose.yml','exec','-T','api','node','-'],input=script.encode('utf-8'),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.assertEqual(response.returncode, 0, response.stderr.decode())
        result = json.loads(response.stdout)
        self.assertTrue(result['numericScaleRegression'])
        self.assertTrue(result['good']['ok'])
        self.assertFalse(result['badPayload']['ok'])
        self.assertTrue(result['failed'])
        self.assertFalse(result['verifiedAfterMismatch'])

    def test_duplicate_keys_and_infinite_numbers_rejected(self):
        for raw in (b'{"state":"APPLIED","state":"APPLY_STARTED"}', b'{"number":1e309}'):
            with self.assertRaises(RuntimeError): M.strict_json(raw)


if __name__ == '__main__':
    unittest.main()
