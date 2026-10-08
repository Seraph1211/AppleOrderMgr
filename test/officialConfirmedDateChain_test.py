"""四笔用户确认日期的独立链及篡改回归。"""
import copy,hashlib,json,pathlib,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]/'scripts/officialOrder'))
import confirmedDateChain as m

class ConfirmedChainTests(unittest.TestCase):
 def setUp(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.root=pathlib.Path(tmp.name);(self.root/'private').mkdir()
  self.expected=[];entries=[];before=[];after=[]
  for order_id,date,run_id in m.CASES:
   source={'id':order_id};name='http-apply-%s-old-payload.json'%order_id;self.write(name,{'result':source})
   digest=self.write('http-apply-intent-%s.json'%order_id,{'state':'APPLIED','runId':run_id,'payloadFile':name})
   self.expected.append({'id':order_id,'orderNumber':'W'+str(order_id),'evidenceValid':True,'http':True,'afterHash':'a'*32,'devicesHash':'b'*64})
   entries.append({'orderId':order_id,'proposedDate':date,'runId':run_id,'httpIntentSha256':digest,
     'priorHttpAfterHash':'a'*32,'orderNumber':'W'+str(order_id),'sourceResult':source})
   row={'orderId':order_id,'beforeHash':'a'*32,'afterHash':'a'*32,'beforeSnapshot':{'id':order_id,'actual_pickup_date':None},
    'afterSnapshot':{'id':order_id,'actual_pickup_date':None},'devices':[],'devicesHash':'b'*64,'proposedDate':date}
   before.append(row);new=copy.deepcopy(row);new['afterSnapshot']['actual_pickup_date']=date;new['afterHash']='c'*32;after.append(new)
  self.payload={'version':1,'planSha256':'d'*64,'authorization':'这4单按照原样保存即可','entries':entries}
  self.preview={'mode':'dry-run','businessWrites':0,'payloadSha256':'e'*64,'rows':before}
  self.result={'mode':'apply','businessWrites':4,'payloadSha256':'e'*64,'rows':after}
  self.intent={'version':1,'state':'APPLIED','attemptId':'f'*32,'planSha256':'d'*64}
  self.save()
 def write(self,name,value):
  raw=json.dumps(value).encode();p=self.root/'private'/name;p.write_bytes(raw);p.chmod(0o600);return hashlib.sha256(raw).hexdigest()
 def save(self):
  for kind in ('payload','preview','result'):
   name='confirmed-pickup-dates-'+'f'*32+'-'+kind+'.json';self.intent[kind+'File']=name
   self.intent[kind+'Sha256']=self.write(name,getattr(self,kind))
  self.write(m.INTENT,self.intent)
 def test_four_dates_attributed_without_changing_original_http_files(self):
  metadata={};m.apply_confirmed_chain(self.root,self.expected,metadata,'d'*64)
  self.assertTrue(all(e['afterHash']=='c'*32 for e in self.expected));self.assertEqual(len(metadata),4)
  self.assertTrue(all(x['dateFilledThisTask'] for x in metadata.values()))
 def test_unknown_commit_rejected(self):
  self.intent['state']='APPLY_STARTED';self.save()
  with self.assertRaises(RuntimeError):m.apply_confirmed_chain(self.root,self.expected,{},'d'*64)
 def test_file_tamper_rejected(self):
  self.write(self.intent['resultFile'],{})
  with self.assertRaises(RuntimeError):m.apply_confirmed_chain(self.root,self.expected,{},'d'*64)
 def test_extra_field_change_rejected(self):
  self.result['rows'][0]['afterSnapshot']['notes']='changed';self.save()
  with self.assertRaises(RuntimeError):m.apply_confirmed_chain(self.root,self.expected,{},'d'*64)
 def test_authorization_date_and_source_tamper_rejected(self):
  for kind in ('authorization','date','source','devices','priorHash'):
   with self.subTest(kind=kind):
    original=copy.deepcopy((self.payload,self.result))
    if kind=='authorization':self.payload['authorization']='unknown'
    if kind=='date':self.payload['entries'][0]['proposedDate']='2026-09-28'
    if kind=='source':self.payload['entries'][0]['sourceResult']={}
    if kind=='devices':self.result['rows'][0]['devices']=[1]
    if kind=='priorHash':self.expected[0]['afterHash']='0'*32
    self.save()
    with self.assertRaises(RuntimeError):m.apply_confirmed_chain(self.root,copy.deepcopy(self.expected),{},'d'*64)
    self.payload,self.result=original;self.expected[0]['afterHash']='a'*32
 def test_absent_intent_keeps_existing_behavior(self):
  (self.root/'private'/m.INTENT).unlink();metadata={}
  m.apply_confirmed_chain(self.root,self.expected,metadata,'d'*64);self.assertEqual(metadata,{})

if __name__=='__main__':unittest.main()
