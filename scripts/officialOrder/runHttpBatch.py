"""冻结缺失范围的一次有界顺序处理；未知结果停止，确认结束也不表示字段完整。"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import subprocess
import time
import uuid

from runHttpSample import writePrivate
from writeBoundary import checkWriteBoundary
from httpFailureQuarantine import equal_json, runtime_boundary, verify_failure
from httpDeferredRetry import authorization_state, freeze_deferred, reopen_deferred, old_prior, audit_ref, no_target_artifacts

MAX_BYTES = 8388608
MAX_CHILD_BYTES = 65536
MAX_PLAN_AGE = 86400
MAX_PROBES = 10
MAX_ATTEMPTS = 3
POLICY = {'loginCooldown': True, 'apiHealthCheck': True, 'proxy541Limit': 3}
DEFERRED = frozenset(('ACCOUNT_COOLDOWN', 'LOGIN_COOLDOWN', 'ORDER_ATTEMPT_LIMIT',
                      'ACCOUNT_BUSY', 'AUTHENTICATION_REQUIRED', 'NO_GUEST_ACTION',
                      'NO_VALID_ORDER_DATA', 'HTTP_404', 'HTTP_410'))
ROTATE = frozenset(('HTTP_541', 'EGRESS_PREVIOUSLY_REJECTED', 'PROXY_COOLDOWN'))
JOURNALS = ('http-batch-apply.jsonl', 'http-batch-dry-run.jsonl')
PROBE_FAILURE_KEYS = frozenset(('outcome', 'failedStage', 'errorType', 'attemptId', 'targetOrderId',
                               'proxyIndex', 'startedAt', 'finishedAt', 'elapsedSeconds', 'egressHash',
                               'egressAfterHash', 'egressVerifiedAfter', 'businessWrites', 'cleanup'))
KNOWN_541_KEYS = frozenset(('outcome', 'runId', 'requests', 'attemptId', 'targetOrderId', 'proxyIndex',
                           'startedAt', 'finishedAt', 'elapsedSeconds', 'egressHash', 'egressAfterHash',
                           'egressVerifiedAfter', 'businessWrites', 'cleanup', 'containerName'))


def valid_int(value, minimum=1):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def read_private(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_BYTES):
        raise RuntimeError('BATCH_PRIVATE_FILE_INVALID')
    return path.read_bytes()


def child(command, timeout, pass_fds=()):
    """子进程输出只允许一个有界 JSON；超时和协议异常保持开始日志未决。"""
    try:
        output = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, pass_fds=pass_fds)
    except subprocess.TimeoutExpired:
        raise RuntimeError('BATCH_CHILD_TIMEOUT')
    try:
        if len(output.stdout) > MAX_CHILD_BYTES:
            raise ValueError()
        result = json.loads(output.stdout.decode('utf-8'))
    except (ValueError, UnicodeError):
        raise RuntimeError('BATCH_CHILD_OUTPUT_INVALID')
    if (not isinstance(result, dict) or not isinstance(result.get('outcome'), str) or
            not re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', result['outcome'])):
        raise RuntimeError('BATCH_CHILD_OUTPUT_INVALID')
    if output.returncode and result['outcome'] in ('SUCCEEDED', 'DRY_RUN'):
        raise RuntimeError('BATCH_CHILD_EXIT_INVALID')
    return result


def sync_directory(directory):
    descriptor = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def append(path, value):
    """开始记录持久化后才允许启动子进程；日志权限不依赖 umask。"""
    descriptor = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a', encoding='utf-8') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(json.dumps(value, allow_nan=False) + '\n')
        output.flush()
        os.fsync(output.fileno())
    sync_directory(path.parent)


def validate_plan(plan):
    try:
        timestamp = plan['startedAt']
        if not isinstance(timestamp, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', timestamp):
            raise ValueError()
        started = datetime.datetime.strptime(timestamp, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=datetime.timezone.utc)
        entries = plan['entries']
        if (type(plan.get('schemaVersion')) is not int or plan['schemaVersion'] != 3 or
                plan.get('scope') != 'missing-fields' or 'cutoff' not in plan or plan['cutoff'] is not None or
                plan.get('policy') != POLICY or
                type(plan['policy'].get('loginCooldown')) is not bool or
                type(plan['policy'].get('apiHealthCheck')) is not bool or
                type(plan['policy'].get('proxy541Limit')) is not int or
                not 0 <= time.time() - started.timestamp() <= MAX_PLAN_AGE or
                not isinstance(entries, list) or not 0 < len(entries) <= 10000):
            raise ValueError()
        ids = []
        for entry in entries:
            if (not isinstance(entry, dict) or not valid_int(entry.get('id')) or
                    not re.fullmatch(r'W\d{10}', entry.get('orderNumber', '')) or
                    not re.fullmatch(r'[a-f0-9]{32}', entry.get('rowHash', '')) or
                    type(entry.get('dateMissing')) is not bool or type(entry.get('serialsMissing')) is not bool or
                    not (entry['dateMissing'] or entry['serialsMissing']) or
                    'previousDate' not in entry or not isinstance(entry.get('previousDevices'), list) or
                    entry['dateMissing'] != (entry['previousDate'] is None) or
                    entry['serialsMissing'] != (len(entry['previousDevices']) == 0)):
                raise ValueError()
            ids.append(entry['id'])
        if len(ids) != len(set(ids)):
            raise ValueError()
        return ids
    except (KeyError, ValueError, TypeError, AttributeError, OverflowError):
        raise RuntimeError('BACKFILL_SCOPE_INVALID')


def strict_json(value):
    """审计不能利用重复键或非有限数字产生不同解释。"""
    def pairs(items):
        output = {}
        for key, item in items:
            if key in output:
                raise ValueError()
            output[key] = item
        return output

    def constant(_value):
        raise ValueError()

    return json.loads(value, object_pairs_hook=pairs, parse_constant=constant)


def valid_time(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def probe_failure_evidence(root, sample, order_id, started_at, sample_at, reconciled_at):
    """只证明未创建采集容器的首次出口探测失败；不接受任何官网或回写运行。"""
    try:
        if (not isinstance(sample, dict) or set(sample) != PROBE_FAILURE_KEYS or
                sample.get('outcome') != 'RUNTIME_COMMAND_FAILED' or sample.get('failedStage') != 'probe-before' or
                sample.get('errorType') != 'RuntimeError' or type(sample.get('businessWrites')) is not int or
                sample['businessWrites'] != 0 or not valid_int(sample.get('targetOrderId')) or
                sample['targetOrderId'] != order_id or not valid_int(sample.get('proxyIndex'), 0) or
                not isinstance(sample.get('attemptId'), str) or not re.fullmatch(r'[a-f0-9]{32}', sample['attemptId']) or
                sample.get('egressHash') is not None or sample.get('egressAfterHash') is not None or
                sample.get('egressVerifiedAfter') is not False or
                not isinstance(sample.get('cleanup'), dict) or
                json.dumps(sample['cleanup'], sort_keys=True) != json.dumps(
                    {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'}, sort_keys=True) or
                any(not valid_time(value) for value in
                    (started_at, sample.get('startedAt'), sample.get('finishedAt'), sample_at, reconciled_at)) or
                not started_at <= sample['startedAt'] <= sample['finishedAt'] <= sample_at <= reconciled_at <= time.time() or
                type(sample.get('elapsedSeconds')) not in (int, float) or
                not math.isfinite(sample['elapsedSeconds']) or
                sample['elapsedSeconds'] != round(sample['finishedAt'] - sample['startedAt'], 3)):
            raise ValueError()
        name = 'http-sample-' + str(order_id) + '-' + sample['attemptId'] + '.json'
        raw = read_private(root / 'private' / name)
        if json.dumps(strict_json(raw), sort_keys=True, allow_nan=False) != json.dumps(sample, sort_keys=True, allow_nan=False):
            raise ValueError()
        return name, hashlib.sha256(raw).hexdigest()
    except (KeyError, ValueError, TypeError, UnicodeError, OSError):
        raise RuntimeError('BATCH_PROBE_RECONCILIATION_DENIED')


def preceding_failure_evidence(root, history, order_id, started_at, at, replay_closed=False):
    """封存最多两次已确认普通 541；末次出口未知失败仍需独立密文及双库核验。"""
    try:
        if (not isinstance(history, list) or not 1 <= len(history) <= MAX_ATTEMPTS or
                not valid_time(started_at) or not valid_time(at)):
            raise ValueError()
        seen_runs = set()
        seen_attempts = set()
        previous_at = started_at
        evidence = []
        for index, record in enumerate(history):
            if not isinstance(record, dict) or set(record) != {'sample', 'at'}:
                raise ValueError()
            sample = record['sample']
            if (not isinstance(sample, dict) or not valid_int(sample.get('runId')) or
                    not valid_int(sample.get('targetOrderId')) or sample['targetOrderId'] != order_id or
                    not isinstance(sample.get('attemptId'), str) or
                    not re.fullmatch(r'[a-f0-9]{32}', sample['attemptId']) or
                    sample['runId'] in seen_runs or sample['attemptId'] in seen_attempts or
                    any(not valid_time(value) for value in
                        (sample.get('startedAt'), sample.get('finishedAt'), record['at'])) or
                    not previous_at <= sample['startedAt'] <= sample['finishedAt'] <= record['at'] <= at):
                raise ValueError()
            seen_runs.add(sample['runId'])
            seen_attempts.add(sample['attemptId'])
            previous_at = record['at']
            if index == len(history) - 1:
                continue
            if (set(sample) != KNOWN_541_KEYS or sample['outcome'] != 'HTTP_541' or
                    not valid_int(sample['requests']) or sample['requests'] > 40 or
                    not valid_int(sample['proxyIndex'], 0) or
                    type(sample['businessWrites']) is not int or sample['businessWrites'] != 0 or
                    not valid_hash(sample['egressHash']) or sample['egressAfterHash'] != sample['egressHash'] or
                    sample['egressVerifiedAfter'] is not True or
                    not equal_json(sample['cleanup'], {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}) or
                    sample['containerName'] != 'apple-official-http-sample-' + sample['attemptId'] or
                    type(sample['elapsedSeconds']) not in (int, float) or
                    sample['elapsedSeconds'] != round(sample['finishedAt'] - sample['startedAt'], 3)):
                raise ValueError()
            name = 'http-sample-' + str(order_id) + '-' + sample['attemptId'] + '.json'
            raw = read_private(root / 'private' / name)
            if not equal_json(strict_json(raw), sample):
                raise ValueError()
            runtime_boundary(root, sample, replay_closed=replay_closed)
            evidence.append({'auditFile': name, 'auditSha256': hashlib.sha256(raw).hexdigest(),
                             'runId': sample['runId'], 'sampleAttemptId': sample['attemptId']})
        return evidence
    except Exception:
        raise RuntimeError('BATCH_FAILURE_QUARANTINE_DENIED') from None


def probe_preceding_evidence(root, history, order_id, started_at, at):
    """探测前失败可承接一至两次明确 541；回放不否认后来的合法成功。"""
    try:
        root = pathlib.Path(root).resolve(strict=True)
        if not isinstance(history, list) or not 1 <= len(history) <= MAX_ATTEMPTS:
            raise ValueError()
        previous = started_at
        attempts = set()
        runs = set()
        refs = []
        for index, record in enumerate(history):
            if not isinstance(record, dict) or set(record) != {'sample', 'at'}:
                raise ValueError()
            sample = record['sample']
            if (not isinstance(sample, dict) or sample.get('attemptId') in attempts or
                    any(not valid_time(v) for v in (previous, sample.get('startedAt'), sample.get('finishedAt'), record['at'], at)) or
                    not previous <= sample['startedAt'] <= sample['finishedAt'] <= record['at'] <= at):
                raise ValueError()
            attempts.add(sample['attemptId'])
            previous = record['at']
            if index == len(history) - 1:
                probe_failure_evidence(root, sample, order_id, started_at, record['at'], at)
                continue
            if sample.get('outcome') != 'HTTP_541' or sample.get('runId') in runs:
                raise ValueError()
            old_prior(root, sample, order_id)
            runs.add(sample['runId'])
            refs.append(dict(audit_ref(root, sample), runId=sample['runId']))
        return refs
    except Exception:
        raise RuntimeError('BATCH_PROBE_RECONCILIATION_DENIED') from None


def journal_state(path, plan_sha, scope, pending=None, quarantined=None, pending_by_order=None):
    """允许不同订单日志交错；同一订单仍由原严格状态机重放。"""
    if not path.exists():
        return set()
    quarantined = set() if quarantined is None else quarantined
    try:
        try:
            retries = authorization_state(path.parent.parent, plan_sha)
        except Exception:
            raise RuntimeError('BATCH_RECONCILIATION_REQUIRED') from None
        raw = read_private(path)
        if not raw.endswith(b'\n'):
            raise ValueError()
        groups = {}
        starts = set()
        for line in raw.decode('utf-8').splitlines():
            row = strict_json(line)
            order_id = row.get('orderId')
            if not valid_int(order_id):
                raise ValueError()
            if row.get('event') == 'order_started':
                attempt = row.get('batchAttemptId')
                if not isinstance(attempt, str) or attempt in starts:
                    raise ValueError()
                starts.add(attempt)
            groups.setdefault(order_id, []).append(line)
        finished = set()
        unresolved = []
        for lines in groups.values():
            item = {}
            finished.update(journal_order_state(path, lines, plan_sha, scope, retries, item, quarantined))
            if item:
                unresolved.append(item)
        if unresolved and pending_by_order is not None:
            pending_by_order.update({item['orderId']: item for item in unresolved})
        elif unresolved:
            if pending is None or len(unresolved) != 1:
                raise ValueError()
            pending.update(unresolved[0])
        return finished
    except (KeyError, ValueError, TypeError, UnicodeError):
        raise RuntimeError('BATCH_RECONCILIATION_REQUIRED') from None


def journal_order_state(path, lines, plan_sha, scope, retries, pending, quarantined):
    """只重放一个订单的原始事件，不修改原日志或授权引用。"""
    try:
        active = None
        active_retry = None
        last_sample = None
        apply_failed = False
        last_apply_failure = None
        sample_count = 0
        sample_history = []
        started_at = sample_at = None
        finished = set()
        seen_attempts = set()
        for line in lines:
            row = strict_json(line)
            attempt = row['batchAttemptId']
            order_id = row['orderId']
            if (row.get('planSha256') != plan_sha or not valid_int(order_id) or order_id not in scope or
                    not isinstance(attempt, str) or not re.fullmatch(r'[a-f0-9]{32}', attempt)):
                raise ValueError()
            key = (order_id, attempt)
            event = row.get('event')
            if event == 'order_started':
                if active or order_id in finished or order_id in quarantined or attempt in seen_attempts:
                    raise ValueError()
                active = key
                active_retry = row.get('retryAuthorizationId')
                last_sample = None
                apply_failed = False
                last_apply_failure = None
                sample_count = 0
                sample_history = []
                started_at = row.get('at')
                sample_at = None
                seen_attempts.add(attempt)
            elif event == 'deferred_retry_authorized':
                retry = retries.get(order_id)
                if (active or order_id not in finished or order_id in quarantined or
                        not retry or retry['journal'] != path.name or not equal_json(retry['event'], row)):
                    raise ValueError()
                finished.remove(order_id)
            elif event in ('sample_finished', 'apply_failed', 'order_finished'):
                if key != active:
                    raise ValueError()
                if event == 'sample_finished':
                    sample_count += 1
                    sample_at = row.get('at')
                    last_sample = row.get('sample')
                    sample_history.append({'sample': last_sample, 'at': sample_at})
                    if not isinstance(last_sample, dict) or last_sample.get('targetOrderId') != order_id:
                        raise ValueError()
                    if 'preflightOnly' in last_sample or 'preflight' in last_sample:
                        validate_preflight_sample(path.parent.parent, last_sample, order_id, plan_sha,
                                                  current=active_retry is not None)
                if event == 'apply_failed':
                    apply_failed = True
                    last_apply_failure = row.get('result')
                if event == 'order_finished':
                    if (last_sample is None or apply_failed or
                            row.get('sampleOutcome') != last_sample.get('outcome') or
                            row.get('receiptOutcome') != last_sample.get('receiptOutcome')):
                        raise ValueError()
                    applied = row.get('apply')
                    if last_sample.get('outcome') == 'SUCCEEDED':
                        applying = path.name == JOURNALS[0]
                        if (not isinstance(applied, dict) or applied.get('orderId') != order_id or
                                applied.get('runId') != last_sample.get('runId') or
                                applied.get('outcome') != ('SUCCEEDED' if applying else 'DRY_RUN') or
                                applied.get('mode') != ('apply' if applying else 'dry-run')):
                            raise ValueError()
                    elif retryable_read_failure(last_sample):
                        if row.get('readFailureVerified') is not True or applied is not None:
                            raise ValueError()
                        audit_ref(path.parent.parent, last_sample)
                    elif last_sample.get('outcome') not in DEFERRED | {'HTTP_541'} or applied is not None:
                        raise ValueError()
                    finished.add(order_id)
                    active = None
            elif event == 'payer_preview_failure_reconciled':
                if key != active or not apply_failed or sample_count != 1:
                    raise ValueError()
                from externalPayerChange import verify_preview_closure
                verify_preview_closure(path.parent.parent, row, last_sample, last_apply_failure)
                # 保留失败历史，不计业务完成；后续必须新采样并通过Gate。
                active = None
            elif event == 'probe_failure_reconciled':
                if key != active or apply_failed or not 1 <= sample_count <= MAX_ATTEMPTS:
                    raise ValueError()
                preceding = probe_preceding_evidence(path.parent.parent, sample_history, order_id, started_at, row.get('at'))
                audit_name, audit_sha = probe_failure_evidence(
                    path.parent.parent, last_sample, order_id, started_at, sample_at, row.get('at'))
                resolution = 'FAILED_541_THEN_CANCELLED_BEFORE_COLLECTOR' if preceding else 'CANCELLED_BEFORE_COLLECTOR'
                if (row.get('resolution') != resolution or not equal_json(row.get('precedingFailures', []), preceding) or
                        row.get('sampleAttemptId') != last_sample['attemptId'] or
                        row.get('auditFile') != audit_name or row.get('auditSha256') != audit_sha or
                        type(row.get('businessWrites')) is not int or row['businessWrites'] != 0):
                    raise ValueError()
                # 仅终止已确认失败的批次尝试，不把目标加入已完成集合。
                active = None
            elif event == 'failed_read_only_quarantined':
                if (key != active or apply_failed or not 1 <= sample_count <= MAX_ATTEMPTS or order_id in quarantined or
                        row.get('resolution') != ('FAILED_WITHOUT_APPLY_VERIFIED_EGRESS' if last_sample.get('egressVerifiedAfter') is True else 'FAILED_WITHOUT_APPLY_UNVERIFIED_EGRESS') or
                        row.get('sampleAttemptId') != last_sample.get('attemptId') or
                        row.get('runId') != last_sample.get('runId') or
                        not isinstance(row.get('verification'), dict) or
                        row.get('targetCompleted') is not False or row.get('egressVerifiedAfter') is not last_sample.get('egressVerifiedAfter') or
                        type(row.get('businessWrites')) is not int or row['businessWrites'] != 0):
                    raise ValueError()
                preceding = preceding_failure_evidence(path.parent.parent, sample_history, order_id,
                                                       started_at, row.get('at'), replay_closed=True)
                # 旧单样本事件没有此前置列表；多样本事件必须封存并重验每条原文摘要。
                if not equal_json(row.get('precedingFailures', []), preceding):
                    raise ValueError()
                verify_failure(path.parent.parent, plan_sha, order_id, attempt, last_sample,
                               started_at, sample_at, row.get('proofFile'), row.get('proofSha256'),
                               row.get('at'), expected=row.get('verification'))
                quarantined.add(order_id)
                active = None
            else:
                raise ValueError()
        if active:
            if pending is None:
                raise RuntimeError('BATCH_RECONCILIATION_REQUIRED')
            pending.update(orderId=active[0], batchAttemptId=active[1], sample=last_sample,
                           sampleCount=sample_count, applyFailed=apply_failed,
                           startedAt=started_at, sampleAt=sample_at, sampleHistory=sample_history)
        return finished
    except (KeyError, ValueError, TypeError, UnicodeError):
        raise RuntimeError('BATCH_RECONCILIATION_REQUIRED')


def validate_preflight_sample(root, sample, order_id, plan_sha, current=False):
    """新调用仅接受 v2；历史 v1/v2 分别按当时阈值重验零采集审计。"""
    try:
        expected_keys = {'outcome', 'requests', 'preflightOnly', 'preflight', 'attemptId', 'targetOrderId',
                         'proxyIndex', 'startedAt', 'finishedAt', 'elapsedSeconds', 'egressHash',
                         'egressAfterHash', 'egressVerifiedAfter', 'businessWrites', 'cleanup'}
        preflight = sample['preflight']
        if (set(sample) != expected_keys or sample['preflightOnly'] is not True or
                sample['outcome'] not in ('ACCOUNT_COOLDOWN', 'ORDER_ATTEMPT_LIMIT') or
                type(sample['requests']) is not int or sample['requests'] != 0 or
                type(sample['businessWrites']) is not int or sample['businessWrites'] != 0 or
                not valid_int(sample['targetOrderId']) or sample['targetOrderId'] != order_id or
                not valid_int(sample['proxyIndex'], 0) or
                not isinstance(sample['attemptId'], str) or not re.fullmatch(r'[a-f0-9]{32}', sample['attemptId']) or
                sample['egressHash'] is not None or sample['egressAfterHash'] is not None or
                sample['egressVerifiedAfter'] is not False or
                json.dumps(sample['cleanup'], sort_keys=True) != json.dumps(
                    {'attempted': False, 'removed': False, 'outcome': 'NOT_NEEDED'}, sort_keys=True) or
                not isinstance(preflight, dict) or set(preflight) != {
                    'version', 'outcome', 'orderId', 'checkedAt', 'planSha256', 'inputSha256', 'accountPaused', 'attempts'} or
                type(preflight['version']) is not int or preflight['version'] not in (1, 2) or
                (current and preflight['version'] != 2) or
                not valid_int(preflight['orderId']) or preflight['orderId'] != order_id or
                type(preflight['accountPaused']) is not bool or not valid_int(preflight['attempts'], 0) or
                preflight['planSha256'] != plan_sha or not valid_hash(preflight['inputSha256']) or
                any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in
                    (sample['startedAt'], preflight['checkedAt'], sample['finishedAt'])) or
                not sample['startedAt'] <= preflight['checkedAt'] <= sample['finishedAt'] or
                type(sample['elapsedSeconds']) not in (int, float) or
                sample['elapsedSeconds'] != round(sample['finishedAt'] - sample['startedAt'], 3)):
            raise ValueError()
        attempt_limit = 3 if preflight['version'] == 1 else 10
        expected = ('ACCOUNT_COOLDOWN' if preflight['accountPaused'] else
                    'ORDER_ATTEMPT_LIMIT' if preflight['attempts'] >= attempt_limit else 'HTTP_PREFLIGHT_ALLOWED')
        if sample['outcome'] != expected or preflight['outcome'] != expected:
            raise ValueError()
        audit = strict_json(read_private(root / ('private/http-sample-' + str(order_id) + '-' + sample['attemptId'] + '.json')))
        if json.dumps(audit, sort_keys=True, allow_nan=False) != json.dumps(sample, sort_keys=True, allow_nan=False):
            raise ValueError()
    except Exception:
        raise RuntimeError('BATCH_SAMPLE_AUDIT_INVALID') from None


def retryable_read_failure(sample):
    """仅已结束、已清理且未进入业务写入的明确只读失败；不提升未验证出口。"""
    from httpFailureQuarantine import SAMPLE_KEYS, CHANGED_EGRESS_SAMPLE_KEYS, COMPLETE_UNVERIFIED_KEYS
    try:
        if (not isinstance(sample, dict) or not valid_int(sample.get('runId')) or
                not valid_int(sample.get('targetOrderId')) or not valid_int(sample.get('proxyIndex'), 0) or
                type(sample.get('businessWrites')) is not int or sample['businessWrites'] != 0 or
                not isinstance(sample.get('attemptId'), str) or not re.fullmatch(r'[a-f0-9]{32}', sample['attemptId']) or
                not valid_hash(sample.get('egressHash')) or
                sample.get('containerName') != 'apple-official-http-sample-' + sample['attemptId'] or
                not equal_json(sample.get('cleanup'), {'attempted': True, 'removed': True, 'outcome': 'REMOVED'}) or
                any(type(sample.get(k)) not in (int, float) or not math.isfinite(sample[k]) or sample[k] <= 0
                    for k in ('startedAt', 'finishedAt')) or not sample['startedAt'] <= sample['finishedAt'] <= time.time() or
                type(sample.get('elapsedSeconds')) not in (int, float) or
                sample['elapsedSeconds'] != round(sample['finishedAt'] - sample['startedAt'], 3)):
            return False
        stable = sample.get('outcome') in ('HTTP_TIMEOUT', 'PROXY_CONNECTION_FAILED', 'REDIRECT_LIMIT')
        if stable:
            return (set(sample) == KNOWN_541_KEYS and sample.get('egressVerifiedAfter') is True and
                    sample.get('egressAfterHash') == sample['egressHash'] and
                    valid_int(sample.get('requests')) and sample['requests'] <= 40)
        if sample.get('outcome') != 'EGRESS_CHANGED_OR_UNVERIFIED' or sample.get('egressVerifiedAfter') is not False:
            return False
        after = sample.get('egressAfterHash')
        unknown = after is None and sample.get('egressAfterError') == 'RUNTIME_COMMAND_FAILED'
        changed = valid_hash(after) and after != sample['egressHash'] and 'egressAfterError' not in sample
        if not (unknown or changed):
            return False
        original = sample.get('originalOutcome')
        if original == 'SUCCEEDED':
            return (set(sample) == (COMPLETE_UNVERIFIED_KEYS if unknown else COMPLETE_UNVERIFIED_KEYS - {'egressAfterError'}) and
                    type(sample.get('orderId')) is int and sample['orderId'] == sample['targetOrderId'] and
                    sample.get('receiptOutcome') == 'RECEIPT_NOT_REQUESTED' and
                    sample.get('resultFile') == '/research/private/results/order-' + str(sample['orderId']) + '-run-' + str(sample['runId']) + '.json')
        return (original in ('HTTP_541', 'HTTP_TIMEOUT', 'PROXY_CONNECTION_FAILED', 'REDIRECT_LIMIT') and
                set(sample) == (SAMPLE_KEYS if unknown else CHANGED_EGRESS_SAMPLE_KEYS) and
                valid_int(sample.get('requests')) and sample['requests'] <= 40)
    except Exception:
        return False


def validate_sample(root, sample, order_id, proxy_index, rejected):
    attempt = sample.get('attemptId')
    if (not isinstance(attempt, str) or not re.fullmatch(r'[a-f0-9]{32}', attempt) or
            sample.get('targetOrderId') != order_id or sample.get('proxyIndex') != proxy_index or
            sample.get('businessWrites') != 0):
        raise RuntimeError('BATCH_SAMPLE_AUDIT_INVALID')
    audit_path = root / ('private/http-sample-' + str(order_id) + '-' + attempt + '.json')
    if json.loads(read_private(audit_path)) != sample:
        raise RuntimeError('BATCH_SAMPLE_AUDIT_INVALID')
    if 'preflightOnly' in sample or 'preflight' in sample:
        validate_preflight_sample(root, sample, order_id,
                                  hashlib.sha256(read_private(root / 'private/plan.json')).hexdigest(), current=True)
        if sample['preflight']['inputSha256'] != hashlib.sha256(
                read_private(root / ('private/request-' + str(order_id) + '.json'))).hexdigest():
            raise RuntimeError('BATCH_SAMPLE_AUDIT_INVALID')
    cleanup = sample.get('cleanup')
    if (not isinstance(cleanup, dict) or
            (cleanup.get('attempted') is not False and cleanup.get('removed') is not True)):
        raise RuntimeError('BATCH_SAMPLE_CLEANUP_REQUIRED')
    if sample['outcome'] in ('SUCCEEDED', 'HTTP_541'):
        if (not valid_int(sample.get('runId')) or
                (sample['outcome'] == 'SUCCEEDED' and sample.get('orderId') != order_id) or
                (sample.get('orderId') is not None and sample['orderId'] != order_id) or
                not valid_hash(sample.get('egressHash')) or
                sample.get('egressAfterHash') != sample['egressHash'] or
                sample.get('egressVerifiedAfter') is not True or cleanup.get('removed') is not True):
            raise RuntimeError('BATCH_SAMPLE_AUDIT_INVALID')
        if sample['egressHash'] in rejected:
            raise RuntimeError('BATCH_REJECTED_EGRESS_REUSED')


def check_boundary(root, plan_sha):
    try:
        checkWriteBoundary(root, plan_sha)
    except RuntimeError as error:
        codes = {'WRITE_BOUNDARY_PLAN_CHANGED': 'BACKFILL_SCOPE_INVALID',
                 'WRITE_BOUNDARY_STOP_REQUESTED': 'BATCH_STOP_REQUESTED',
                 'WRITE_BOUNDARY_CLEANUP_PENDING': 'BATCH_SAMPLE_CLEANUP_REQUIRED',
                 'MANUAL_RECONCILIATION_REQUIRED': 'BATCH_RECONCILIATION_REQUIRED'}
        raise RuntimeError(codes.get(str(error), 'BATCH_RECONCILIATION_REQUIRED')) from None
    validate_plan(strict_json(read_private(root / 'private/plan.json')))


def confirmed_applies(root, plan, plan_sha):
    """采纳本冻结计划已确认的单样本状态/日期提交；不据此宣称 SN 完整。"""
    confirmed = set()
    entries = {entry['id']: entry for entry in plan['entries']}
    for intent_file in (root / 'private').glob('http-apply-intent-*.json'):
        intent = json.loads(read_private(intent_file))
        if not isinstance(intent, dict) or intent.get('state') not in ('APPLIED', 'ROLLED_BACK'):
            raise RuntimeError('BATCH_RECONCILIATION_REQUIRED')
        if intent['state'] == 'ROLLED_BACK':
            continue
        try:
            order_id = intent['orderId']
            run_id = intent['runId']
            attempt = intent['attemptId']
            if (not valid_int(order_id) or not valid_int(run_id) or
                    intent_file.name != 'http-apply-intent-' + str(order_id) + '.json' or
                    not isinstance(attempt, str) or not re.fullmatch(r'[a-f0-9]{32}', attempt)):
                raise ValueError()
            prefix = 'http-apply-' + str(order_id) + '-' + attempt
            for key, suffix in (('payloadFile', '-payload.json'), ('previewFile', '-preview.json'),
                                ('resultFile', '-result.json'), ('auditFile', '-audit.json')):
                if intent.get(key) != prefix + suffix:
                    raise ValueError()
            result = json.loads(read_private(root / 'private' / intent['resultFile']))
            basis = result['basis']
            if not isinstance(basis, dict) or not valid_hash(basis.get('planSha256')):
                raise ValueError()
            if basis['planSha256'] != plan_sha:
                continue
            entry = entries[order_id]
            source_audit_name = intent['sourceAudit']
            if (not isinstance(source_audit_name, str) or
                    not re.fullmatch('http-sample-' + str(order_id) + r'-[a-f0-9]{32}\.json', source_audit_name)):
                raise ValueError()
            source_bytes = read_private(root / 'private' / source_audit_name)
            source_audit = json.loads(source_bytes)
            public_audit = json.loads(read_private(root / 'private' / intent['auditFile']))
            payload = json.loads(read_private(root / 'private' / intent['payloadFile']))
            expected_basis = {'version': 1, 'planSha256': plan_sha, 'orderId': order_id,
                              'originalRowHash': entry['rowHash'], 'stableRowHash': basis['stableRowHash'],
                              'runId': run_id, 'auditSha256': hashlib.sha256(source_bytes).hexdigest()}
            basis_name = 'http-apply-basis-' + str(order_id) + '-run-' + str(run_id) + '.json'
            if (basis != expected_basis or not re.fullmatch(r'[a-f0-9]{32}', basis['stableRowHash']) or
                    result.get('version') != 1 or result.get('mode') != 'apply' or
                    result.get('orderId') != order_id or result.get('runId') != run_id or
                    not valid_int(result.get('businessWrites'), 0) or result['businessWrites'] > 1 or
                    source_audit.get('outcome') != 'SUCCEEDED' or source_audit.get('orderId') != order_id or
                    source_audit.get('targetOrderId') != order_id or source_audit.get('runId') != run_id or
                    source_audit_name != 'http-sample-' + str(order_id) + '-' + source_audit.get('attemptId', '') + '.json' or
                    source_audit.get('cleanup', {}).get('removed') is not True or
                    source_audit.get('egressVerifiedAfter') is not True or
                    not valid_hash(source_audit.get('egressHash')) or
                    source_audit.get('egressAfterHash') != source_audit['egressHash'] or
                    public_audit.get('outcome') != 'SUCCEEDED' or public_audit.get('resultFile') != intent['resultFile'] or
                    public_audit.get('auditFile') != intent['auditFile'] or public_audit.get('basisFile') != basis_name or
                    any(public_audit.get(key) != result.get(key) for key in
                        ('orderId', 'runId', 'mode', 'businessWrites', 'beforeHash', 'afterHash', 'sha256')) or
                    payload.get('planSha256') != plan_sha or payload.get('entry') != entry or
                    payload.get('audit') != source_audit or
                    json.loads(read_private(root / 'private' / basis_name)) != basis):
                raise ValueError()
            confirmed.add(order_id)
        except (KeyError, ValueError, TypeError, AttributeError, OSError):
            raise RuntimeError('BATCH_CONFIRMED_APPLY_INVALID')
    return confirmed


def _execute(root, ids, limit, apply, proxy_index, concurrency=1):
    plan_bytes = read_private(root / 'private/plan.json')
    plan = json.loads(plan_bytes)
    scope = validate_plan(plan)
    selected = scope if not ids else ids
    if (not valid_int(limit) or not valid_int(proxy_index, 0) or
            any(not valid_int(value) for value in selected) or
            len(selected) != len(set(selected)) or not set(selected).issubset(set(scope))):
        raise RuntimeError('BACKFILL_SCOPE_INVALID')
    plan_sha = hashlib.sha256(plan_bytes).hexdigest()
    try:
        check_boundary(root, plan_sha)
    except RuntimeError as error:
        # 入口 STOP 沿用原有零处理结束；全局未知意图仍优先失败。
        if str(error) != 'BATCH_STOP_REQUESTED':
            raise
    journal = root / ('private/' + (JOURNALS[0] if apply else JOURNALS[1]))
    quarantined = set()
    states = {name: journal_state(root / 'private' / name, plan_sha, set(scope), quarantined=quarantined)
              for name in JOURNALS}
    if ids and quarantined.intersection(selected):
        raise RuntimeError('BATCH_TARGET_QUARANTINED')
    confirmed = confirmed_applies(root, plan, plan_sha)
    retries = authorization_state(root, plan_sha)
    other_mode = {order_id for order_id, retry in retries.items() if retry['journal'] != journal.name}
    consumed = {order_id for order_id, retry in retries.items() if retry['consumed']}
    if ids and other_mode.intersection(selected):
        raise RuntimeError('BATCH_DEFERRED_RETRY_MODE_MISMATCH')
    if ids and (consumed - states[journal.name] - confirmed - quarantined).intersection(selected):
        raise RuntimeError('BATCH_DEFERRED_RETRY_CONSUMED')
    processed = states[journal.name] | confirmed | quarantined | other_mode | consumed
    proxies = json.loads(read_private(root / 'private/iproyal-cn.json')).get('entries')
    if not isinstance(proxies, list) or not proxies or proxy_index >= len(proxies):
        raise RuntimeError('PROXY_INDEX_INVALID')
    rejected_file = root / 'private/http-rejected-egress.json'
    rejected_values = json.loads(read_private(rejected_file)) if rejected_file.exists() else []
    if not isinstance(rejected_values, list) or any(not valid_hash(value) for value in rejected_values):
        raise RuntimeError('BATCH_REJECTED_EGRESS_INVALID')
    rejected = set(rejected_values)
    if concurrency != 1:
        from parallelHttpBatch import execute_waves
        return execute_waves(root, plan, plan_sha, [i for i in selected if i not in processed][:limit],
                             journal, retries, proxies, proxy_index, rejected, apply, concurrency)
    count = 0
    for order_id in selected:
        if order_id in processed:
            continue
        if count >= limit or (root / 'private/STOP').exists():
            break
        check_boundary(root, plan_sha)
        record = {'orderId': order_id, 'planSha256': plan_sha, 'batchAttemptId': uuid.uuid4().hex}
        if order_id in retries:
            record['retryAuthorizationId'] = retries[order_id]['event']['authorizationId']
        append(journal, dict(record, event='order_started', at=time.time()))
        if order_id in retries:
            if not authorization_state(root, plan_sha)[order_id]['consumed']:
                raise RuntimeError('BATCH_DEFERRED_RETRY_DENIED')
        attempts = set()
        probes = 0
        while True:
            check_boundary(root, plan_sha)
            if proxy_index >= len(proxies) or probes >= MAX_PROBES:
                raise RuntimeError('NO_FRESH_EGRESS')
            # 每个采样器仍调用持久 PostgreSQL Gate；541三次上限独立于滚动24小时十次。
            sample = child(['python3', str(root / 'release/scripts/officialOrder/runHttpSample.py'),
                            '--root', str(root), '--id', str(order_id), '--proxy-index', str(proxy_index)], 420)
            append(journal, dict(record, event='sample_finished', at=time.time(), sample=sample))
            validate_sample(root, sample, order_id, proxy_index, rejected)
            probes += 1
            if sample.get('runId') is not None:
                if not valid_int(sample['runId']) or sample['runId'] in attempts:
                    raise RuntimeError('BATCH_SAMPLE_AUDIT_INVALID')
                attempts.add(sample['runId'])
            if sample['outcome'] in ('HTTP_541', 'EGRESS_CHANGED_OR_UNVERIFIED'):
                rejected.update(value for value in (sample.get('egressHash'), sample.get('egressAfterHash'))
                                if valid_hash(value))
                writePrivate(rejected_file, sorted(rejected))
                sync_directory(rejected_file.parent)
            # 本次已确认的负向出口保护先持久化；停机后仍不启动下一请求或业务写入。
            check_boundary(root, plan_sha)
            if (sample['outcome'] in ROTATE or retryable_read_failure(sample)) and len(attempts) < MAX_ATTEMPTS:
                proxy_index += 1
                continue
            break
        check_boundary(root, plan_sha)
        applied = None
        if sample['outcome'] == 'SUCCEEDED':
            audit = 'http-sample-' + str(order_id) + '-' + sample['attemptId'] + '.json'
            command = ['python3', str(root / 'release/scripts/officialOrder/applyHttpSample.py'),
                       '--root', str(root), '--audit', audit]
            if apply:
                command.append('--apply')
            check_boundary(root, plan_sha)
            applied = child(command, 150)
            if applied['outcome'] != ('SUCCEEDED' if apply else 'DRY_RUN'):
                append(journal, dict(record, event='apply_failed', at=time.time(), result=applied))
                raise RuntimeError('BATCH_APPLY_STOPPED')
            if (applied.get('orderId') != order_id or applied.get('runId') != sample['runId'] or
                    applied.get('mode') != ('apply' if apply else 'dry-run') or
                    not valid_int(applied.get('businessWrites'), 0) or
                    applied['businessWrites'] > (1 if apply else 0)):
                raise RuntimeError('BATCH_APPLY_OUTPUT_INVALID')
        elif sample['outcome'] not in DEFERRED and sample['outcome'] != 'HTTP_541' and not retryable_read_failure(sample):
            raise RuntimeError('BATCH_COLLECTOR_STOPPED')
        check_boundary(root, plan_sha)
        final = dict(record, event='order_finished', at=time.time(),
                     sampleOutcome=sample['outcome'], receiptOutcome=sample.get('receiptOutcome'), apply=applied)
        if retryable_read_failure(sample):
            final['readFailureVerified'] = True
        append(journal, final)
        count += 1
        if sample['outcome'] == 'HTTP_541' or retryable_read_failure(sample):
            proxy_index += 1
        print(json.dumps({'orderId': order_id, 'sampleOutcome': sample['outcome'],
                          'applyOutcome': applied and applied['outcome'], 'processedThisRun': count}), flush=True)
    return {'outcome': 'BATCH_PASS_FINISHED', 'processedThisRun': count,
            'previouslyConfirmedStatusDate': len(confirmed.intersection(selected)),
            'quarantinedOrderIds': sorted(quarantined.intersection(selected)),
            'allFieldsComplete': False}


def execute(root, ids, limit, apply=False, proxy_index=0, concurrency=1):
    """固定计划子集的独占入口；默认演练，任何未决历史阻止跨模式重放。"""
    root = pathlib.Path(root)
    if not root.is_absolute() or not (root / 'private').is_dir() or (root / 'private').is_symlink():
        raise RuntimeError('INPUT_INVALID')
    root = root.resolve(strict=True)
    descriptor = os.open(str(root / 'private/http-batch.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('HTTP_BATCH_BUSY')
        return _execute(root, ids, limit, apply, proxy_index, concurrency)


def deferred_api():
    """让独立授权模块复用原全局边界、历史对账和持久日志，不加载采集器。"""
    return {'validatePlan': validate_plan, 'check': check_boundary, 'journal': journal_state,
            'confirmed': confirmed_applies, 'append': append, 'sync': sync_directory}


def reconcile_probe_failure(root, journal_name, order_id, batch_attempt, sample_attempt):
    """显式追加未启动探测失败的对账事件；不启动子进程、不完成目标或清除历史。"""
    root = pathlib.Path(root)
    if (not root.is_absolute() or not (root / 'private').is_dir() or (root / 'private').is_symlink() or
            journal_name not in JOURNALS or not valid_int(order_id) or
            any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value)
                for value in (batch_attempt, sample_attempt))):
        raise RuntimeError('BATCH_RECONCILIATION_ARGUMENT_INVALID')
    root = root.resolve(strict=True)
    with contextlib.ExitStack() as stack:
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            descriptor = os.open(str(root / 'private' / name), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            lock = stack.enter_context(os.fdopen(descriptor, 'a'))
            os.fchmod(lock.fileno(), 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('BATCH_RECONCILIATION_BUSY')
        plan_raw = read_private(root / 'private/plan.json')
        scope = set(validate_plan(strict_json(plan_raw)))
        plan_sha = hashlib.sha256(plan_raw).hexdigest()
        if order_id not in scope:
            raise RuntimeError('BACKFILL_SCOPE_INVALID')
        check_boundary(root, plan_sha)
        if os.path.lexists(str(root / 'private/http-cleanup-blocked.json')):
            raise RuntimeError('BATCH_SAMPLE_CLEANUP_REQUIRED')
        # 任意未决写入仍阻断；同目标即使已确认也不得解释成这次「从未开始」。
        for pattern, prefix in (('http-apply-intent-*.json', 'http-apply-intent-'),
                                ('browser-receipt-bind-intent-*.json', 'browser-receipt-bind-intent-')):
            for filename in (root / 'private').glob(pattern):
                intent = strict_json(read_private(filename))
                if (not isinstance(intent, dict) or not valid_int(intent.get('orderId')) or
                        filename.name != prefix + str(intent['orderId']) + '.json' or
                        intent.get('state') not in ('APPLIED', 'ROLLED_BACK') or intent['orderId'] == order_id):
                    raise RuntimeError('BATCH_RECONCILIATION_REQUIRED')
        pending = {}
        for name in JOURNALS:
            journal_state(root / 'private' / name, plan_sha, scope, pending if name == journal_name else None)
        sample = pending.get('sample')
        if (pending.get('orderId') != order_id or pending.get('batchAttemptId') != batch_attempt or
                pending.get('applyFailed') is not False or not 1 <= pending.get('sampleCount', 0) <= MAX_ATTEMPTS or
                not isinstance(sample, dict) or sample.get('attemptId') != sample_attempt):
            raise RuntimeError('BATCH_PROBE_RECONCILIATION_DENIED')
        reconciled_at = time.time()
        preceding = probe_preceding_evidence(root, pending['sampleHistory'], order_id, pending['startedAt'], reconciled_at)
        if preceding:
            no_target_artifacts(root, order_id)
            for prior in pending['sampleHistory'][:-1]:
                runtime_boundary(root, prior['sample'])
        audit_name, audit_sha = probe_failure_evidence(
            root, sample, order_id, pending['startedAt'], pending['sampleAt'], reconciled_at)
        check_boundary(root, plan_sha)
        event = {'event': 'probe_failure_reconciled', 'at': reconciled_at, 'orderId': order_id,
                 'batchAttemptId': batch_attempt, 'sampleAttemptId': sample_attempt, 'planSha256': plan_sha,
                 'resolution': 'FAILED_541_THEN_CANCELLED_BEFORE_COLLECTOR' if preceding else 'CANCELLED_BEFORE_COLLECTOR', 'auditFile': audit_name,
                 'auditSha256': audit_sha, 'businessWrites': 0}
        if preceding:
            event['precedingFailures'] = preceding
        append(root / 'private' / journal_name, event)
        journal_state(root / 'private' / journal_name, plan_sha, scope)
        return {'outcome': 'BATCH_PROBE_FAILURE_RECONCILED', 'orderId': order_id,
                'batchAttemptId': batch_attempt, 'sampleAttemptId': sample_attempt,
                'journal': journal_name, 'auditFile': audit_name, 'auditSha256': audit_sha,
                'targetCompleted': False, 'businessWrites': 0, 'allFieldsComplete': False}


def quarantine_failed_read(root, journal_name, order_id, batch_attempt, sample_attempt, proof_name, proof_sha):
    """显式隔离已确认无回写的 541/超时及后置出口未知失败；本计划不再采样该目标。"""
    root = pathlib.Path(root)
    if (not root.is_absolute() or not (root / 'private').is_dir() or (root / 'private').is_symlink() or
            journal_name not in JOURNALS or not valid_int(order_id) or
            any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value)
                for value in (batch_attempt, sample_attempt)) or
            proof_name != 'http-failure-proof-' + str(order_id) + '-' + sample_attempt + '.json' or
            not valid_hash(proof_sha)):
        raise RuntimeError('BATCH_QUARANTINE_ARGUMENT_INVALID')
    root = root.resolve(strict=True)
    with contextlib.ExitStack() as stack:
        for name in ('http-batch.lock', 'http-sample.lock', 'http-apply.lock'):
            descriptor = os.open(str(root / 'private' / name), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            lock = stack.enter_context(os.fdopen(descriptor, 'a'))
            os.fchmod(lock.fileno(), 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('BATCH_RECONCILIATION_BUSY')
        plan_raw = read_private(root / 'private/plan.json')
        scope = set(validate_plan(strict_json(plan_raw)))
        plan_sha = hashlib.sha256(plan_raw).hexdigest()
        if order_id not in scope:
            raise RuntimeError('BACKFILL_SCOPE_INVALID')
        check_boundary(root, plan_sha)
        if os.path.lexists(str(root / 'private/http-cleanup-blocked.json')):
            raise RuntimeError('BATCH_SAMPLE_CLEANUP_REQUIRED')
        for pattern, prefix in (('http-apply-intent-*.json', 'http-apply-intent-'),
                                ('browser-receipt-bind-intent-*.json', 'browser-receipt-bind-intent-')):
            for filename in (root / 'private').glob(pattern):
                intent = strict_json(read_private(filename))
                if (not isinstance(intent, dict) or not valid_int(intent.get('orderId')) or
                        filename.name != prefix + str(intent['orderId']) + '.json' or
                        intent.get('state') not in ('APPLIED', 'ROLLED_BACK') or intent['orderId'] == order_id):
                    raise RuntimeError('BATCH_RECONCILIATION_REQUIRED')
        pending_all = {}
        quarantined = set()
        for name in JOURNALS:
            journal_state(root / 'private' / name, plan_sha, scope,
                          quarantined=quarantined, pending_by_order=pending_all if name == journal_name else None)
        pending = pending_all.get(order_id, {})
        sample = pending.get('sample')
        if (order_id in quarantined or pending.get('orderId') != order_id or
                pending.get('batchAttemptId') != batch_attempt or pending.get('applyFailed') is not False or
                not 1 <= pending.get('sampleCount', 0) <= MAX_ATTEMPTS or not isinstance(sample, dict) or
                sample.get('attemptId') != sample_attempt):
            raise RuntimeError('BATCH_FAILURE_QUARANTINE_DENIED')
        at = time.time()
        preceding = preceding_failure_evidence(root, pending['sampleHistory'], order_id, pending['startedAt'], at)
        evidence = verify_failure(root, plan_sha, order_id, batch_attempt, sample,
                                  pending['startedAt'], pending['sampleAt'], proof_name, proof_sha, at)
        check_boundary(root, plan_sha)
        event = {'event': 'failed_read_only_quarantined', 'at': at, 'orderId': order_id,
                 'batchAttemptId': batch_attempt, 'sampleAttemptId': sample_attempt, 'runId': sample['runId'],
                 'planSha256': plan_sha, 'resolution': ('FAILED_WITHOUT_APPLY_VERIFIED_EGRESS' if sample['egressVerifiedAfter'] else 'FAILED_WITHOUT_APPLY_UNVERIFIED_EGRESS'),
                 'proofFile': proof_name, 'proofSha256': proof_sha, 'verification': evidence,
                 'precedingFailures': preceding,
                 'targetCompleted': False, 'egressVerifiedAfter': sample['egressVerifiedAfter'], 'businessWrites': 0}
        append(root / 'private' / journal_name, event)
        remaining = {}
        journal_state(root / 'private' / journal_name, plan_sha, scope, pending_by_order=remaining)
        if order_id in remaining:
            raise RuntimeError('BATCH_FAILURE_QUARANTINE_DENIED')
        return {'outcome': 'BATCH_FAILURE_QUARANTINED', 'orderId': order_id, 'runId': sample['runId'],
                'journal': journal_name, 'proofFile': proof_name, 'proofSha256': proof_sha,
                'targetCompleted': False, 'egressVerifiedAfter': sample['egressVerifiedAfter'],
                'businessWrites': 0, 'allFieldsComplete': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--concurrency', type=int, choices=(1, 3, 5, 10), default=1)
    parser.add_argument('--ids', default='')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--proxy-index', type=int, default=0)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--freeze-deferred', action='store_true')
    parser.add_argument('--reopen-deferred', action='store_true')
    parser.add_argument('--manifest')
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--legacy-before', type=float)
    parser.add_argument('--reconcile-probe-failure', action='store_true')
    parser.add_argument('--quarantine-failed-read', action='store_true')
    parser.add_argument('--proof')
    parser.add_argument('--proof-sha256')
    parser.add_argument('--journal', choices=('apply', 'dry-run'))
    parser.add_argument('--order-id', type=int)
    parser.add_argument('--batch-attempt-id')
    parser.add_argument('--sample-attempt-id')
    args = parser.parse_args()
    reconciliation_values = (args.journal, args.order_id, args.batch_attempt_id, args.sample_attempt_id)
    if args.freeze_deferred or args.reopen_deferred:
        if (args.freeze_deferred == args.reopen_deferred or args.reconcile_probe_failure or args.quarantine_failed_read or
                args.apply or args.limit != 10 or args.proxy_index != 0 or not args.ids or not args.manifest or
                args.order_id is not None or args.batch_attempt_id is not None or args.sample_attempt_id is not None or
                args.proof is not None or args.proof_sha256 is not None):
            raise RuntimeError('BATCH_DEFERRED_ARGUMENT_INVALID')
        ids = [int(value) for value in args.ids.split(',')]
        if args.freeze_deferred:
            if args.journal is not None or args.manifest_sha256 is not None or args.legacy_before is None:
                raise RuntimeError('BATCH_DEFERRED_ARGUMENT_INVALID')
            result = freeze_deferred(pathlib.Path(args.root), ids, args.manifest, args.legacy_before, deferred_api())
        else:
            if args.journal is None or args.manifest_sha256 is None or args.legacy_before is not None:
                raise RuntimeError('BATCH_DEFERRED_ARGUMENT_INVALID')
            result = reopen_deferred(pathlib.Path(args.root), ids, JOURNALS[0 if args.journal == 'apply' else 1],
                                     args.manifest, args.manifest_sha256, deferred_api())
        print(json.dumps(result))
        return
    if args.manifest is not None or args.manifest_sha256 is not None or args.legacy_before is not None:
        raise RuntimeError('BATCH_DEFERRED_ARGUMENT_INVALID')
    if args.quarantine_failed_read:
        if (args.reconcile_probe_failure or any(value is None for value in reconciliation_values) or
                not args.proof or not args.proof_sha256 or args.apply or args.ids or
                args.limit != 10 or args.proxy_index != 0):
            raise RuntimeError('BATCH_QUARANTINE_ARGUMENT_INVALID')
        result = quarantine_failed_read(pathlib.Path(args.root),
            JOURNALS[0] if args.journal == 'apply' else JOURNALS[1], args.order_id,
            args.batch_attempt_id, args.sample_attempt_id, args.proof, args.proof_sha256)
        print(json.dumps(result))
        return
    if args.proof is not None or args.proof_sha256 is not None:
        raise RuntimeError('BATCH_QUARANTINE_ARGUMENT_INVALID')
    if args.reconcile_probe_failure:
        if (any(value is None for value in reconciliation_values) or args.apply or args.ids or
                args.limit != 10 or args.proxy_index != 0):
            raise RuntimeError('BATCH_RECONCILIATION_ARGUMENT_INVALID')
        result = reconcile_probe_failure(pathlib.Path(args.root),
            JOURNALS[0] if args.journal == 'apply' else JOURNALS[1], args.order_id,
            args.batch_attempt_id, args.sample_attempt_id)
        print(json.dumps(result))
        return
    if any(value is not None for value in reconciliation_values):
        raise RuntimeError('BATCH_RECONCILIATION_ARGUMENT_INVALID')
    ids = [int(value) for value in args.ids.split(',')] if args.ids else []
    print(json.dumps(execute(pathlib.Path(args.root), ids, args.limit, args.apply, args.proxy_index, args.concurrency)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'outcome': code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code)
                          else 'BATCH_FAILED', 'allFieldsComplete': False}), flush=True)
        raise SystemExit(2)
