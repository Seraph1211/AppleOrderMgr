"""旧 HTTP 暂缓的明确冻结与一次重开；只追加授权，不清除 Gate 或历史。"""
import contextlib
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import time
import uuid

JOURNALS = ('http-batch-apply.jsonl', 'http-batch-dry-run.jsonl')
REASONS = ('ACCOUNT_COOLDOWN', 'ORDER_ATTEMPT_LIMIT')
MAX_BYTES = 8388608
BASE_KEYS = set(('attemptId businessWrites cleanup egressAfterHash egressHash egressVerifiedAfter '
                 'elapsedSeconds finishedAt outcome proxyIndex startedAt targetOrderId').split())
LEGACY_KEYS = BASE_KEYS | {'containerName', 'requests'}
PREFLIGHT_KEYS = BASE_KEYS | {'requests', 'preflightOnly', 'preflight'}
PRE_KEYS = set('version outcome orderId checkedAt planSha256 inputSha256 accountPaused attempts'.split())
SOURCE_KEYS = set(('journal batchAttemptId sampleAttemptId auditFile auditSha256 finishedAt '
                   'finishedLineSha256 sampleOutcome preflightVersion sampleAudits').split())
EVENT_KEYS = set(('event version policyVersion authorizationId mode at orderId batchAttemptId '
                  'planSha256 manifestFile manifestSha256 sources businessWrites targetCompleted').split())


def require(value):
    if not value:
        raise RuntimeError('BATCH_DEFERRED_RETRY_DENIED')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def integer(value, minimum=1):
    return type(value) is int and value >= minimum


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def token(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value) is not None


def timestamp(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 < value <= time.time()


def same(left, right):
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def strict_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result)
            result[key] = value
        return result
    def constant(_value):
        raise RuntimeError('BATCH_DEFERRED_RETRY_DENIED')
    def number(value):
        result = float(value)
        require(math.isfinite(result))
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant, parse_float=number)


def read(path):
    require(path.resolve() == path)
    with os.fdopen(os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_size <= MAX_BYTES)
        raw = handle.read(MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES)
        return raw


def journals(root):
    result = {}
    for name in JOURNALS:
        path = root / 'private' / name
        raw = read(path) if os.path.lexists(str(path)) else b''
        require(not raw or raw.endswith(b'\n'))
        result[name] = (raw, [(strict_json(line), line) for line in raw.splitlines(keepends=True)])
    return result


def audit_ref(root, sample):
    require(isinstance(sample, dict) and integer(sample.get('targetOrderId')) and token(sample.get('attemptId')))
    name = 'http-sample-' + str(sample['targetOrderId']) + '-' + sample['attemptId'] + '.json'
    raw = read(root / 'private' / name)
    require(same(strict_json(raw), sample))
    return {'sampleAttemptId': sample['attemptId'], 'auditFile': name, 'auditSha256': sha(raw)}


def audit_common(sample, order_id):
    require(integer(sample.get('targetOrderId')) and sample['targetOrderId'] == order_id)
    require(integer(sample.get('businessWrites'), 0) and sample['businessWrites'] == 0)
    require(token(sample.get('attemptId')) and integer(sample.get('proxyIndex'), 0))
    require(timestamp(sample.get('startedAt')) and timestamp(sample.get('finishedAt')))
    require(sample['startedAt'] <= sample['finishedAt'])
    require(type(sample.get('elapsedSeconds')) in (int, float) and
            sample['elapsedSeconds'] == round(sample['finishedAt'] - sample['startedAt'], 3))


def old_final(sample, order_id, plan_sha):
    audit_common(sample, order_id)
    require(sample['outcome'] in REASONS and integer(sample.get('requests'), 0) and sample['requests'] == 0)
    if 'preflight' in sample or 'preflightOnly' in sample:
        require(set(sample) == PREFLIGHT_KEYS and sample['preflightOnly'] is True)
        pre = sample['preflight']
        require(isinstance(pre, dict) and set(pre) == PRE_KEYS)
        require(type(pre['version']) is int and pre['version'] == 1)
        require(integer(pre['orderId']) and pre['orderId'] == order_id and pre['planSha256'] == plan_sha)
        require(digest(pre['inputSha256']) and type(pre['accountPaused']) is bool and integer(pre['attempts'], 0))
        require(timestamp(pre['checkedAt']) and sample['startedAt'] <= pre['checkedAt'] <= sample['finishedAt'])
        expected = 'ACCOUNT_COOLDOWN' if pre['accountPaused'] else 'ORDER_ATTEMPT_LIMIT' if pre['attempts'] >= 3 else None
        require(sample['outcome'] == pre['outcome'] == expected)
        require(sample['egressHash'] is None and sample['egressAfterHash'] is None and sample['egressVerifiedAfter'] is False)
        require(same(sample['cleanup'], {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'}))
        return 1
    require(set(sample) == LEGACY_KEYS)
    require(digest(sample['egressHash']) and sample['egressAfterHash'] == sample['egressHash'])
    require(sample['egressVerifiedAfter'] is True)
    require(sample['containerName'] == 'apple-official-http-sample-' + sample['attemptId'])
    require(same(sample['cleanup'], {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}))
    return None


def old_prior(root, sample, order_id):
    audit_common(sample, order_id)
    rejected = strict_json(read(root / 'private/http-rejected-egress.json'))
    require(isinstance(rejected, list) and all(digest(value) for value in rejected))
    require(digest(sample.get('egressHash')) and sample['egressHash'] in rejected)
    if sample.get('outcome') == 'HTTP_541':
        require(set(sample) == LEGACY_KEYS | {'runId'})
        require(integer(sample['runId']) and integer(sample['requests']) and sample['requests'] <= 40)
        require(sample['egressAfterHash'] == sample['egressHash'] and sample['egressVerifiedAfter'] is True)
        require(sample['containerName'] == 'apple-official-http-sample-' + sample['attemptId'])
        require(same(sample['cleanup'], {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}))
    else:
        require(sample.get('outcome') == 'EGRESS_PREVIOUSLY_REJECTED')
        require(set(sample) == BASE_KEYS | {'failedStage', 'errorType'})
        require(sample['failedStage'] == 'probe-before' and sample['errorType'] == 'RuntimeError')
        require(sample['egressAfterHash'] is None and sample['egressVerifiedAfter'] is False)
        require(same(sample['cleanup'], {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'}))


def sources_for(root, snapshots, order_id, plan_sha, cutoff):
    """只从完整旧终态派生引用；前置失败的全部原审计也封存。"""
    sources = []
    for name in JOURNALS:
        rows = [(row, raw) for row, raw in snapshots[name][1] if row.get('orderId') == order_id]
        if not rows:
            continue
        final, final_raw = rows[-1]
        require(final.get('event') == 'order_finished' and final.get('sampleOutcome') in REASONS and final.get('apply') is None)
        batch_id = final.get('batchAttemptId')
        require(token(batch_id) and timestamp(final.get('at')) and final['at'] <= cutoff)
        selected = [row for row, _raw in rows if row.get('batchAttemptId') == batch_id]
        require(len(selected) >= 3 and selected[0].get('event') == 'order_started')
        require([row.get('event') for row in selected[1:-1]] == ['sample_finished'] * (len(selected) - 2))
        require(all(row.get('orderId') == order_id and row.get('planSha256') == plan_sha and
                    'retryAuthorizationId' not in row and timestamp(row.get('at')) for row in selected))
        require(all(selected[i]['at'] <= selected[i + 1]['at'] for i in range(len(selected) - 1)))
        samples = [row.get('sample') for row in selected[1:-1]]
        require(1 <= len(samples) <= 10)
        refs = []
        prior_finished = selected[0]['at']
        for index, sample in enumerate(samples):
            audit_common(sample, order_id)
            require(prior_finished <= sample['startedAt'] <= sample['finishedAt'] <= selected[index + 1]['at'])
            prior_finished = selected[index + 1]['at']
            refs.append(audit_ref(root, sample))
            if index < len(samples) - 1:
                old_prior(root, sample, order_id)
        require(len({ref['sampleAttemptId'] for ref in refs}) == len(refs))
        runs = [sample['runId'] for sample in samples if 'runId' in sample]
        require(len(runs) == len(set(runs)) and len(runs) <= 3)
        final_sample = samples[-1]
        version = old_final(final_sample, order_id, plan_sha)
        require(final['sampleOutcome'] == final_sample['outcome'] and final.get('receiptOutcome') is None)
        sources.append(dict(refs[-1], journal=name, batchAttemptId=batch_id, finishedAt=final['at'],
                            finishedLineSha256=sha(final_raw), sampleOutcome=final_sample['outcome'],
                            preflightVersion=version, sampleAudits=refs))
    require(sources)
    return sources


def manifest(root, name, expected_sha, snapshots, plan_sha):
    require(isinstance(name, str) and re.fullmatch(r'http-deferred-v1-[a-z0-9-]+\.json', name))
    require(digest(expected_sha))
    raw = read(root / 'private' / name)
    require(sha(raw) == expected_sha)
    value = strict_json(raw)
    require(set(value) == set('version kind planSha256 createdAt legacyCutoff journals entries'.split()))
    require(type(value['version']) is int and value['version'] == 1 and value['kind'] == 'HTTP_DEFERRED_V1_SCOPE')
    require(value['planSha256'] == plan_sha and timestamp(value['createdAt']) and timestamp(value['legacyCutoff']))
    require(value['legacyCutoff'] <= value['createdAt'])
    require(isinstance(value['journals'], dict) and set(value['journals']) == set(JOURNALS))
    originals = {}
    for journal in JOURNALS:
        ref = value['journals'][journal]
        require(isinstance(ref, dict) and set(ref) == {'bytes', 'sha256'} and integer(ref['bytes'], 0) and digest(ref['sha256']))
        prefix = snapshots[journal][0][:ref['bytes']]
        require(len(prefix) == ref['bytes'] and sha(prefix) == ref['sha256'] and (not prefix or prefix.endswith(b'\n')))
        originals[journal] = (prefix, [(strict_json(line), line) for line in prefix.splitlines(keepends=True)])
    require(isinstance(value['entries'], list) and 0 < len(value['entries']) <= 10000)
    entries = {}
    for entry in value['entries']:
        require(isinstance(entry, dict) and set(entry) == {'orderId', 'sources'} and integer(entry['orderId']))
        require(entry['orderId'] not in entries and isinstance(entry['sources'], list) and 1 <= len(entry['sources']) <= 2)
        require(all(isinstance(source, dict) and set(source) == SOURCE_KEYS for source in entry['sources']))
        entries[entry['orderId']] = entry
    return value, entries, originals


def authorization_state(root, plan_sha):
    """两种模式共同验证唯一授权及一次消费；不把授权视为官网或业务成功。"""
    root = pathlib.Path(root).resolve(strict=True)
    snapshots = journals(root)
    events = [(name, index, row) for name in JOURNALS for index, (row, _raw) in enumerate(snapshots[name][1])
              if row.get('event') == 'deferred_retry_authorized']
    if not events:
        require(not any('retryAuthorizationId' in row for _raw, rows in snapshots.values() for row, _line in rows))
        return {}
    result = {}
    seen = set()
    loaded = {}
    for name, position, event in events:
        require(set(event) == EVENT_KEYS and type(event['version']) is int and event['version'] == 1)
        require(type(event['policyVersion']) is int and event['policyVersion'] == 2)
        order_id = event['orderId']
        require(integer(order_id) and order_id not in result and token(event['authorizationId']) and event['authorizationId'] not in seen)
        require(event['planSha256'] == plan_sha and event['mode'] == ('apply' if name == JOURNALS[0] else 'dry-run'))
        require(timestamp(event['at']) and integer(event['businessWrites'], 0) and event['businessWrites'] == 0)
        require(event['targetCompleted'] is False)
        key = (event['manifestFile'], event['manifestSha256'])
        if key not in loaded:
            loaded[key] = manifest(root, key[0], key[1], snapshots, plan_sha)
        frozen, entries, originals = loaded[key]
        require(frozen['createdAt'] <= event['at'] and order_id in entries)
        require(position >= len(originals[name][1]))
        sources = sources_for(root, originals, order_id, plan_sha, frozen['legacyCutoff'])
        require(same(sources, entries[order_id]['sources']) and same(sources, event['sources']))
        own_sources = [source for source in sources if source['journal'] == name]
        require(len(own_sources) == 1 and event['batchAttemptId'] == own_sources[0]['batchAttemptId'])
        starts = []
        for other in JOURNALS:
            for index, (row, _raw) in enumerate(snapshots[other][1]):
                if row.get('orderId') != order_id:
                    continue
                require(timestamp(row.get('at')))
                if index >= len(originals[other][1]):
                    require(row['at'] >= event['at'])
                if index >= len(originals[other][1]) and (other != name or index < position):
                    require(row['at'] > event['at'])
                if row.get('event') == 'order_started' and row['at'] >= event['at']:
                    require(other == name and index > position and row.get('retryAuthorizationId') == event['authorizationId'])
                    require(token(row.get('batchAttemptId')) and row['batchAttemptId'] not in [source['batchAttemptId'] for source in sources])
                    starts.append(row)
                elif 'retryAuthorizationId' in row:
                    require(row['at'] >= event['at'] and row['retryAuthorizationId'] == event['authorizationId'] and other == name)
        require(len(starts) <= 1)
        for other in JOURNALS:
            for row, _raw in snapshots[other][1]:
                if 'retryAuthorizationId' in row and row.get('orderId') == order_id:
                    require(starts and row.get('batchAttemptId') == starts[0]['batchAttemptId'])
        result[order_id] = {'event': event, 'journal': name, 'consumed': bool(starts)}
        seen.add(event['authorizationId'])
    for _raw, rows in snapshots.values():
        for row, _line in rows:
            if 'retryAuthorizationId' in row:
                require(row.get('orderId') in result)
    return result


@contextlib.contextmanager
def locks(root):
    root = pathlib.Path(root)
    require(root.is_absolute() and not (root / 'private').is_symlink())
    root = root.resolve(strict=True)
    require((root / 'private').is_dir())
    with contextlib.ExitStack() as stack:
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            handle = stack.enter_context(os.fdopen(os.open(str(root / 'private' / name), os.O_RDONLY | os.O_NOFOLLOW), 'rb'))
            require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('BATCH_DEFERRED_RETRY_BUSY') from None
        yield root


def guard(root, api):
    raw = read(root / 'private/plan.json')
    plan = strict_json(raw)
    scope = set(api['validatePlan'](plan))
    plan_sha = sha(raw)
    api['check'](root, plan_sha)
    quarantined = set()
    for name in JOURNALS:
        api['journal'](root / 'private' / name, plan_sha, scope, quarantined=quarantined)
    confirmed = api['confirmed'](root, plan, plan_sha)
    return plan_sha, scope, quarantined, confirmed


def unchanged(root, before):
    after = journals(root)
    require(all(after[name][0] == before[name][0] for name in JOURNALS))


def freeze_deferred(root, ids, name, cutoff, api):
    """显式旧目标清单派生私密冻结文件；不追加日志或发采集请求。"""
    with locks(root) as root:
        plan_sha, scope, quarantined, confirmed = guard(root, api)
        require(isinstance(ids, list) and ids and all(integer(value) for value in ids) and len(ids) == len(set(ids)))
        require(set(ids) <= scope and not set(ids).intersection(quarantined | confirmed))
        require(timestamp(cutoff) and re.fullmatch(r'http-deferred-v1-[a-z0-9-]+\.json', name or ''))
        before = journals(root)
        require(not authorization_state(root, plan_sha))
        entries = [{'orderId': order_id, 'sources': sources_for(root, before, order_id, plan_sha, cutoff)} for order_id in ids]
        value = {'version': 1, 'kind': 'HTTP_DEFERRED_V1_SCOPE', 'planSha256': plan_sha,
                 'createdAt': time.time(), 'legacyCutoff': cutoff,
                 'journals': {journal: {'bytes': len(before[journal][0]), 'sha256': sha(before[journal][0])} for journal in JOURNALS},
                 'entries': entries}
        require(guard(root, api)[0] == plan_sha)
        unchanged(root, before)
        require(same(entries, [{'orderId': order_id, 'sources': sources_for(root, before, order_id, plan_sha, cutoff)}
                               for order_id in ids]))
        raw = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode('utf-8')
        require(len(raw) <= MAX_BYTES)
        path = root / 'private' / name
        with os.fdopen(os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fchown(handle.fileno(), 1000, 1000)
            os.fsync(handle.fileno())
        api['sync'](path.parent)
        require(read(path) == raw)
        return {'outcome': 'BATCH_DEFERRED_SCOPE_FROZEN', 'manifestFile': name, 'manifestSha256': sha(raw),
                'orderIds': ids, 'businessWrites': 0, 'journalWrites': 0}


def no_target_artifacts(root, order_id):
    order = str(order_id)
    for pattern in ('results/order-' + order + '-run-*.json', 'http-receipt-' + order + '-run-*.json',
                    'receipt-probe-' + order + '.json', 'http-apply-' + order + '-*.json',
                    'http-apply-basis-' + order + '-*.json', 'browser-receipt-bind-' + order + '-*.json',
                    'http-apply-intent-' + order + '.json', 'browser-receipt-bind-intent-' + order + '.json'):
        require(not list((root / 'private').glob(pattern)))


def reopen_deferred(root, ids, journal, name, expected_sha, api):
    """先验证全批再逐项追加一次授权；相同未消费授权幂等，部分写入不覆盖。"""
    with locks(root) as root:
        plan_sha, scope, quarantined, confirmed = guard(root, api)
        require(journal in JOURNALS and isinstance(ids, list) and ids and all(integer(value) for value in ids))
        require(len(ids) == len(set(ids)) and set(ids) <= scope and not set(ids).intersection(quarantined | confirmed))
        before = journals(root)
        frozen, entries, originals = manifest(root, name, expected_sha, before, plan_sha)
        authorizations = authorization_state(root, plan_sha)
        pending = []
        previous = []
        for order_id in ids:
            require(order_id in entries)
            no_target_artifacts(root, order_id)
            sources = sources_for(root, originals, order_id, plan_sha, frozen['legacyCutoff'])
            require(same(sources, entries[order_id]['sources']))
            own = [source for source in sources if source['journal'] == journal]
            require(len(own) == 1)
            existing = authorizations.get(order_id)
            if existing:
                require(not existing['consumed'] and existing['journal'] == journal)
                require(existing['event']['manifestFile'] == name and existing['event']['manifestSha256'] == expected_sha)
                previous.append(order_id)
                continue
            # 在冻结之后若该目标又发生任何事件，不可引用旧终态开启新授权。
            for other in JOURNALS:
                tail = before[other][0][len(originals[other][0]):]
                require(not any(strict_json(line).get('orderId') == order_id for line in tail.splitlines()))
            pending.append({'event': 'deferred_retry_authorized', 'version': 1, 'policyVersion': 2,
                            'authorizationId': uuid.uuid4().hex, 'mode': 'apply' if journal == JOURNALS[0] else 'dry-run',
                            'at': time.time(), 'orderId': order_id, 'batchAttemptId': own[0]['batchAttemptId'],
                            'planSha256': plan_sha, 'manifestFile': name, 'manifestSha256': expected_sha,
                            'sources': sources, 'businessWrites': 0, 'targetCompleted': False})
        require(guard(root, api)[0] == plan_sha)
        unchanged(root, before)
        # 任意前置校验失败时零追加；写入不确定则保留原文件，调用方不得自动消费。
        appended = []
        for event in pending:
            api['check'](root, plan_sha)
            no_target_artifacts(root, event['orderId'])
            require(sha(read(root / 'private' / name)) == expected_sha)
            unchanged(root, before)
            require(same(sources_for(root, originals, event['orderId'], plan_sha, frozen['legacyCutoff']), event['sources']))
            event['at'] = time.time()
            api['append'](root / 'private' / journal, event)
            appended.append(event['orderId'])
            before = journals(root)
        authorization_state(root, plan_sha)
        return {'outcome': 'BATCH_DEFERRED_RETRY_AUTHORIZED', 'authorizedOrderIds': appended,
                'alreadyAuthorizedOrderIds': previous, 'journal': journal,
                'businessWrites': 0, 'targetCompleted': False, 'allFieldsComplete': False}
