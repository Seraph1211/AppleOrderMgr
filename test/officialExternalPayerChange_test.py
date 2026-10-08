"""固定付款附加基线、只读preview失败闭合及历史回放的边界回归。"""
import copy,hashlib,json,pathlib,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts/officialOrder'))
import externalPayerChange as m
import runHttpBatch as batch

class PayerProofTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name);self.private=self.root/'private';self.private.mkdir()
        self.plan={'entries':[{'id':i,'rowHash':'a'*32} for i in m.IDS]}
        plan_sha=self.write('plan.json',self.plan)
        self.patch=patch.object(m,'PLAN_SHA',plan_sha);self.patch.start();self.addCleanup(self.patch.stop)
        records=[]
        for e in self.plan['entries']:
            i=e['id'];files={}
            if i!=1113:
                for n in ['http-apply-intent-%d.json'%i,'http-apply-%d-test-result.json'%i]:files[n]=self.write(n,{'id':i})
            records.append({'id':i,'entry':e,'kind':'ORIGINAL' if i==1113 else 'AFTER_HTTP','sourceFiles':files,
                'beforeHash':'b'*32,'acceptedFullHash':'c'*32,'acceptedOriginalHash':'d'*32,
                'acceptedStableHash':'e'*32,'httpStableHash':'f'*32,'devicesHash':'1'*64,'acceptedSnapshot':{'id':i}})
        self.proof={'version':1,'kind':'VERIFIED_EXTERNAL_PAYER_CHANGE','planSha256':plan_sha,'businessWrites':0,'records':records}
        self.proof_patch=patch.object(m,'PROOF_SHA',self.write(m.PROOF_NAME,self.proof));self.proof_patch.start();self.addCleanup(self.proof_patch.stop)
        self.sample={'attemptId':m.CLOSE_SAMPLE,'runId':1437,'outcome':'SUCCEEDED','businessWrites':0,'finishedAt':10,'targetOrderId':1113,'receiptOutcome':'RECEIPT_NOT_REQUESTED'}
        self.failure={'outcome':'HTTP_APPLY_ORDER_CHANGED','businessWrites':0}
        self.close={'version':1,'kind':'DRY_PREVIEW_PAYER_CONFLICT','orderId':1113,'batchAttemptId':m.CLOSE_BATCH,
          'sample':self.sample,'failure':self.failure,'sourceFiles':{'error.json':self.write('error.json',self.failure)},'businessWrites':0,'targetCompleted':False}
        self.close_patch=patch.object(m,'CLOSE_SHA',self.write(m.CLOSE_NAME,self.close));self.close_patch.start();self.addCleanup(self.close_patch.stop)
        self.event={'event':'payer_preview_failure_reconciled','orderId':1113,'planSha256':plan_sha,'batchAttemptId':m.CLOSE_BATCH,
          'sampleAttemptId':m.CLOSE_SAMPLE,'proofFile':m.CLOSE_NAME,'proofSha256':m.CLOSE_SHA,
          'resolution':'READ_ONLY_PREVIEW_PAYER_CONFLICT','businessWrites':0,'targetCompleted':False,'at':11}
    def write(self,name,value):
        raw=json.dumps(value).encode();p=self.private/name;p.write_bytes(raw);p.chmod(0o600);return hashlib.sha256(raw).hexdigest()
    def expected(self):
        return [{'id':i,'evidenceValid':True,'http':True,'afterHash':'b'*32,'stableRowHash':'f'*32,'devicesHash':'1'*64} for i in m.IDS[:-1]]
    def test_fixed_proof_and_derived_hashes_keep_original_plan(self):
        original=copy.deepcopy(self.plan);expected=self.expected();records=m.adjust_progress(self.root,expected,self.plan)
        self.assertEqual(self.plan,original);self.assertEqual(len(records),6)
        self.assertTrue(all(x['afterHash']=='c'*32 and x['stableRowHash']=='e'*32 for x in expected))
    def test_proof_tamper_rejected(self):
        self.write(m.PROOF_NAME,dict(self.proof,businessWrites=1))
        with self.assertRaises(RuntimeError):m.load_proof(self.root)
    def test_original_file_tamper_rejected(self):
        self.write('http-apply-intent-220.json',{'id':221})
        with self.assertRaises(RuntimeError):m.load_proof(self.root)
    def test_original_plan_change_rejected(self):
        self.write('plan.json',{'entries':[]})
        with self.assertRaises(RuntimeError):m.load_proof(self.root)
    def test_absent_proof_no_exception(self):
        (self.private/m.PROOF_NAME).unlink();self.assertIsNone(m.load_proof(self.root))
    def test_wrong_expected_chain_rejected(self):
        for key,value in [('evidenceValid',False),('afterHash','x'*32),('stableRowHash','x'*32),('devicesHash','x'*64),('receipt',True)]:
            with self.subTest(key=key):
                expected=self.expected();expected[0][key]=value
                with self.assertRaises(RuntimeError):m.adjust_progress(self.root,expected,self.plan)
    def test_later_http_must_start_from_accepted_row(self):
        name='http-apply-1113-'+ '8'*32 +'-result.json'
        self.write('http-apply-intent-1113.json',{'state':'APPLIED','resultFile':name})
        self.write(name,{'beforeHash':'c'*32,'snapshot':{'order':{'id':1113}}})
        expected=self.expected()+[{'id':1113,'evidenceValid':True,'http':True,'beforeHash':'c'*32,'stableRowHash':'e'*32,'devicesHash':'1'*64}]
        m.adjust_progress(self.root,expected,self.plan)
        self.write(name,{'beforeHash':'0'*32,'snapshot':{'order':{'id':1113}}})
        expected=self.expected()+[dict(expected[-1])]
        with self.assertRaises(RuntimeError):m.adjust_progress(self.root,expected,self.plan)
    def test_only_1113_can_obtain_baseline(self):
        self.assertIsNone(m.apply_record(self.root,{'entry':{'id':220}}))
        payload={'entry':self.plan['entries'][-1],'planSha256':m.PLAN_SHA}
        self.assertEqual(m.apply_record(self.root,payload)['id'],1113)
        with self.assertRaises(RuntimeError):m.apply_record(self.root,dict(payload,planSha256='wrong'))
    def test_closure_does_not_claim_completion_and_replays_after_later_apply(self):
        self.assertEqual(m.verify_preview_closure(self.root,self.event,self.sample,self.failure),self.close)
        self.write('http-apply-intent-1113.json',{'state':'APPLIED'})
        self.assertEqual(m.verify_preview_closure(self.root,self.event,self.sample,self.failure),self.close)
    def test_closure_rejects_modified_event_sample_or_error(self):
        for key,value in [('businessWrites',True),('targetCompleted',True),('orderId',220),('batchAttemptId','a'*32),('at',9)]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):m.verify_preview_closure(self.root,dict(self.event,**{key:value}),self.sample,self.failure)
        with self.assertRaises(RuntimeError):m.verify_preview_closure(self.root,self.event,dict(self.sample,runId=1),self.failure)
        with self.assertRaises(RuntimeError):m.verify_preview_closure(self.root,self.event,self.sample,dict(self.failure,outcome='UNKNOWN'))
        self.write('error.json',{'outcome':'altered'})
        with self.assertRaises(RuntimeError):m.verify_preview_closure(self.root,self.event,self.sample,self.failure)
    def test_state_machine_closes_only_matching_apply_failed(self):
        base={'orderId':1113,'batchAttemptId':m.CLOSE_BATCH,'planSha256':m.PLAN_SHA}
        rows=[dict(base,event='order_started',at=1),dict(base,event='sample_finished',sample=self.sample,at=10),dict(base,event='apply_failed',result=self.failure,at=10.5),self.event]
        pending={};finished=batch.journal_order_state(self.private/'http-batch-apply.jsonl',[json.dumps(r) for r in rows],m.PLAN_SHA,{1113},{},pending,set())
        self.assertEqual(finished,set());self.assertEqual(pending,{})
        with self.assertRaises(RuntimeError):batch.journal_order_state(self.private/'http-batch-apply.jsonl',[json.dumps(r) for r in rows if r['event']!='apply_failed'],m.PLAN_SHA,{1113},{},{},set())
        rows.append(dict(base,event='order_started',batchAttemptId='9'*32,at=12));pending={}
        batch.journal_order_state(self.private/'http-batch-apply.jsonl',[json.dumps(r) for r in rows],m.PLAN_SHA,{1113},{},pending,set())
        self.assertEqual(pending['batchAttemptId'],'9'*32)

if __name__=='__main__':unittest.main()
