#!/usr/bin/env python3
"""官网电子收据批调度器：私密持久化、有限重试、独立验签和事务回读。"""
import argparse
import concurrent.futures
import contextlib
import datetime
import fcntl
import hashlib
import ipaddress
import io
import json
import os
from pathlib import Path
import re
import shutil
import secrets
import string
import stat
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import quote, urlsplit

IMAGE = 'mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
TERMINAL = {'succeeded', 'review', 'failed', 'stopped'}
DEFERRED = {'ACCOUNT_BUSY', 'ACCOUNT_COOLDOWN', 'LOGIN_COOLDOWN', 'PROXY_COOLDOWN'}
UNKNOWN_WRITE = {'BUSINESS_RESULT_UNKNOWN', 'RUNTIME_OUTPUT_INVALID', 'RUNTIME_COMMAND_FAILED', 'RUNTIME_COMMAND_TIMEOUT', 'STOCK_CONNECTION_LOST', 'STOCK_BUSY', 'RECEIPT_HOST_FAILED'}
RETRYABLE = {'HTTP_541', 'HTTP_429', 'HTTP_407', 'HTTP_AUTH_FAILED', 'PROXY_CONNECTION_FAILED',
             'TIME_BUDGET', 'COLLECTOR_ERROR', 'RECEIPT_TIMEOUT', 'RECEIPT_SESSION_REDIRECT',
             'RECEIPT_VISIBLE_LINK_MISMATCH', 'COLLECTOR_INTERRUPTED', 'RUNTIME_COMMAND_FAILED',
             'HTTP_TIMEOUT', 'HTTP_CONNECTION_FAILED', 'EGRESS_PROBE_FAILED', 'EGRESS_CHANGED', 'PROXY_LEASE_EXPIRED', 'EGRESS_PREVIOUSLY_REJECTED'}


def fail(code):
    raise RuntimeError(code)


def readPrivate(file):
    """拒绝符号链接、非私密文件及超大输入。"""
    descriptor = os.open(str(file), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 8388608:
            fail('PRIVATE_FILE_INVALID')
        return json.loads(handle.read().decode('utf-8'))


def atomic(file, value):
    """内容和目录均 fsync；掉电后旧版本或完整新版本，禁止半份状态。"""
    file = Path(file)
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = file.with_name('.' + file.name + '-' + uuid.uuid4().hex)
    try:
        with os.fdopen(os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=True, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        if os.geteuid() == 0:
            os.chown(str(temporary), 1000, 1000)
        os.replace(str(temporary), str(file))
        descriptor = os.open(str(file.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def command(args, inputValue=None, timeout=40, structuredError=False):
    try:
        result = subprocess.run(args, input=inputValue, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode and structuredError:
            value = jsonOutput(result.stdout)
            if re.fullmatch('[A-Z_0-9]+', value.get('outcome', '')):
                fail(value['outcome'])
        if result.returncode:
            # 调用方决定未知提交如何只读对账；异常不得携带凭据或 URL。
            fail('RUNTIME_COMMAND_FAILED')
        return result.stdout
    except subprocess.TimeoutExpired:
        fail('RUNTIME_COMMAND_TIMEOUT')


def jsonOutput(raw):
    try:
        return json.loads(raw.decode('utf-8').strip().splitlines()[-1])
    except (ValueError, IndexError):
        fail('RUNTIME_OUTPUT_INVALID')


def codeOf(error):
    value = str(error)
    return value if re.fullmatch('[A-Z_0-9]+', value) else 'RECEIPT_HOST_FAILED'


def failureCode(result, error):
    """认证需人工时，后续探测故障不能把它降级为自动重试。"""
    if result and result.get('outcome') in {'AUTH_REJECTED', 'AUTH_PRECONDITION_REQUIRED', 'HUMAN_VERIFICATION_REQUIRED'}:
        return result['outcome']
    return codeOf(error)


def epoch(value):
    return datetime.datetime.strptime(value[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp()


def nowIso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def freshProxy(file):
    """通过 IPRoyal 官方路由参数分配新的 8 位粘性会话；不修改账户认证基础值。"""
    proxy = readPrivate(file)
    if proxy.get('provider') != 'iproyal' or proxy.get('host') != 'geo.iproyal.com' or proxy.get('port') != 12321 or proxy.get('preemptiveAuth') is not True:
        fail('IPROYAL_TEMPLATE_INVALID')
    password = proxy.get('password', '')
    if len(re.findall(r'_session-[A-Za-z0-9]{8}(?=_|$)', password)) != 1 or '_country-cn' not in password or not re.search(r'_lifetime-24h(?=_|$)', password):
        fail('IPROYAL_TEMPLATE_INVALID')
    session = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
    proxy['password'] = re.sub(r'_session-[A-Za-z0-9]{8}(?=_|$)', '_session-' + session, password)
    return proxy, {'createdAt': nowIso()}


def loadConfig(file):
    config = readPrivate(file)
    for key in ('releaseDir', 'depsDir', 'runtimeDir', 'dataRoot', 'gateConfig', 'evidenceKey', 'probeLog'):
        if not Path(config.get(key, '')).is_absolute():
            fail('CONFIG_PATH_INVALID')
    if config.get('image') != IMAGE or not re.fullmatch('[a-zA-Z0-9_.-]+', config.get('apiContainer', '')):
        fail('CONFIG_RUNTIME_INVALID')
    if config.get('internalNetwork') != 'apple-account-research-internal' or config.get('egressNetwork') != 'apple-account-research-egress':
        fail('CONFIG_GATE_NETWORK_INVALID')
    if type(config.get('actorUserId')) is not int or config['actorUserId'] < 1 or type(config.get('totalRequestLimit')) is not int or config['totalRequestLimit'] < 1:
        fail('CONFIG_BUDGET_INVALID')
    if type(config.get('concurrency', 2)) is not int or not 1 <= config.get('concurrency', 2) <= 5:
        fail('CONFIG_CONCURRENCY_INVALID')
    if config.get('iproyalTemplate'):
        if not Path(config['iproyalTemplate']).is_absolute():
            fail('CONFIG_PROXY_INVALID')
        freshProxy(config['iproyalTemplate'])
    elif not config.get('proxies') or any(not Path(item.get('file', '')).is_absolute() or not item.get('createdAt') for item in config['proxies']):
        fail('CONFIG_PROXY_INVALID')
    url = urlsplit(config.get('probeUrl', ''))
    if url.scheme != 'https' or url.username or url.password or url.query or url.fragment or url.hostname != 'apple.godp.me' or url.path != '/api/health/ready':
        fail('CONFIG_PROBE_INVALID')
    manifest = json.loads((Path(config['releaseDir']) / 'receiptRelease.json').read_text(encoding='utf-8'))
    for name, expected in manifest['files'].items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts:
            fail('RELEASE_PATH_INVALID')
        source = Path(config['releaseDir']) / path
        if source.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            fail('RELEASE_HASH_INVALID')
    config['releaseDigest'] = digest(manifest)
    config['apiReleaseDir'] = '/tmp/official-receipt-' + config['releaseDigest']
    return config


class Adapter:
    """宿主权限边界：网络采集器不持有业务写凭据，应用容器只接收验证后的契约。"""
    def __init__(self, config):
        self.config = config

    def install(self):
        c = self.config
        command(['docker', 'exec', c['apiContainer'], 'mkdir', '-p', c['apiReleaseDir']])
        import base64
        release = Path(c['releaseDir'])
        manifest = json.loads((release / 'receiptRelease.json').read_text(encoding='utf-8'))
        files = {name: base64.b64encode((release / name).read_bytes()).decode() for name in list(manifest['files']) + ['receiptRelease.json']}
        script = "const fs=require('fs'),p=require('path'),h=require('crypto');const root=process.argv[1];const files=JSON.parse(fs.readFileSync(0,'utf8'));for(const [n,b]of Object.entries(files)){if(p.isAbsolute(n)||n.split('/').includes('..'))throw Error('PATH');const f=p.join(root,n),v=Buffer.from(b,'base64');fs.mkdirSync(p.dirname(f),{recursive:true});if(fs.existsSync(f)){if(!fs.readFileSync(f).equals(v))throw Error('RELEASE_CHANGED');}else fs.writeFileSync(f,v,{flag:'wx',mode:384});}"
        command(['docker', 'exec', '-i', c['apiContainer'], 'node', '-e', script, c['apiReleaseDir']], inputValue=json.dumps(files).encode())

    def business(self, mode, payload):
        c = self.config
        args = ['docker', 'exec', '-i', '-e', 'NODE_PATH=/app/node_modules', c['apiContainer'], 'node', c['apiReleaseDir'] + '/scripts/officialReceiptBusiness.js', mode, '/app']
        # 已知业务拒绝也返回结构化码；超时/连接断开保留为未知结果。
        try:
            result = subprocess.run(args, input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
            value = jsonOutput(result.stdout)
        except subprocess.TimeoutExpired:
            fail('BUSINESS_RESULT_UNKNOWN')
        if value.get('success') is not True:
            fail(value.get('code', 'BUSINESS_RESULT_UNKNOWN'))
        return value['data']

    def container(self, root, script, arguments, network, timeout=40):
        c = self.config
        name = 'receipt-check-' + uuid.uuid4().hex
        try:
            return jsonOutput(command(['docker', 'run', '--rm', '--name', name, '--network', network, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64', '-e', 'NODE_PATH=/research/node_modules', '-v', str(root) + ':/research:rw', '-v', c['releaseDir'] + ':/research/release:ro', '-v', c['depsDir'] + ':/research/node_modules:ro', '--entrypoint', 'node', c['image'], '/research/release/scripts/' + script] + arguments, timeout=timeout, structuredError=True))
        finally:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)

    def gate(self, mode, root, batchId='', requestKey=''):
        return self.container(root, 'officialReceiptGate.js', [mode, '/research', batchId, requestKey], 'none' if mode == 'verify' else self.config['internalNetwork'])

    def probe(self, proxy):
        c = self.config
        token = 'receipt-batch-' + uuid.uuid4().hex
        auth = quote(proxy['username'], safe='') + ':' + quote(proxy['password'], safe='')
        if not re.fullmatch('[a-zA-Z0-9.-]+', proxy['host']) or type(proxy['port']) is not int:
            fail('PROXY_INVALID')
        curl = 'proxy = "http://' + auth + '@' + proxy['host'] + ':' + str(proxy['port']) + '"\nurl = "' + c['probeUrl'] + '?' + token + '"\n'
        result = command(['curl', '-fsS', '--noproxy', '', '--max-time', '20', '--config', '-'], inputValue=curl.encode(), timeout=25)
        if json.loads(result).get('success') is not True:
            fail('EGRESS_PROBE_FAILED')
        with open(c['probeLog'], 'rb') as handle:
            handle.seek(0, 2)
            handle.seek(max(0, handle.tell() - 262144))
            lines = [line for line in handle.read().decode(errors='replace').splitlines() if token in line]
        if len(lines) != 1:
            fail('EGRESS_PROBE_FAILED')
        address = ipaddress.ip_address(lines[0].split()[0])
        if not address.is_global:
            fail('EGRESS_PROBE_FAILED')
        return hashlib.sha256(str(address).encode()).hexdigest()

    def collect(self, root, name):
        c = self.config
        command(['docker', 'create', '--name', name, '--network', c['internalNetwork'], '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1536m', '--cpus', '1.5', '--pids-limit', '256', '--shm-size', '256m', '--tmpfs', '/tmp:rw,nosuid,size=384m', '-e', 'HOME=/tmp', '-e', 'NODE_PATH=/research/node_modules', '-v', str(root) + ':/research:rw', '-v', c['releaseDir'] + ':/research/release:ro', '-v', c['depsDir'] + ':/research/node_modules:ro', '-v', c['runtimeDir'] + ':/runtime:ro', '--entrypoint', 'node', c['image'], '/research/release/scripts/collectOfficialReceipt.js', '/research'])
        command(['docker', 'network', 'connect', c['egressNetwork'], name])
        return jsonOutput(command(['docker', 'start', '-a', name], timeout=240))

    def cleanup(self, name):
        result = subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        if result.returncode == 0:
            return True
        # 不存在仅在 daemon 明确列出容器后确认，不能把 Docker 故障当作已清理。
        names = command(['docker', 'ps', '-a', '--format', '{{.Names}}']).decode().splitlines()
        return name not in names


def prepareRoot(root, config, inputData, proxy):
    for name in ('private', 'evidence', 'release', 'node_modules'):
        (root / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    for name, source in [('db.json', config['gateConfig']), ('evidence.key', config['evidenceKey'])]:
        shutil.copyfile(source, str(root / 'private' / name))
        os.chmod(str(root / 'private' / name), 0o600)
    atomic(root / 'private/input.json', inputData)
    atomic(root / 'private/proxy.json', proxy)
    atomic(root / 'private/settings.json', {'orderId': inputData['samples'][0]['id'], 'totalRequestLimit': config['totalRequestLimit'], 'runRequestLimit': 200})
    if os.geteuid() == 0:
        for path in [root] + list(root.rglob('*')):
            os.chown(str(path), 1000, 1000)


class Batch:
    """单 leader 调度；线程只领取冻结订单，状态更新受锁保护。"""
    def __init__(self, directory, config, adapter=None):
        self.directory = Path(directory)
        self.config = config
        self.adapter = adapter or Adapter(config)
        self.lock = threading.RLock()
        self.state = readPrivate(self.directory / 'state.json')
        if self.state['configDigest'] != digest(config):
            fail('BATCH_CONFIG_CHANGED')

    def save(self):
        self.state['updatedAt'] = nowIso()
        atomic(self.directory / 'state.json', self.state)

    def update(self, job, **values):
        with self.lock:
            job.update(values)
            self.save()

    def stopped(self):
        return (self.directory / 'STOP').exists()

    def reconcile(self, job, root):
        payload = readPrivate(root / 'private/binding.json')
        if payload.get('orderId') != job['orderId'] or payload.get('batchId') != self.state['batchId'] or payload.get('requestKey') != job['attempts'][-1]['id']:
            fail('RECEIPT_RECOVERY_IDENTITY_CONFLICT')
        self.update(job, state='applying')
        result = self.adapter.business('reconcile', payload)
        if result['outcome'] == 'RECEIPT_NOT_APPLIED':
            if self.stopped():
                self.update(job, state='stopped', code='REQUEST_STOPPED')
                return
            # 只读对账取得相同事务锁，已证明之前没有提交，才允许重放同一个幂等键。
            try:
                self.adapter.business('apply', payload)
            except Exception:
                result = self.adapter.business('reconcile', payload)
                if result['outcome'] != 'RECEIPT_READBACK_VERIFIED':
                    raise
            result = self.adapter.business('reconcile', payload)
        if result['outcome'] != 'RECEIPT_READBACK_VERIFIED':
            fail('RECEIPT_READBACK_CONFLICT')
        atomic(root / 'private/readback.json', result)
        self.update(job, state='succeeded', code='RECEIPT_READBACK_VERIFIED', serialCount=result['serialCount'], newBindings=result['newBindings'], runId=result['receiptRunId'])

    def recover(self):
        for job in self.state['jobs']:
            if job['state'] in ('applying', 'verified'):
                try:
                    self.reconcile(job, self.directory / 'attempts' / job['attempts'][-1]['id'])
                except Exception as error:
                    # 不确定写入不重新登录、不创建新幂等键。
                    self.update(job, state='review', code=codeOf(error), recoveryRequired=codeOf(error) in UNKNOWN_WRITE)
            elif job['state'] == 'running':
                attempt = job['attempts'][-1]
                if not self.adapter.cleanup(attempt['container']):
                    fail('COLLECTOR_CLEANUP_FAILED')
                root = self.directory / 'attempts' / attempt['id']
                if (root / 'private/binding.json').exists():
                    self.reconcile(job, root)
                else:
                    self.update(job, state='retry_wait' if consumedAttempts(job) < 3 else 'failed', code='COLLECTOR_INTERRUPTED', retryAt=time.time() + 900)

    def execute(self, job):
        attempt = None
        root = None
        result = None
        try:
            inputData = self.adapter.business('input', {'orderId': job['orderId'], 'actorUserId': self.config['actorUserId']})
            sample = inputData['samples'][0]
            if digest([sample['id'], sample['orderNumber'], sample['accountHash']]) != job['identity']:
                fail('BATCH_IDENTITY_CHANGED')
            if self.config.get('iproyalTemplate'):
                proxy, spec = freshProxy(self.config['iproyalTemplate'])
            else:
                eligible = [item for item in self.config['proxies'] if 0 <= time.time() - epoch(item['createdAt']) < 86190]
                if not eligible:
                    fail('PROXY_POOL_EXPIRED')
                spec = eligible[(job['position'] + len(job['attempts'])) % len(eligible)]
                proxy = readPrivate(spec['file'])
            # 预检不算采集尝试，固定目录避免冷却期间制造大量失败样本。
            root = self.directory / 'preflight' / str(job['orderId'])
            prepareRoot(root, self.config, inputData, proxy)
            gate = self.adapter.gate('preflight', root)
            if gate['outcome'] == 'RECEIPT_DEFERRED':
                self.update(job, state='retry_wait', code='RECEIPT_DEFERRED', retryAt=epoch(gate['retryAt']) + 1)
                return
            if gate['outcome'] != 'RECEIPT_READY':
                fail(gate['outcome'])
            if self.stopped():
                self.update(job, state='stopped', code='REQUEST_STOPPED')
                return
            attemptId = str(uuid.uuid4())
            attempt = {'id': attemptId, 'container': 'receipt-attempt-' + attemptId, 'startedAt': nowIso(), 'proxyHash': digest([proxy['host'], proxy['port'], proxy['username'], proxy['password']])}
            root = self.directory / 'attempts' / attemptId
            prepareRoot(root, self.config, inputData, proxy)
            with self.lock:
                job['attempts'].append(attempt)
                self.update(job, state='running', code='COLLECTING')
            before = self.adapter.probe(proxy)
            if before in job.get('blockedEgress', []):
                fail('EGRESS_PREVIOUSLY_REJECTED')
            settings = readPrivate(root / 'private/settings.json')
            settings['leaseContext'] = {'provider': proxy['provider'], 'proxyHash': hashlib.sha256(json.dumps([proxy['host'], proxy['port'], proxy['username'], proxy['password']], separators=(',', ':')).encode()).hexdigest(), 'egressHash': before, 'startedAt': spec['createdAt']}
            atomic(root / 'private/settings.json', settings)
            result = self.adapter.collect(root, attempt['container'])
            cleanup = self.adapter.cleanup(attempt['container'])
            after = self.adapter.probe(proxy)
            audit = {'orderId': job['orderId'], 'attemptId': attemptId, 'egressBefore': before, 'egressAfter': after, 'cleanupConfirmed': cleanup}
            atomic(root / 'private/audit.json', audit)
            with self.lock:
                attempt.update(outcome=result['outcome'], runId=result.get('runId'), requests=result.get('requests'), finishedAt=nowIso())
                if result['outcome'] in DEFERRED and not result.get('runId'):
                    attempt['deferred'] = True
                if result['outcome'] == 'HTTP_541':
                    job.setdefault('blockedEgress', []).append(before)
                self.save()
            if not cleanup:
                fail('COLLECTOR_CLEANUP_FAILED')
            if result['outcome'] != 'SUCCEEDED':
                fail(result['outcome'])
            if before != after:
                fail('EGRESS_CHANGED')
            self.adapter.gate('snapshot', root)
            proof = self.adapter.gate('verify', root, self.state['batchId'], attemptId)
            if proof['outcome'] != 'RECEIPT_PROOF_VERIFIED':
                fail(proof['outcome'])
            # binding.json 由验证器写入；再次原子 fsync 后才记录允许写入的意图。
            atomic(root / 'private/binding.json', readPrivate(root / 'private/binding.json'))
            self.update(job, state='verified', code='RECEIPT_PROOF_VERIFIED')
            self.reconcile(job, root)
        except Exception as error:
            if result is None and root is not None and (root / 'private/result.json').exists():
                try:
                    saved = readPrivate(root / 'private/result.json')
                    if saved.get('systemOrderId') == job['orderId']:
                        result = saved
                except Exception:
                    pass
            code = failureCode(result, error)
            if attempt:
                with self.lock:
                    attempt['hostOutcome'] = code
                    self.save()
                try:
                    if not self.adapter.cleanup(attempt['container']):
                        code = 'COLLECTOR_CLEANUP_FAILED'
                except Exception:
                    code = 'COLLECTOR_CLEANUP_FAILED'
            if job['state'] == 'applying':
                self.update(job, state='review', code=code, recoveryRequired=code in UNKNOWN_WRITE)
            elif self.stopped():
                self.update(job, state='stopped', code=code)
            elif (code in RETRYABLE or code in DEFERRED) and consumedAttempts(job) < 3:
                self.update(job, state='retry_wait', code=code, retryAt=time.time() + 30)
            else:
                self.update(job, state='review', code=code)

    def run(self, waitSeconds):
        deadline = time.time() + waitSeconds
        self.recover()
        active = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.config.get('concurrency', 2)) as executor:
            while True:
                if self.stopped():
                    for job in self.state['jobs']:
                        if job['state'] == 'running' and job['attempts']:
                            atomic(self.directory / 'attempts' / job['attempts'][-1]['id'] / 'private/STOP', True)
                        elif job['state'] not in TERMINAL and job['state'] not in ('verified', 'applying'):
                            self.update(job, state='stopped', code='REQUEST_STOPPED')
                for future in list(active):
                    if future.done():
                        future.result()
                        del active[future]
                if not self.stopped() and time.time() <= deadline:
                    running = set(active.values())
                    accounts = {item.get('accountHash') or item['orderId'] for item in self.state['jobs'] if item['orderId'] in running}
                    for job in self.state['jobs']:
                        if len(active) >= self.config.get('concurrency', 2):
                            break
                        account = job.get('accountHash') or job['orderId']
                        if job['orderId'] not in running and account not in accounts and job['state'] in ('queued', 'retry_wait') and job.get('retryAt', 0) <= time.time():
                            active[executor.submit(self.execute, job)] = job['orderId']
                            accounts.add(account)
                if not active and (time.time() >= deadline or self.stopped() or all(job['state'] in TERMINAL for job in self.state['jobs'])):
                    break
                # 调度器事件轮询，不是逐订单固定等待；并发槽随完成即时补位。
                time.sleep(0.2)
        return summary(self.state)


def consumedAttempts(job):
    return sum(not item.get('deferred', False) for item in job['attempts'])


def summary(state):
    counts = {}
    for job in state['jobs']:
        counts[job['state']] = counts.get(job['state'], 0) + 1
    return {'batchId': state['batchId'], 'total': len(state['jobs']), 'states': counts,
            'jobs': [{key: job[key] for key in ('orderId', 'state', 'code', 'runId', 'serialCount', 'newBindings', 'recoveryRequired') if key in job} for job in state['jobs']]}


@contextlib.contextmanager
def leader(directory):
    descriptor = os.open(str(Path(directory) / 'leader.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('BATCH_ALREADY_RUNNING')
        yield
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['plan', 'run', 'resume', 'status', 'stop', 'export'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--batch')
    parser.add_argument('--orders', help='明确的系统订单 ID，用逗号分隔')
    parser.add_argument('--wait-seconds', type=int, default=3600)
    args = parser.parse_args()
    config = loadConfig(args.config)
    adapter = Adapter(config)
    if args.mode == 'plan':
        if not args.orders or not re.fullmatch('[0-9]+(,[0-9]+)*', args.orders):
            fail('BATCH_ORDERS_INVALID')
        ids = list(map(int, args.orders.split(',')))
        if len(set(ids)) != len(ids) or min(ids) < 1 or len(ids) > 10000:
            fail('BATCH_ORDERS_INVALID')
        adapter.install()
        batchId = str(uuid.uuid4())
        directory = Path(config['dataRoot']) / batchId
        directory.mkdir(mode=0o700, parents=True)
        planned = adapter.business('plan', {'orderIds': ids, 'actorUserId': config['actorUserId']})
        if [item.get('orderId') for item in planned] != ids:
            fail('BATCH_PLAN_IDENTITY_INVALID')
        jobs = []
        for position, item in enumerate(planned):
            ready = item['outcome'] == 'RECEIPT_READY'
            jobs.append({'orderId': item['orderId'], 'position': position, 'state': 'queued' if ready else 'review',
                         'code': 'QUEUED' if ready else item['outcome'], 'identity': item.get('identity'), 'accountHash': item.get('accountHash'), 'attempts': []})
        state = {'version': 1, 'batchId': batchId, 'createdAt': nowIso(), 'configDigest': digest(config), 'releaseDigest': config['releaseDigest'], 'jobs': jobs}
        atomic(directory / 'state.json', state)
        return summary(state)
    if not args.batch or str(uuid.UUID(args.batch)) != args.batch:
        fail('BATCH_ID_INVALID')
    directory = Path(config['dataRoot']) / args.batch
    batch = Batch(directory, config, adapter)
    if args.mode == 'status':
        return summary(batch.state)
    if args.mode == 'stop':
        atomic(directory / 'STOP', True)
        return {'batchId': args.batch, 'outcome': 'STOP_REQUESTED'}
    if args.mode == 'export':
        output = summary(batch.state)
        for job in output['jobs']:
            original = next(item for item in batch.state['jobs'] if item['orderId'] == job['orderId'])
            if job['state'] == 'succeeded':
                payload = readPrivate(directory / 'attempts' / original['attempts'][-1]['id'] / 'private/binding.json')
                job.update(orderNumber=payload['orderNumber'], items=payload['items'], receipt=payload['receipt'])
        atomic(directory / 'export.json', output)
        return {'batchId': args.batch, 'file': str(directory / 'export.json'), 'total': len(output['jobs'])}
    with leader(directory):
        adapter.install()
        if args.mode == 'resume':
            if (directory / 'STOP').exists():
                (directory / 'STOP').unlink()
            for job in batch.state['jobs']:
                if job.get('recoveryRequired'):
                    job['state'] = 'applying'
                elif job['state'] == 'stopped':
                    if job['attempts'] and (directory / 'attempts' / job['attempts'][-1]['id'] / 'private/binding.json').exists():
                        job['state'] = 'verified'
                    elif consumedAttempts(job) < 3:
                        job['state'] = 'queued'
            batch.save()
        return batch.run(max(0, min(args.wait_seconds, 43200)))


if __name__ == '__main__':
    # Python 3.6 的 C locale 默认 ASCII；帮助和诊断统一使用 UTF-8。
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)
    try:
        print(json.dumps(main(), ensure_ascii=True))
    except Exception as error:
        print(json.dumps({'outcome': codeOf(error)}))
        sys.exit(1)
