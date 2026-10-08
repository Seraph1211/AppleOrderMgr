#!/usr/bin/env python3
"""固定计划的三账号执行器；隔离浏览器与会话，共享限流、证据和审计。"""
import argparse
import concurrent.futures
import hashlib
import ipaddress
import json
import os
import pathlib
import queue
import re
import shutil
import threading
import time
import uuid
from urllib.parse import quote, unquote, urlsplit

from runtime import (DEFAULT_ROOT, IMAGE, MAX_WORKERS, CONNECTIONS_PER_WORKER,
                     MAX_BATCH_CHANNELS, OTHER_PROXY_CHANNELS, PROXY_CHANNEL_CAPACITY,
                     RETRYABLE, FATAL, call, readJson, writeJson, fileLock, append, records,
                     event, validatePlan, safeCode, rejectionSet, chooseGroups, shaFile, timestamp, reserveChannel,
                     fullScope, threeFieldScope, missingScope)
import receiptWorkflow
from proxyPool import ProvidedProxyPool, providerFor, proxyHash, IPROYAL_LEASE_SECONDS

SOURCE_MODULES = '/research/release/src/services'
APPLY_JS = """const{Client}=require('pg');const Module=require('module');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',async()=>{const c=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});try{const p=JSON.parse(raw);const m=new Module('/app/src/services/officialPickupBackfillV6.js',module);m.filename='/app/src/services/officialPickupBackfillV6.js';m.paths=module.paths;m._compile(p.code,m.filename);await c.connect();const output=p.prepare?await m.exports.preparePickupStatusPlan(c,p.plan):await m.exports.applyPickupBackfill(c,p.plan,p.entry,p.result);process.stdout.write(JSON.stringify(output));}catch(e){process.stderr.write(e.code||e.name);process.exitCode=1;}finally{await c.end();}});"""
VERIFY_JS = """const fs=require('fs');const{decrypt,hash,readPrivate}=require('/app/src/services/officialOrderSupport');const{parseOfficialOrderDetail}=require('/app/src/services/officialOrderParser');const plan=readPrivate('/research/private/plan.json');const result=readPrivate(process.env.RESULT_FILE);const entry=plan.entries.find(e=>e.id===result.systemOrderId);if(!entry)throw Error('SCOPE');const source=result.source;if(!/^body-[a-zA-Z0-9-]+\\.enc$/.test(source.file))throw Error('FILE');const bytes=decrypt(fs.readFileSync('/research/evidence/run-'+source.runId+'/'+source.file),readPrivate('/research/private/evidence.key',false));if(hash(bytes)!==source.sha256)throw Error('HASH');const parsed=parseOfficialOrderDetail(bytes.toString(),entry.orderNumber);process.stdout.write(JSON.stringify({plan,entry,result:{...parsed,systemOrderId:entry.id,source}}));"""


def applyPayload(root, payload):
    payload = dict(payload, code=(root / 'release/src/services/officialPickupBackfill.js').read_text(encoding='utf-8'))
    result = call(['docker', 'exec', '-i', 'apple-order-mgr-prod-api-1', 'node', '-e', APPLY_JS],
                  input=json.dumps(payload).encode(), timeout=30)
    if result.returncode:
        raise RuntimeError(safeCode(result.stderr.decode().strip()))
    return json.loads(result.stdout)


def preparePlan(root):
    original = readJson(root / 'private/plan.json')
    validatePlan(original)
    target = root / 'private/status-plan.json'
    if target.exists():
        plan = readJson(target)
        validatePlan(plan, original)
        if plan.get('originalPlanSha256') != shaFile(root / 'private/plan.json'):
            raise RuntimeError('BACKFILL_SCOPE_INVALID')
        return plan
    plan = applyPayload(root, {'prepare': True, 'plan': original})
    plan['originalPlanSha256'] = shaFile(root / 'private/plan.json')
    validatePlan(plan, original)
    writeJson(target, plan)
    return plan


class Worker:
    def __init__(self, root, slot, plan, stop):
        self.root, self.slot, self.plan, self.stop = root, slot, plan, stop
        self.work = root / 'workers' / ('slot-' + str(slot))
        self.private = self.work / 'private'
        self.private.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.private / 'sessions').mkdir(exist_ok=True, mode=0o700)
        for name in ('db.json', 'evidence.key'):
            shutil.copyfile(str(root / 'private' / name), str(self.private / name))
            os.chmod(str(self.private / name), 0o600)
        for target, source in ((self.work / 'release', root / 'release'),
                               (self.work / 'deps', root / 'deps'),
                               (self.work / 'evidence', root / 'evidence'),
                               (self.private / 'results', root / 'private/results')):
            if not target.exists():
                target.symlink_to(source)
            if target.resolve() != source.resolve():
                raise RuntimeError('WORKER_PATH_INVALID')
        writeJson(self.private / 'plan.json', plan)
        self.cachedProxy = None
        self.provider = providerFor(root)
        self.proxyPool = ProvidedProxyPool(root) if self.provider == 'iproyal' else None
        self.proxyPauses = {}
        if threeFieldScope(plan):
            paused = self.dockerRead('preflightGate.js', ['--proxies'])
            if paused.returncode:
                raise RuntimeError('PROXY_PREFLIGHT_FAILED')
            self.proxyPauses = {row['key']: row['reason'] for row in json.loads(paused.stdout)}
        if self.provider == 'fanproxy' and (self.private / 'collectorConfig.json').exists() and (self.private / 'active-proxy.json').exists():
            previous = readJson(self.private / 'collectorConfig.json').get('leaseContext', {})
            if previous.get('startedAt'):
                proxy = readJson(self.private / 'active-proxy.json')
                if proxy.get('provider', 'fanproxy') != 'fanproxy':
                    raise RuntimeError('PROXY_PROVIDER_MISMATCH')
                proxy['maxConnections'] = CONNECTIONS_PER_WORKER
                startedAt = timestamp(previous['startedAt'])
                if 0 <= time.time() - startedAt < 390:
                    reservation = reserveChannel(root, previous['proxyHash'], startedAt)
                    if reservation['waitUntil'] is None:
                        self.cachedProxy = (proxy, previous['egressHash'], startedAt)
        if os.geteuid() == 0:
            for path in (self.work, self.private, self.private / 'sessions',
                         self.private / 'db.json', self.private / 'evidence.key'):
                os.chown(str(path), 1000, 1000)

    def dockerRead(self, script, extra=None):
        return call(['docker', 'run', '--rm', '--user', '0:0', '--read-only',
                     '--network', 'apple-account-research-internal',
                     '-v', str(self.work) + ':/research:ro',
                     '-v', str(self.root / 'release/src/services') + ':/app/src/services:ro',
                     '-v', str(self.root / 'release/scripts/officialPickupBackfill') + ':/ops:ro',
                     '--entrypoint', 'node', IMAGE, '/ops/' + script] + (extra or []), timeout=30)

    def eligible(self, entries, requireLogin=True):
        result = self.dockerRead('preflightGate.js')
        if result.returncode:
            raise RuntimeError('GATE_PREFLIGHT_FAILED')
        state = {row['id']: row for row in json.loads(result.stdout)}
        groupIds = {e['id'] for e in self.plan['entries'] if e['accountKey'] == entries[0]['accountKey']}
        protected = [row for key, row in state.items() if key in groupIds]
        eligible = []
        for entry in entries:
            count = state.get(entry['id'], {}).get('attempts', 0)
            reason = ('ACCOUNT_COOLDOWN' if any(r.get('account_until') for r in protected) else
                      'LOGIN_COOLDOWN' if requireLogin and not fullScope(self.plan) and any(r.get('login_until') for r in protected) else
                      'ORDER_ATTEMPT_LIMIT' if count >= 3 else
                      'INSUFFICIENT_RECEIPT_ATTEMPTS' if entry.get('receiptOnly') and count > 1 else None)
            if reason:
                append(self.root / 'private/deferred.jsonl', {'orderId': entry['id'], 'outcome': reason})
                event(self.root, 'order_deferred', orderId=entry['id'], outcome=reason)
            else:
                eligible.append(entry)
        return eligible

    def probe(self, proxy):
        # 自有站点探测串行，避免并发读取出口证据；不与粘性通道数混为一谈。
        with fileLock(self.root / 'private/proxy-probe.lock'):
            return self.probeExclusive(proxy)

    def probeExclusive(self, proxy):
        token = 'pickup-egress-' + uuid.uuid4().hex
        auth = quote(proxy['username'], safe='') + ':' + quote(proxy['password'], safe='')
        proxyUrl = 'http://' + auth + '@' + proxy['host'] + ':' + str(proxy['port'])
        target = '/index.html?' if fullScope(self.plan) else '/api/health/ready?'
        config = '\n'.join(['proxy = "' + proxyUrl + '"',
                            'url = "https://apple.godp.me' + target + token + '"']) + '\n'
        result = call(['curl', '-fsS', '--noproxy', '', '--max-time', '20', '--config', '-'],
                      input=config.encode(), timeout=25)
        if result.returncode or (not fullScope(self.plan) and not json.loads(result.stdout).get('success')):
            raise RuntimeError('EGRESS_PROBE_FAILED')
        with open('/var/log/nginx/apple-order-mgr-access.log', 'rb') as source:
            source.seek(0, 2)
            source.seek(max(0, source.tell() - 262144))
            lines = [line for line in source.read().decode(errors='replace').splitlines() if token in line]
        if len(lines) != 1:
            raise RuntimeError('EGRESS_LOG_UNAVAILABLE')
        ip = ipaddress.ip_address(lines[0].split()[0])
        if not ip.is_global:
            raise RuntimeError('EGRESS_NOT_PUBLIC')
        return hashlib.sha256(str(ip).encode()).hexdigest()

    def freshProxy(self):
        self.ensureRunning()
        if getattr(self, 'provider', 'fanproxy') == 'iproyal':
            return self.freshProvidedProxy()
        previous = getattr(self, 'cachedProxy', None)
        if previous and 0 <= time.time() - previous[2] < 390 and previous[1] not in rejectionSet(self.root):
            try:
                current = self.probe(previous[0])
                if current == previous[1]:
                    event(self.root, 'proxy_lease_reused', slot=self.slot, originalLeasePreserved=True)
                    return previous
                rejectionSet(self.root, [previous[1], current])
            except RuntimeError as error:
                if str(error) != 'EGRESS_PROBE_FAILED':
                    raise
                rejectionSet(self.root, [previous[1]])
        self.cachedProxy = None
        configured = readJson('/var/www/apple-order-mgr/shared/inventory-secrets/fan10m.json')
        url = urlsplit(configured['url'])
        for attempt in range(3):
            if self.stop.is_set():
                raise RuntimeError('COORDINATED_STOP')
            username, matches = re.subn(r'-sid-[A-Za-z0-9]+', '-sid-' + uuid.uuid4().hex[:12], unquote(url.username))
            if matches != 1:
                raise RuntimeError('SID_PATTERN_INVALID')
            proxy = {'host': url.hostname, 'port': url.port, 'username': username,
                     'password': unquote(url.password), 'preemptiveAuth': True,
                     'maxConnections': CONNECTIONS_PER_WORKER}
            proxyHash = hashlib.sha256((proxy['host'] + ':' + str(proxy['port']) + ':' + proxy['username']).encode()).hexdigest()
            waitingLogged = False
            while True:
                validatePlan(self.plan)
                reservation = reserveChannel(self.root, proxyHash, time.time())
                if reservation['waitUntil'] is None:
                    leaseStart = reservation['startedAt']
                    break
                if not waitingLogged:
                    event(self.root, 'channel_capacity_wait', slot=self.slot, until=reservation['waitUntil'])
                    waitingLogged = True
                if self.stop.wait(min(30, max(1, reservation['waitUntil'] - time.time()))):
                    raise RuntimeError('COORDINATED_STOP')
            try:
                egress = self.probe(proxy)
                if egress in rejectionSet(self.root):
                    event(self.root, 'rejected_egress_skipped', slot=self.slot)
                    continue
                self.cachedProxy = (proxy, egress, leaseStart)
                return self.cachedProxy
            except RuntimeError as error:
                if str(error) != 'EGRESS_PROBE_FAILED':
                    raise
                event(self.root, 'proxy_candidate_failed', slot=self.slot, reason=str(error), candidate=attempt + 1)
                # 只在连接故障后有界退避；不恢复逐订单固定等待。
                if attempt < 2:
                    self.stop.wait(2 ** attempt)
        raise RuntimeError('NO_FRESH_EGRESS')

    def ensureRunning(self):
        if self.stop.is_set() or (self.root / 'private/STOP').exists():
            self.stop.set()
            raise RuntimeError('COORDINATED_STOP')

    def freshProvidedProxy(self):
        # 探测不请求 Apple；只尝试提供的有限配置，失败配置持久退役。
        for attempt in range(10):
            self.ensureRunning()
            validatePlan(self.plan)
            proxy, row = self.proxyPool.claim(self.slot, getattr(self, 'avoidEgress', None))
            if proxyHash(proxy) in getattr(self, 'proxyPauses', {}):
                self.proxyPool.retire(proxy, 'EXISTING_PROXY_PAUSE')
                event(self.root, 'proxy_skipped_cooldown', slot=self.slot,
                      reason=safeCode(self.proxyPauses[proxyHash(proxy)]))
                continue
            previous = row.get('egressHash')
            if previous and previous in rejectionSet(self.root):
                self.proxyPool.retire(proxy, 'REJECTED_EGRESS')
                continue
            try:
                egress = self.probe(proxy)
            except RuntimeError as error:
                if str(error) != 'EGRESS_PROBE_FAILED':
                    raise
                self.proxyPool.retire(proxy, 'EGRESS_PROBE_FAILED')
                if previous:
                    rejectionSet(self.root, [previous])
                event(self.root, 'proxy_candidate_failed', slot=self.slot, provider='iproyal', reason=str(error))
                continue
            self.ensureRunning()
            if egress == getattr(self, 'avoidEgress', None):
                self.proxyPool.release(proxy, 'ALTERNATE_EGRESS_REQUIRED')
                event(self.root, 'same_failed_egress_skipped', slot=self.slot)
                continue
            if previous and previous != egress:
                rejectionSet(self.root, [previous, egress])
                self.proxyPool.retire(proxy, 'EGRESS_CHANGED')
                continue
            if egress in rejectionSet(self.root):
                self.proxyPool.retire(proxy, 'REJECTED_EGRESS')
                continue
            if not self.proxyPool.accept(proxy, self.slot, egress):
                event(self.root, 'duplicate_active_egress_skipped', slot=self.slot, provider='iproyal')
                continue
            event(self.root, 'proxy_lease_reused' if previous else 'proxy_selected', slot=self.slot,
                  provider='iproyal', originalLeasePreserved=True)
            return proxy, egress, row['startedAt']
        raise RuntimeError('NO_FRESH_EGRESS')

    def configure(self, proxy, egress, leaseStart):
        settings = readJson(self.root / 'private/collectorConfig.json')
        mode = settings.get('browserModeBySlot', {}).get(str(self.slot), settings.get('browserMode', 'chromium'))
        settings.update(proxyFile='active-proxy.json', captureReceipt=True,
                        browserMode=mode if threeFieldScope(self.plan) else 'headless-shell',
                        leaseContext={'proxyHash': proxyHash(proxy),
                                      'provider': proxy.get('provider', 'fanproxy'),
                                      'egressHash': egress,
                                      'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(leaseStart)) + '.000Z'})
        writeJson(self.private / 'active-proxy.json', proxy)
        writeJson(self.private / 'collectorConfig.json', settings)
        self.activeBrowserMode = settings['browserMode']

    def collect(self, entries):
        samples = []
        failures = []
        for entry in entries:
            result = call(['docker', 'exec', '-i', '-e', 'OFFICIAL_ORDER_ID=' + str(entry['id']),
                           'apple-order-mgr-prod-api-1', 'node'],
                          input=(self.root / 'release/scripts/readOfficialOrderInput.js').read_bytes(), timeout=30)
            if result.returncode:
                if threeFieldScope(self.plan):
                    try:
                        code = json.loads(result.stderr.decode())['outcome']
                    except (ValueError, KeyError):
                        code = 'INPUT_EXTRACTION_FAILED'
                    if code in ('ACCOUNT_ID_MISSING', 'ACCOUNT_REFERENCE_CONFLICT', 'ORDER_ACCOUNT_AMBIGUOUS',
                                'ACCOUNT_MARKED_INVALID', 'ORDER_CREDENTIALS_MISSING', 'CREDENTIAL_DECRYPT_FAILED',
                                'CREDENTIAL_SNAPSHOT_MISMATCH', 'INPUT_INVALID', 'LINK_IDENTITY_MISMATCH',
                                'DESTINATION_DENIED', 'ORDER_NOT_FOUND'):
                        failures.append({'orderId': entry['id'], 'outcome': code, 'attempted': False})
                        continue
                raise RuntimeError('INPUT_EXTRACTION_FAILED')
            sample = json.loads(result.stdout)['samples'][0]
            if (sample['id'] != entry['id'] or sample['orderNumber'] != entry['orderNumber'] or
                    hashlib.md5(sample['email'].strip().lower().encode()).hexdigest() != entry['accountKey']):
                raise RuntimeError('INPUT_IDENTITY_INVALID')
            samples.append(sample)
        if not samples:
            return {'outcome': 'INPUT_INVALID', 'results': failures}
        orderId = entries[0]['id']
        writeJson(self.private / ('request-' + str(orderId) + '.json'), {'samples': samples, 'failures': failures})
        env = dict(os.environ, OFFICIAL_ORDER_ROOT=str(self.work), OFFICIAL_BACKFILL_SLOT=str(self.slot),
                   OFFICIAL_BACKFILL_SKIP_API_HEALTH='1' if fullScope(self.plan) else '0')
        watchStarted = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())
        result = call(['bash', str(self.root / 'release/scripts/runOfficialOrderServer.sh'), str(orderId), 'backfill'],
                      env=env, timeout=240)
        summaries = []
        for line in result.stdout.decode(errors='replace').splitlines():
            try:
                item = json.loads(line)
                if 'outcome' in item:
                    summaries.append(item)
            except ValueError:
                pass
        if not summaries:
            # 资源守护可能终止浏览器；保留实际原因，不误分类为代理故障。
            for row in reversed(records(self.root / 'evidence/resources.jsonl')):
                if row.get('time', '') < watchStarted:
                    break
                if row.get('container', {}).get('Name') == 'apple-pickup-collector-v6-' + str(self.slot):
                    if row.get('stopReason'):
                        raise RuntimeError(row['stopReason'])
                    break
            raise RuntimeError('COLLECTOR_OUTPUT_MISSING')
        return summaries[-1]

    def applyResult(self, resultFile):
        if not re.fullmatch(r'/research/private/results/order-\d+-run-\d+\.json', resultFile):
            raise RuntimeError('RESULT_PATH_INVALID')
        result = call(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                       '-v', str(self.work) + ':/research:ro',
                       '-v', str(self.root / 'evidence') + ':/research/evidence:ro',
                       '-v', str(self.root / 'private/results') + ':/research/private/results:ro',
                       '-v', str(self.root / 'release/src/services') + ':/app/src/services:ro',
                       '-e', 'RESULT_FILE=' + resultFile, '--entrypoint', 'node', IMAGE, '-e', VERIFY_JS], timeout=30)
        if result.returncode:
            raise RuntimeError('SOURCE_VERIFY_FAILED')
        payload = json.loads(result.stdout)
        outcome = applyPayload(self.root, payload)
        append(self.root / 'private/applied.jsonl', outcome)
        return outcome

    def recordUnverified(self, summary, reason):
        for result in summary.get('results', []):
            if not result.get('attempted'):
                continue
            audit = {'orderId': result['orderId'], 'outcome': reason,
                     'collectorOutcome': result['outcome'], 'runId': result.get('runId')}
            append(self.root / 'private/processed.jsonl', audit)
            event(self.root, 'order_finished', **audit)

    def process(self, group):
        pending = self.eligible(group)
        rounds = 0
        while pending and rounds < 3 and not self.stop.is_set():
            validatePlan(self.plan)
            if (self.root / 'private/STOP').exists():
                self.stop.set()
                return
            proxy, egress, leaseStart = self.freshProxy()
            self.ensureRunning()
            self.configure(proxy, egress, leaseStart)
            event(self.root, 'group_started', slot=self.slot, orderIds=[e['id'] for e in pending], concurrency=MAX_WORKERS,
                  browserMode=getattr(self, 'activeBrowserMode', None))
            began = time.monotonic()
            summary = self.collect(pending)
            self.ensureRunning()
            rotated541 = False
            if threeFieldScope(self.plan) and self.proxyPool:
                for result in summary.get('results', []):
                    receipt = result.get('receipt') or {}
                    failedRun = (result.get('runId') if result.get('attempted') and result['outcome'] == 'HTTP_541'
                                 else receipt.get('runId') if receipt.get('outcome') == 'HTTP_541' else None)
                    if failedRun is not None:
                        strike = self.proxyPool.record541(proxy, 'run-' + str(failedRun))
                        event(self.root, 'proxy_541_counted', slot=self.slot, **strike)
                        if strike['retired']:
                            rejectionSet(self.root, [egress])
                        self.avoidEgress = egress
                        rotated541 = True
            # 同组详情和收据结束后核实实际出口，确认前不写任何业务字段。
            try:
                after = self.probe(proxy)
            except RuntimeError as error:
                if str(error) != 'EGRESS_PROBE_FAILED':
                    raise
                rejectionSet(self.root, [egress])
                self.recordUnverified(summary, 'EGRESS_PROBE_FAILED')
                return
            leaseSeconds = IPROYAL_LEASE_SECONDS if proxy.get('provider') == 'iproyal' else 600
            if after != egress or time.time() - leaseStart >= leaseSeconds - 30:
                rejectionSet(self.root, [egress, after])
                self.recordUnverified(summary, 'EGRESS_CHANGED_DURING_GROUP')
                return
            retry = []
            byId = {e['id']: e for e in pending}
            results = summary.get('results') or []
            if not results:
                raise RuntimeError(summary.get('outcome', 'COLLECTOR_OUTPUT_MISSING'))
            for result in results:
                entry = byId.get(result['orderId'])
                if not entry:
                    raise RuntimeError('RESULT_IDENTITY_INVALID')
                if not result.get('attempted'):
                    append(self.root / 'private/deferred.jsonl', result)
                    event(self.root, 'order_deferred', orderId=entry['id'], outcome=result['outcome'])
                    if threeFieldScope(self.plan) and (result.get('outcome') in RETRYABLE or result.get('outcome') == 'PROXY_COOLDOWN'):
                        retry.append(entry)
                    continue
                with fileLock(self.root / 'private/business-write.lock'):
                    self.ensureRunning()
                    try:
                        outcome = result['outcome']
                        applied = self.applyResult(result['resultFile']) if outcome == 'SUCCEEDED' else {'orderId': entry['id'], 'outcome': outcome}
                        audit = dict(applied, collectorOutcome=outcome, runId=result.get('runId'), slot=self.slot,
                                     passwordSubmitted=summary.get('passwordSubmitted'),
                                     elapsedMs=round((time.monotonic() - began) * 1000))
                        append(self.root / 'private/processed.jsonl', audit)
                        event(self.root, 'order_finished', **audit)
                        if outcome == 'SUCCEEDED':
                            receipt = receiptWorkflow.bindCaptured(self.root, self.work, entry['id'], result.get('receipt'), egress, call)
                            append(self.root / 'private/receipt-applied.jsonl', receipt)
                            event(self.root, 'receipt_finished', **receipt)
                            if receipt['outcome'] in ('HTTP_407', 'HTTP_429', 'HTTP_541', 'PROXY_CONNECTION_FAILED') and not (rotated541 and receipt['outcome'] == 'HTTP_541'):
                                rejectionSet(self.root, [egress])
                            if threeFieldScope(self.plan) and receipt['outcome'] in RETRYABLE:
                                retry.append(dict(entry, receiptOnly=True))
                            if receipt['outcome'] in FATAL or receipt.get('newBindings', 0) and receipt['outcome'] != 'SERIALS_VERIFIED':
                                raise RuntimeError(receipt['outcome'])
                        if outcome in FATAL:
                            raise RuntimeError(outcome)
                        if outcome in RETRYABLE:
                            retry.append(entry)
                    except Exception:
                        self.stop.set()
                        raise
            rounds += 1
            if retry:
                if not rotated541:
                    rejectionSet(self.root, [egress])
                pending = self.eligible(retry)
            else:
                pending = []


def syncSavedStatuses(root, plan):
    """消费同批成功详情的加密证据补状态；不重新登录或发官网请求。"""
    audits = records(root / 'private/applied.jsonl')
    byId = {item['orderId']: item for item in audits if item.get('runId') and
            item.get('outcome') in ('FILLED', 'ALREADY_HAS_DATE')}
    saved = {item['orderId'] for item in audits if item.get('statusSaved')}
    candidates = [entry for entry in plan['entries'] if entry['id'] in byId and entry['id'] not in saved]
    if not candidates:
        return
    worker = Worker(root, 1, plan, threading.Event())
    for entry in candidates:
        validatePlan(plan)
        runId = byId[entry['id']]['runId']
        resultFile = '/research/private/results/order-' + str(entry['id']) + '-run-' + str(runId) + '.json'
        outcome = worker.applyResult(resultFile)
        event(root, 'saved_status_finished', orderId=entry['id'], statusSaved=outcome.get('statusSaved', False))


def run(root, workers=MAX_WORKERS):
    if workers not in (1, 2, 3) or MAX_BATCH_CHANNELS + OTHER_PROXY_CHANNELS > PROXY_CHANNEL_CAPACITY:
        raise RuntimeError('CONCURRENCY_INVALID')
    stop = threading.Event()
    with fileLock(root / 'private/executor-v6.lock', blocking=False), fileLock(root / 'private/collector.lock', blocking=False):
        if (root / 'private/STOP').exists():
            raise RuntimeError('COORDINATED_STOP')
        plan = preparePlan(root)
        syncSavedStatuses(root, plan)
        groups = chooseGroups(plan, records(root / 'private/processed.jsonl'),
                              records(root / 'private/applied.jsonl'), records(root / 'private/receipt-applied.jsonl'))
        workQueue = queue.Queue()
        for group in groups:
            workQueue.put(group)
        provider = providerFor(root)
        event(root, 'started', policy='missing-fields-v3' if missingScope(plan) else 'picked-up-refresh-v2' if fullScope(plan) else 'bounded-account-v6',
              scope=plan.get('scope', 'original-310'), total=len(plan['entries']),
              apiHealthCheck=not fullScope(plan), loginCooldown=not fullScope(plan),
              groups=len(groups), workers=workers,
              provider=provider, browserConnectionLimit=workers * CONNECTIONS_PER_WORKER,
              stickyChannelLimit=MAX_BATCH_CHANNELS if provider == 'fanproxy' else workers,
              appleSessionMinutes=105)
        failures = []

        def consume(slot):
            try:
                worker = Worker(root, slot, plan, stop)
                while not stop.is_set():
                    try:
                        group = workQueue.get_nowait()
                    except queue.Empty:
                        return
                    worker.process(group)
            except Exception as error:
                stop.set()
                failures.append(safeCode(error))
                event(root, 'worker_stopped', slot=slot, reason=safeCode(error))

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(consume, slot) for slot in range(1, workers + 1)]
            for future in futures:
                future.result()
        event(root, 'stopped' if stop.is_set() else 'pass_finished',
              reason=failures[0] if failures else 'COORDINATED_STOP' if stop.is_set() else 'EXECUTABLE_PASS_FINISHED',
              unstartedGroups=workQueue.qsize())
        if failures:
            raise RuntimeError(failures[0])


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=DEFAULT_ROOT)
    parser.add_argument('--workers', type=int, default=MAX_WORKERS, choices=(1, 2, 3))
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--sync-saved-status', action='store_true')
    args = parser.parse_args()
    try:
        taskRoot = pathlib.Path(args.root).resolve()
        if args.prepare_only:
            preparePlan(taskRoot)
        elif args.sync_saved_status:
            with fileLock(taskRoot / 'private/executor-v6.lock', blocking=False), fileLock(taskRoot / 'private/collector.lock', blocking=False):
                syncSavedStatuses(taskRoot, preparePlan(taskRoot))
        else:
            run(taskRoot, args.workers)
    except Exception as error:
        print(json.dumps({'outcome': safeCode(error)}), flush=True)
        raise SystemExit(1)
