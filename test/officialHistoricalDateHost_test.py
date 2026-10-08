"""历史日期宿主编排的纯mock故障回归；不执行Docker、官网或生产SQL。"""
import fcntl
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts/officialOrder'
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('historical_host', SCRIPTS / 'applyHistoricalDate.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class HistoricalHostTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name).resolve() / 'root'
        self.private = self.root / 'private'
        self.private.mkdir(parents=True)
        (self.root / 'evidence').mkdir()
        self.candidate = self.root / 'candidate'
        self.candidate.mkdir()
        self.module = self.candidate / 'applyHistoricalDate.js'
        self.module.write_text('candidate fixture')
        for name in ('http-batch.lock','http-sample.lock','http-apply.lock'):
            self.write_raw(self.private / name, b'')
        self.entry = {'id':605,'orderNumber':'W1234567890','previousDate':None,'dateMissing':True}
        plan = {'entries':[{'id':i} for i in range(1,489)]+[self.entry]}
        self.write(self.private / 'plan.json', plan)
        self.old = {'state':'APPLIED','resultFile':'old-result.json'}
        self.write(self.private / 'http-apply-intent-605.json',self.old)
        self.http_bytes = (self.private / 'http-apply-intent-605.json').read_bytes()
        self.write(self.private / 'old-result.json',{'dateFilled':False,'proposedDate':None,'previousDate':None,'afterHash':'a'*32})
        self.write(self.root / 'evidence/report.json',{'verified':True})
        self.helper = types.SimpleNamespace(writePrivate=self.write)
        self.batch = types.SimpleNamespace(validate_plan=lambda p:[e['id'] for e in p['entries']],
            JOURNALS=(),confirmed_applies=lambda *a:{605})
        self.boundary = types.SimpleNamespace(checkWriteBoundary=self.check_boundary,validateIntent=lambda *a:None)
        self.progress = types.SimpleNamespace(load_progress=lambda *a:(plan,'x',[{'id':605,'evidenceValid':True}],{}, {},{}))
        def loader(name,path):
            return {'historical_host_http_helper':self.helper,'historical_host_batch':self.batch,
                    'historical_host_boundary':self.boundary,'historical_host_progress':self.progress}[name]
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(M,'ROOT',self.root).start()
        mock.patch.object(M,'load_module',side_effect=loader).start()
        mock.patch.object(M,'source_digests',return_value={}).start()
        mock.patch.object(M,'make_proof',return_value={'sourceFiles':{},'sourceResult':{},
            'legacy':{'bodySha256':'b'*64,'observedAt':'2026-10-03T17:06:42.294Z','date':'2026-09-23'}}).start()
        self.database = mock.patch.object(M,'database',side_effect=self.database_result).start()
        self.readback = mock.patch.object(M,'readback_locked',return_value=('report.json',{'conflicts':0})).start()

    def write_raw(self,path,raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def write(self,path,value):
        self.write_raw(path,json.dumps(value,allow_nan=False).encode())

    def check_boundary(self,*args):
        if (self.private/'STOP').exists():raise RuntimeError('WRITE_BOUNDARY_STOP_REQUESTED')

    def database_result(self,root,helper,module,payload,mode,preview=None):
        return {'mode':mode,'orderId':605,'businessWrites':int(mode=='apply'),'dateFilled':mode=='apply',
                'beforeHash':'a'*32,'afterHash':('b' if mode=='apply' else 'a')*32,'payloadSha256':'c'*64}

    def execute(self,apply=True):
        return M.execute(self.root,self.candidate,apply)

    def intent(self):
        return json.loads((self.private/'historical-date-intent-605.json').read_bytes())

    def assert_old_preserved(self):
        self.assertEqual((self.private/'http-apply-intent-605.json').read_bytes(),self.http_bytes)

    def test_busy_global_lock_prevents_database_work(self):
        with (self.private/'http-batch.lock').open('a') as handle:
            fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):self.execute()
        self.database.assert_not_called()
        self.assertFalse((self.private/'STOP').exists())

    def test_dry_run_never_creates_stop_or_intent(self):
        result=self.execute(False)
        self.assertEqual(result['outcome'],'HISTORICAL_DATE_DRY_RUN')
        self.assertFalse((self.private/'STOP').exists())
        self.assertFalse((self.private/'historical-date-intent-605.json').exists())
        self.assertEqual([c.args[4] for c in self.database.call_args_list],['dry-run'])
        self.assert_old_preserved()

    def test_success_requires_readback_then_removes_only_own_stop(self):
        result=self.execute()
        self.assertEqual(result['outcome'],'HISTORICAL_DATE_APPLIED_VERIFIED')
        self.assertEqual(self.intent()['state'],'APPLIED')
        self.assertEqual(self.readback.call_count,1)
        self.assertFalse((self.private/'STOP').exists())
        self.assertEqual(len(list(self.private.glob('historical-date-605-*-completion.json'))),1)
        self.assert_old_preserved()
        calls=self.database.call_count
        with self.assertRaises(RuntimeError):self.execute()
        self.assertEqual(self.database.call_count,calls)

    def test_unknown_commit_keeps_stop_and_started_intent(self):
        def failure(*args):
            if args[4]=='apply':raise RuntimeError('UNKNOWN_COMMIT')
            return self.database_result(*args)
        self.database.side_effect=failure
        with self.assertRaises(RuntimeError):self.execute()
        self.assertTrue((self.private/'STOP').exists())
        self.assertEqual(self.intent()['state'],'APPLY_STARTED')
        self.readback.assert_not_called()
        self.assert_old_preserved()

    def test_readback_failure_after_commit_keeps_stop_and_applied_intent(self):
        self.readback.side_effect=RuntimeError('READBACK_FAILED')
        with self.assertRaises(RuntimeError):self.execute()
        self.assertTrue((self.private/'STOP').exists())
        self.assertEqual(self.intent()['state'],'APPLIED')
        self.assertFalse(list(self.private.glob('*-completion.json')))
        self.assert_old_preserved()

    def test_replaced_stop_is_never_deleted(self):
        def changed(*args):
            self.write_raw(self.private/'STOP',b'other operation')
            return 'report.json',{}
        self.readback.side_effect=changed
        with self.assertRaises(RuntimeError):self.execute()
        self.assertEqual((self.private/'STOP').read_bytes(),b'other operation')

    def test_preexisting_stop_blocks_before_database(self):
        self.write_raw(self.private/'STOP',b'existing')
        with self.assertRaises(RuntimeError):self.execute()
        self.database.assert_not_called()
        self.assertEqual((self.private/'STOP').read_bytes(),b'existing')

    def test_candidate_changes_after_preview_block_before_stop(self):
        def changed(*args):
            self.module.write_text('changed')
            return self.database_result(*args)
        self.database.side_effect=changed
        with self.assertRaises(RuntimeError):self.execute()
        self.assertFalse((self.private/'STOP').exists())
        self.assertEqual(self.database.call_count,1)

    def test_malformed_apply_output_keeps_started_intent(self):
        def changed(*args):
            result=self.database_result(*args)
            if args[4]=='apply':result['businessWrites']=2
            return result
        self.database.side_effect=changed
        with self.assertRaises(RuntimeError):self.execute()
        self.assertEqual(self.intent()['state'],'APPLY_STARTED')
        self.assertTrue((self.private/'STOP').exists())

    def test_result_persistence_failure_keeps_started_intent(self):
        def save(path,value):
            if path.name.startswith('historical-date-') and path.name.endswith('-result.json'):
                raise OSError('synthetic disk failure')
            self.write(path,value)
        self.helper.writePrivate=save
        with self.assertRaises(OSError):self.execute()
        self.assertEqual(self.intent()['state'],'APPLY_STARTED')
        self.assertTrue((self.private/'STOP').exists())


if __name__=='__main__':unittest.main()
