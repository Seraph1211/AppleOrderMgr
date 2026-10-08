"""用户确认的四笔官网原文日期补录链；保留原HTTP审计与通用日期规则。"""
from historicalDateChain import named, require, valid_hash

CASES = ((1093, '2026-09-27', 1417), (1094, '2026-09-27', 1419),
         (1099, '2026-09-28', 1421), (1183, '2026-09-29', 1476))
INTENT = 'confirmed-pickup-dates-intent.json'


def apply_confirmed_chain(root, expected, metadata, plan_hash):
    """仅派生已提交的四单整行hash；原HTTP证据、授权和前后快照必须一致。"""
    if not (root / 'private' / INTENT).exists():
        return
    intent, _ = named(root, INTENT)
    require(intent.get('version') == 1 and intent.get('state') == 'APPLIED' and
            intent.get('planSha256') == plan_hash and valid_hash(intent.get('attemptId'), 32))
    values = {}
    for kind in ('payload', 'preview', 'result'):
        require(intent.get(kind + 'File') == 'confirmed-pickup-dates-' + intent['attemptId'] + '-' + kind + '.json')
        values[kind], digest = named(root, intent[kind + 'File'])
        require(digest == intent.get(kind + 'Sha256'))
    payload, preview, result = (values[k] for k in ('payload', 'preview', 'result'))
    require(payload.get('version') == 1 and payload.get('planSha256') == plan_hash and
            payload.get('authorization') == '这4单按照原样保存即可' and
            [e.get('orderId') for e in payload.get('entries', [])] == [case[0] for case in CASES])
    require(preview.get('mode') == 'dry-run' and type(preview.get('businessWrites')) is int and
            preview['businessWrites'] == 0 and result.get('mode') == 'apply' and
            type(result.get('businessWrites')) is int and result['businessWrites'] == 4 and
            result.get('payloadSha256') == preview.get('payloadSha256') and
            valid_hash(result.get('payloadSha256')) and
            len(preview.get('rows', [])) == len(result.get('rows', [])) == 4)
    for index, (order_id, date, run_id) in enumerate(CASES):
        entry = payload['entries'][index]
        item = next((e for e in expected if e['id'] == order_id), None)
        require(item and item.get('evidenceValid') is True and item.get('http') is True and
                not item.get('receipt') and entry.get('priorHttpAfterHash') == item['afterHash'] and
                entry.get('orderNumber') == item['orderNumber'] and entry.get('proposedDate') == date and
                entry.get('runId') == run_id)
        http, digest = named(root, 'http-apply-intent-%s.json' % order_id)
        require(http.get('state') == 'APPLIED' and http.get('runId') == run_id and
                digest == entry.get('httpIntentSha256'))
        original, _ = named(root, http['payloadFile'])
        require(entry.get('sourceResult') == original.get('result'))
        before, after = preview['rows'][index], result['rows'][index]
        for row in (before, after):
            require(row.get('orderId') == order_id and row.get('beforeHash') == item['afterHash'] and
                    row.get('proposedDate') == date and row.get('devicesHash') == item['devicesHash'])
        require(before['beforeSnapshot'].get('actual_pickup_date') is None and
                before['afterSnapshot'] == before['beforeSnapshot'] and before['afterHash'] == before['beforeHash'] and
                after['beforeSnapshot'] == before['beforeSnapshot'] and after['devices'] == before['devices'] and
                after['afterSnapshot'] == dict(before['beforeSnapshot'], actual_pickup_date=date) and
                valid_hash(after['afterHash'], 32) and after['afterHash'] != after['beforeHash'])
        item['confirmedDate'] = {'payload': payload, 'payloadSha256': result['payloadSha256'], 'row': after}
        item['afterHash'] = after['afterHash']
        metadata.setdefault(order_id, {})['dateFilledThisTask'] = True


CONFIRMED_QUERY_JS = r'''
for(const e of expected){
 if(!e.confirmedDate)continue;
 const h=e.confirmedDate,r=h.row;
 h.hashesVerified=false;
 const {rows}=await client.query(`SELECT
   md5(jsonb_set(to_jsonb(o),'{actual_pickup_date}','null'::jsonb)::text) AS before,
   md5(to_jsonb(o)::text) AS after,
   jsonb_set(to_jsonb(o),'{actual_pickup_date}','null'::jsonb)=$1::jsonb AS before_equal,
   to_jsonb(o)=$2::jsonb AS after_equal
   FROM orders o WHERE id=$3 AND order_number=$4 AND actual_pickup_date=$5::date`,
   [JSON.stringify(r.beforeSnapshot),JSON.stringify(r.afterSnapshot),e.id,e.orderNumber,r.proposedDate]);
 if(rows.length!==1||rows[0].before!==r.beforeHash||rows[0].after!==r.afterHash||
    rows[0].before_equal!==true||rows[0].after_equal!==true)
   throw Error('CONFIRMED_DATE_HASH_INVALID');
 h.hashesVerified=true;
}
'''
CONFIRMED_CHECK_JS = r'''
const baseConfirmedCheck=checkRow;
checkRow=function(e,row,plan){
 const result=baseConfirmedCheck(e,row,plan);
 if(!e.confirmedDate)return result;
 const h=e.confirmedDate,r=h.row;
 const confirmedDateVerified=h.hashesVerified===true&&hash(h.payload)===h.payloadSha256&&
   hash(r.devices)===r.devicesHash&&equal(r.afterSnapshot,{...r.beforeSnapshot,actual_pickup_date:r.proposedDate});
 return {...result,confirmedDateVerified,ok:result.ok&&confirmedDateVerified};
};
'''
