"""三至十单并发读取、串行核验回写；父锁覆盖整批，失败日志保持可追溯。"""
import concurrent.futures
import fcntl
import os
import re
import time
import uuid

import runHttpBatch as batch
from runHttpSample import writePrivate


def select_wave(queue, accounts, width):
    """同账号每波最多一单，未选目标保留原顺序。"""
    selected = []
    used = set()
    for order_id in queue:
        account = accounts[order_id]
        if account not in used:
            selected.append(order_id)
            used.add(account)
        if len(selected) == width:
            break
    return selected


def collect_wave(root, jobs, descriptor):
    """仅子采样器并发；所有日志、拒绝出口和回写由主线程处理。"""
    def collect(job):
        order_id, proxy_index = job
        try:
            return batch.child(['python3', str(root / 'release/scripts/officialOrder/runHttpSample.py'),
                                '--root', str(root), '--id', str(order_id), '--proxy-index', str(proxy_index),
                                '--sample-lock-fd', str(descriptor)], 420, pass_fds=(descriptor,))
        except Exception:
            return None
    if not 1 <= len(jobs) <= 10:
        raise RuntimeError('BATCH_CONCURRENCY_INVALID')
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = [pool.submit(collect, job) for job in jobs]
        return [future.result() for future in futures]


def execute_waves(root, plan, plan_sha, selected, journal, retries, proxies, proxy_index, rejected, apply, concurrency):
    """固定范围内三至十路读取；未决读取阻止下一波，未决写入立即停止。"""
    if concurrency not in (3, 5, 10):
        raise RuntimeError('BATCH_CONCURRENCY_INVALID')
    accounts = {entry['id']: entry.get('accountKey') for entry in plan['entries']}
    if any(not isinstance(accounts[i], str) or not re.fullmatch(r'[a-f0-9]{32}', accounts[i]) for i in selected):
        raise RuntimeError('BACKFILL_SCOPE_INVALID')
    queue = list(selected)
    active = {}
    count = 0
    maximum_overlap = 0
    descriptor = os.open(str(root / 'private/http-sample.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('HTTP_SAMPLE_BUSY')
        while queue:
            batch.check_boundary(root, plan_sha)
            wave = select_wave(queue, accounts, concurrency)
            if proxy_index + len(wave) > len(proxies):
                raise RuntimeError('NO_FRESH_EGRESS')
            jobs = []
            for order_id in wave:
                if order_id not in active:
                    record = {'orderId': order_id, 'planSha256': plan_sha, 'batchAttemptId': uuid.uuid4().hex}
                    if order_id in retries:
                        record['retryAuthorizationId'] = retries[order_id]['event']['authorizationId']
                    batch.append(journal, dict(record, event='order_started', at=time.time()))
                    active[order_id] = {'record': record, 'attempts': set(), 'probes': 0}
                jobs.append((order_id, proxy_index))
                proxy_index += 1
            samples = collect_wave(root, jobs, descriptor)
            fatal = False
            usable = []
            # All collectors are stopped before any apply begins. Persist every returned audit first.
            for (order_id, proxy), sample in zip(jobs, samples):
                state = active[order_id]
                if sample is None:
                    fatal = True
                    continue
                batch.append(journal, dict(state['record'], event='sample_finished', at=time.time(), sample=sample))
                try:
                    batch.validate_sample(root, sample, order_id, proxy, rejected)
                    state['probes'] += 1
                    run_id = sample.get('runId')
                    if run_id is not None:
                        if not batch.valid_int(run_id) or run_id in state['attempts']:
                            raise RuntimeError('BATCH_SAMPLE_AUDIT_INVALID')
                        state['attempts'].add(run_id)
                    usable.append((order_id, sample))
                except Exception:
                    fatal = True
            for _order_id, sample in usable:
                if sample['outcome'] in ('HTTP_541', 'EGRESS_CHANGED_OR_UNVERIFIED'):
                    rejected.update(value for value in (sample.get('egressHash'), sample.get('egressAfterHash'))
                                    if batch.valid_hash(value))
            writePrivate(root / 'private/http-rejected-egress.json', sorted(rejected))
            batch.sync_directory(root / 'private')
            # Record the observed overlap of actual sample intervals, not just configured workers.
            intervals = [(s['startedAt'], 1) for _i, s in usable] + [(s['finishedAt'], -1) for _i, s in usable]
            running = 0
            for _at, delta in sorted(intervals):
                running += delta
                maximum_overlap = max(maximum_overlap, running)
            batch.check_boundary(root, plan_sha)
            for order_id, sample in sorted(usable, key=lambda item: item[1]['finishedAt']):
                state = active[order_id]
                outcome = sample['outcome']
                if (outcome in batch.ROTATE or batch.retryable_read_failure(sample)) and len(state['attempts']) < batch.MAX_ATTEMPTS and state['probes'] < batch.MAX_PROBES:
                    continue
                applied = None
                if outcome == 'SUCCEEDED':
                    # An exit rejected by another member of this wave cannot be used for a write.
                    if sample['egressHash'] in rejected:
                        fatal = True
                        continue
                    batch.check_boundary(root, plan_sha)
                    audit = 'http-sample-' + str(order_id) + '-' + sample['attemptId'] + '.json'
                    command = ['python3', str(root / 'release/scripts/officialOrder/applyHttpSample.py'),
                               '--root', str(root), '--audit', audit]
                    if apply:
                        command.append('--apply')
                    applied = batch.child(command, 150)
                    if (applied.get('outcome') != ('SUCCEEDED' if apply else 'DRY_RUN') or
                            applied.get('orderId') != order_id or applied.get('runId') != sample['runId'] or
                            applied.get('mode') != ('apply' if apply else 'dry-run') or
                            not batch.valid_int(applied.get('businessWrites'), 0) or
                            applied['businessWrites'] > (1 if apply else 0)):
                        batch.append(journal, dict(state['record'], event='apply_failed', at=time.time(), result=applied))
                        raise RuntimeError('BATCH_APPLY_STOPPED')
                elif outcome not in batch.DEFERRED and outcome != 'HTTP_541' and not batch.retryable_read_failure(sample):
                    fatal = True
                    continue
                batch.check_boundary(root, plan_sha)
                final = dict(state['record'], event='order_finished', at=time.time(),
                             sampleOutcome=outcome, receiptOutcome=sample.get('receiptOutcome'), apply=applied)
                if batch.retryable_read_failure(sample):
                    final['readFailureVerified'] = True
                batch.append(journal, final)
                queue.remove(order_id)
                count += 1
                print(batch.json.dumps({'orderId': order_id, 'sampleOutcome': outcome,
                                        'applyOutcome': applied and applied['outcome'], 'processedThisRun': count,
                                        'concurrency': concurrency}), flush=True)
            if fatal:
                raise RuntimeError('BATCH_COLLECTOR_STOPPED')
    return {'outcome': 'BATCH_PASS_FINISHED', 'processedThisRun': count, 'concurrency': concurrency,
            'maximumObservedSampleOverlap': maximum_overlap, 'nextProxyIndex': proxy_index, 'allFieldsComplete': False}
