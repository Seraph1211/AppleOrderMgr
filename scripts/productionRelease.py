#!/usr/bin/env python3
"""AppleOrderMgr 生产发布统一执行器；兼容 Python 3.6，仅使用标准库。"""
import argparse
import concurrent.futures
import datetime
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path


SCHEMA_VERSION = 1
FRONTEND_POINTER_MODES = ('switch', 'unchanged')
UNCHANGED_POINTER_MUTATION_COMPONENTS = frozenset((
    'maintenanceStop', 'queueService', 'queueWriter',
))
METRIC_FIELDS = (
    'bytesRead', 'bytesWritten', 'filesScanned', 'filesHashed', 'filesReused',
    'retryCount', 'diskFreeBytes', 'apiLatencyMs', 'lockWaitMs',
    'parallelDegraded',
)


class ReleaseError(Exception):
    """发布固定错误码。"""

    def __init__(self, code, step=None):
        super().__init__(code)
        self.code = code
        self.step = step


def require(condition, code):
    """条件不满足时失败关闭。"""
    if not condition:
        raise ReleaseError(code)


def utcNow():
    """返回带毫秒的 UTC 时间。"""
    return datetime.datetime.utcnow().isoformat(timespec='milliseconds') + 'Z'


def canonicalBytes(payload):
    """生成稳定 JSON 字节。"""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def sha256Bytes(payload):
    """返回字节 SHA-256。"""
    return hashlib.sha256(payload).hexdigest()


def sha256File(path):
    """完整读取证据文件摘要。"""
    digest = hashlib.sha256()
    size = 0
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def writeJsonAtomic(path, payload):
    """以 0600 原子写状态或摘要。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-',
                                              dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class EventRecorder(object):
    """线程安全的逐步骤计时证据记录器。"""

    def __init__(self, path, releaseId, attemptId, sourceDigest, baselineDigest=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.releaseId = releaseId
        self.attemptId = attemptId
        self.sourceDigest = sourceDigest
        self.baselineDigest = baselineDigest
        self.lock = threading.Lock()
        if not self.path.exists():
            descriptor = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                 0o600)
            os.close(descriptor)

    def record(self, stage, step, startedAt, finishedAt, durationMs, status,
               waitReason=None, evidenceRef=None, metrics=None, errorCode=None):
        """追加一行完整、可比较的 JSONL 计时证据。"""
        event = {
            'releaseId': self.releaseId,
            'attemptId': self.attemptId,
            'stage': stage,
            'step': step,
            'startedAt': startedAt,
            'finishedAt': finishedAt,
            'durationMs': max(0, int(durationMs)),
            'status': status,
            'waitReason': waitReason,
            'sourceDigest': self.sourceDigest,
            'baselineDigest': self.baselineDigest,
            'evidenceRef': evidenceRef,
            'errorCode': errorCode,
        }
        metrics = metrics or {}
        for field in METRIC_FIELDS:
            event[field] = int(metrics.get(field, 0) or 0)
        payload = json.dumps(event, ensure_ascii=False, sort_keys=True) + '\n'
        with self.lock:
            with self.path.open('a', encoding='utf-8') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        return event


class StepTimer(object):
    """用 UTC 边界和单调时钟记录一个步骤。"""

    def __init__(self, recorder, step):
        self.recorder = recorder
        self.step = step
        self.startedAt = None
        self.startedMonotonic = None

    def __enter__(self):
        self.startedAt = utcNow()
        self.startedMonotonic = time.monotonic()
        return self

    def finish(self, status, evidenceRef=None, metrics=None, errorCode=None,
               waitReason=None):
        """结束步骤并写入计时事件。"""
        duration = (time.monotonic() - self.startedMonotonic) * 1000
        return self.recorder.record(
            self.step['stage'], self.step['id'], self.startedAt, utcNow(), duration,
            status, waitReason, evidenceRef, metrics, errorCode)

    def __exit__(self, _errorType, _error, _traceback):
        return False


def validateArgv(value):
    """命令必须是非空 argv 数组，禁止 shell 字符串。"""
    require(isinstance(value, list) and value
            and all(isinstance(item, str) and item for item in value),
            'PLAN_COMMAND_INVALID')
    return value


def validatePlan(plan):
    """验证执行计划顺序、锁、回退与前端门禁契约。"""
    require(plan.get('schemaVersion') == SCHEMA_VERSION, 'PLAN_SCHEMA')
    for field in ('releaseId', 'attemptId', 'evidenceDir', 'lockPath', 'sourceDigest',
                  'baselineDigest', 'baselineEvidence'):
        require(isinstance(plan.get(field), str) and plan[field], 'PLAN_INVALID')
    require(len(plan['sourceDigest']) == 64
            and all(char in '0123456789abcdef' for char in plan['sourceDigest']),
            'PLAN_SOURCE_DIGEST')
    require(len(plan['baselineDigest']) == 64
            and all(char in '0123456789abcdef' for char in plan['baselineDigest']),
            'PLAN_BASELINE_DIGEST')
    frontend = plan.get('frontend')
    require(isinstance(frontend, dict), 'PLAN_FRONTEND_REQUIRED')
    frontendPointerMode = plan.get('frontendPointerMode', 'switch')
    require(frontendPointerMode in FRONTEND_POINTER_MODES,
            'PLAN_FRONTEND_POINTER_MODE')
    for field in ('gateScript', 'candidate', 'current', 'expectedCurrent',
                  'nginxUser', 'baseUrl'):
        require(isinstance(frontend.get(field), str) and frontend[field],
                'PLAN_FRONTEND_INVALID')
    require(frontend['nginxUser'] != 'root' and frontend['nginxUser'] != '0:0',
            'PLAN_NGINX_IDENTITY')
    nginxUsers = frontend.get('nginxUsers')
    require(isinstance(nginxUsers, list) and frontend['nginxUser'] in nginxUsers
            and all(isinstance(value, str) and value
                    and value not in ('root', '0:0') for value in nginxUsers),
            'PLAN_NGINX_IDENTITY')
    steps = plan.get('steps')
    require(isinstance(steps, list) and steps, 'PLAN_STEPS')
    ids = set()
    prepareIndex = None
    checkIndex = None
    switchIndex = None
    verifyIndex = None
    firstLocked = None
    parallelSteps = []
    mutationSteps = []
    for index, step in enumerate(steps):
        require(isinstance(step, dict), 'PLAN_STEP_INVALID')
        require(isinstance(step.get('id'), str) and step['id'] not in ids,
                'PLAN_STEP_ID')
        ids.add(step['id'])
        require(isinstance(step.get('stage'), str) and step['stage'], 'PLAN_STEP_STAGE')
        stepType = step.get('type')
        require(stepType in ('command', 'pipeline', 'frontendPrepare', 'frontendCheck',
                             'frontendSwitch', 'frontendVerify'),
                'PLAN_STEP_TYPE')
        if stepType == 'command':
            validateArgv(step.get('argv'))
            if step.get('captureOutput') is True:
                require(step.get('outputClassification') == 'non-sensitive',
                        'PLAN_SENSITIVE_OUTPUT')
        if stepType == 'pipeline':
            require(isinstance(step.get('commands'), list) and step['commands'],
                    'PLAN_COMMAND_INVALID')
            for command in step['commands']:
                validateArgv(command)
        if stepType == 'frontendPrepare':
            require(prepareIndex is None and step.get('requiresReleaseLock') is True,
                    'PLAN_FRONTEND_PREPARE_LOCK')
            prepareIndex = index
        elif stepType == 'frontendCheck':
            require(checkIndex is None and step.get('requiresReleaseLock') is True,
                    'PLAN_FRONTEND_CHECK_LOCK')
            checkIndex = index
        elif stepType == 'frontendSwitch':
            require(switchIndex is None and step.get('requiresReleaseLock') is True,
                    'PLAN_FRONTEND_SWITCH_LOCK')
            switchIndex = index
        elif stepType == 'frontendVerify':
            require(verifyIndex is None and step.get('requiresReleaseLock') is True,
                    'PLAN_FRONTEND_VERIFY_LOCK')
            verifyIndex = index
        mutates = step.get('mutatesComponents', [])
        require(isinstance(mutates, list)
                and all(isinstance(component, str) and component
                        for component in mutates), 'PLAN_COMPONENTS_INVALID')
        if mutates:
            mutationSteps.append((index, step, set(mutates)))
            require(step.get('requiresReleaseLock') is True, 'PLAN_MUTATION_UNLOCKED')
            require(checkIndex is not None and checkIndex < index,
                    'NGINX_CHECK_REQUIRED')
            if stepType != 'frontendSwitch':
                rollback = step.get('rollback')
                retainSchema = (mutates == ['database']
                                and step.get('rollbackPolicy')
                                == 'retain-compatible-schema')
                require(retainSchema or (isinstance(rollback, list) and rollback),
                        'PLAN_ROLLBACK_REQUIRED')
                if rollback:
                    for command in rollback:
                        validateArgv(command)
            validateArgv(step.get('reconcileCompleted'))
            validateArgv(step.get('reconcileRolledBack'))
        if step.get('requiresReleaseLock') is True and firstLocked is None:
            firstLocked = index
        if firstLocked is not None and step.get('parallelGroup'):
            require(False, 'PLAN_PARALLEL_INSIDE_LOCK')
        if 'parallelGroup' in step:
            require(isinstance(step.get('parallelGroup'), str)
                    and step.get('parallelGroup'), 'PLAN_PARALLEL_GROUP_INVALID')
            require(not mutates and step.get('readOnly') is True,
                    'PLAN_PARALLEL_NOT_READ_ONLY')
            require(step.get('serialFallbackSafe') is True,
                    'PLAN_PARALLEL_FALLBACK_UNSAFE')
            parallelSteps.append(step)
    require(prepareIndex is not None and checkIndex is not None
            and verifyIndex is not None, 'PLAN_FRONTEND_REQUIRED')
    if frontendPointerMode == 'switch':
        require(switchIndex is not None, 'PLAN_FRONTEND_REQUIRED')
        require(prepareIndex < checkIndex < switchIndex < verifyIndex,
                'PLAN_FRONTEND_ORDER')
    else:
        require(frontend['candidate'] == frontend['expectedCurrent'],
                'PLAN_FRONTEND_POINTER_UNCHANGED')
        require(switchIndex is None, 'PLAN_FRONTEND_UNCHANGED_SWITCH')
        require(len(set(nginxUsers)) >= 2, 'PLAN_FRONTEND_IDENTITIES')
        require(prepareIndex < checkIndex < verifyIndex,
                'PLAN_FRONTEND_ORDER')
        require(mutationSteps, 'PLAN_FRONTEND_UNCHANGED_MUTATION')
        for mutationIndex, _mutationStep, mutationComponents in mutationSteps:
            require(checkIndex < mutationIndex < verifyIndex,
                    'PLAN_FRONTEND_ORDER')
            require(mutationComponents
                    and mutationComponents.issubset(
                        UNCHANGED_POINTER_MUTATION_COMPONENTS),
                    'PLAN_FRONTEND_UNCHANGED_MUTATION')
    components = plan.get('components')
    require(isinstance(components, dict) and components, 'PLAN_COMPONENTS_INVALID')
    for name, component in components.items():
        require(isinstance(name, str) and isinstance(component, dict)
                and component.get('expectedVersion')
                and component.get('targetVersion'), 'PLAN_COMPONENTS_INVALID')
    if frontendPointerMode == 'unchanged':
        mutatedComponents = set()
        for _mutationIndex, _mutationStep, mutationComponents in mutationSteps:
            mutatedComponents.update(mutationComponents)
        require(mutatedComponents.issubset(set(components)),
                'PLAN_FRONTEND_UNCHANGED_COMPONENTS')
        for name in ('api', 'frontend'):
            require(name in components
                    and components[name]['expectedVersion']
                    == components[name]['targetVersion'],
                    'PLAN_FRONTEND_UNCHANGED_COMPONENTS')
    resourceGuard = plan.get('resourceGuard')
    if parallelSteps or resourceGuard is not None:
        require(isinstance(resourceGuard, dict), 'PLAN_RESOURCE_GUARD_REQUIRED')
        validateArgv(resourceGuard.get('argv'))
        require(resourceGuard.get('onPressure') == 'serial'
                and isinstance(resourceGuard.get('minimumDiskFreeBytes'), int)
                and not isinstance(resourceGuard.get('minimumDiskFreeBytes'), bool)
                and resourceGuard['minimumDiskFreeBytes'] > 0
                and isinstance(resourceGuard.get('maximumApiLatencyMs'), int)
                and not isinstance(resourceGuard.get('maximumApiLatencyMs'), bool)
                and resourceGuard['maximumApiLatencyMs'] > 0
                and isinstance(resourceGuard.get('maximumLockWaitMs'), int)
                and not isinstance(resourceGuard.get('maximumLockWaitMs'), bool)
                and resourceGuard['maximumLockWaitMs'] >= 0
                and isinstance(resourceGuard.get('timeoutSeconds', 30), int)
                and not isinstance(resourceGuard.get('timeoutSeconds', 30), bool)
                and 1 <= resourceGuard.get('timeoutSeconds', 30) <= 300,
                'PLAN_RESOURCE_GUARD_INVALID')
    return plan


def loadPlan(path):
    """读取并验证 JSON 计划。"""
    try:
        plan = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise ReleaseError('PLAN_INVALID')
    return validatePlan(plan)


class ReleaseLock(object):
    """覆盖迁移、组件更新、前端切换及验证的非阻塞发布锁。"""

    def __init__(self, path, releaseId, attemptId):
        self.path = Path(path)
        self.releaseId = releaseId
        self.attemptId = attemptId
        self.stream = None

    def acquire(self):
        """获取发布锁并写入持有者证据。"""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW,
                             0o600)
        self.stream = os.fdopen(descriptor, 'w')
        try:
            fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.stream.close()
            self.stream = None
            raise ReleaseError('LOCK_HELD')
        self.stream.write(json.dumps({
            'releaseId': self.releaseId,
            'attemptId': self.attemptId,
            'pid': os.getpid(),
            'acquiredAtUtc': utcNow(),
        }, sort_keys=True))
        self.stream.flush()
        os.fsync(self.stream.fileno())

    def release(self):
        """释放发布锁。"""
        if self.stream:
            fcntl.flock(self.stream, fcntl.LOCK_UN)
            self.stream.close()
            self.stream = None


def commandEnvironment(step):
    """仅允许步骤按键名覆盖环境，不在证据中输出值。"""
    environment = os.environ.copy()
    overrides = step.get('environment', {})
    require(isinstance(overrides, dict)
            and all(isinstance(key, str) and isinstance(value, str)
                    for key, value in overrides.items()), 'PLAN_ENVIRONMENT')
    environment.update(overrides)
    return environment


def parseMetrics(path):
    """从步骤显式 JSON 输出中提取非敏感计数。"""
    metrics = {}
    if not path or not Path(path).is_file():
        return metrics
    try:
        payload = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return metrics
    source = payload.get('metrics', payload) if isinstance(payload, dict) else {}
    for field in METRIC_FIELDS:
        value = source.get(field, 0) if isinstance(source, dict) else 0
        if isinstance(value, int) and value >= 0:
            metrics[field] = value
    return metrics


class ReleaseExecutor(object):
    """执行一份冻结、可审计且可回退的发布计划。"""

    def __init__(self, plan, resume=False):
        self.plan = validatePlan(plan)
        self.resume = resume
        self.evidenceDir = Path(plan['evidenceDir']).absolute()
        self.evidenceDir.mkdir(parents=True, exist_ok=True)
        self.statePath = self.evidenceDir / 'release-state.json'
        self.journalPath = self.evidenceDir / 'release-timing.jsonl'
        self.recorder = EventRecorder(
            self.journalPath, plan['releaseId'], plan['attemptId'],
            plan['sourceDigest'], plan.get('baselineDigest'))
        self.releaseLock = ReleaseLock(
            plan['lockPath'], plan['releaseId'], plan['attemptId'])
        self.lockHeld = False
        self.forceSerial = False
        self.resourceProbeCount = 0
        self.completedMutations = []
        self.rolledBackSteps = []
        self.state = self.loadState()
        completed = set(self.state.get('completedSteps', []))
        self.completedMutations = [
            step for step in self.plan['steps']
            if step['id'] in completed and step.get('mutatesComponents')
        ]

    def loadState(self):
        """读取同计划状态；重入必须匹配源码和基线。"""
        if not self.statePath.exists():
            return {'schemaVersion': SCHEMA_VERSION, 'releaseId': self.plan['releaseId'],
                    'attemptId': self.plan['attemptId'],
                    'planDigest': sha256Bytes(canonicalBytes(self.plan)),
                    'sourceDigest': self.plan['sourceDigest'],
                    'baselineDigest': self.plan.get('baselineDigest'),
                    'completedSteps': [], 'status': 'pending'}
        require(self.resume, 'STATE_EXISTS_USE_RESUME')
        state = json.loads(self.statePath.read_text(encoding='utf-8'))
        require(state.get('status') != 'rolled_back', 'RESUME_AFTER_ROLLBACK')
        require(state.get('status') not in ('passed', 'rollback_failed'),
                'RESUME_TERMINAL_STATE')
        require(state.get('planDigest') == sha256Bytes(canonicalBytes(self.plan))
                and state.get('sourceDigest') == self.plan['sourceDigest']
                and state.get('baselineDigest') == self.plan.get('baselineDigest'),
                'RESUME_STATE_MISMATCH')
        return state

    def verifyBaselineEvidence(self):
        """重读冻结基线文件，避免锁前后或重入时使用陈旧状态。"""
        path = Path(self.plan['baselineEvidence']).absolute()
        require(path.is_file() and not path.is_symlink(), 'BASELINE_EVIDENCE_INVALID')
        digest, _size = sha256File(path)
        require(digest == self.plan['baselineDigest'], 'BASELINE_CHANGED')
        try:
            payload = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise ReleaseError('BASELINE_EVIDENCE_INVALID')
        require(payload.get('passed') is True
                and payload.get('releaseId') == self.plan['releaseId']
                and payload.get('components') == self.plan['components'],
                'BASELINE_COMPONENTS_CHANGED')
        self.recorder.baselineDigest = digest
        return digest

    def saveState(self):
        """持久化可重入步骤状态。"""
        writeJsonAtomic(self.statePath, self.state)

    def gateCommand(self, stepType, nginxUser=None):
        """生成现有前端门禁命令，禁止绕过。"""
        frontend = self.plan['frontend']
        python = frontend.get('python', sys.executable)
        base = [python, frontend['gateScript']]
        if stepType == 'frontendPrepare':
            return base + ['prepare', frontend['candidate']]
        if stepType == 'frontendCheck':
            return base + ['check', frontend['candidate'], '--nginx-user',
                           nginxUser or frontend['nginxUser'], '--expected-current',
                           frontend['expectedCurrent']]
        if stepType == 'frontendSwitch':
            return base + [
                'switch', frontend['candidate'], '--current', frontend['current'],
                '--expected-current', frontend['expectedCurrent'], '--nginx-user',
                frontend['nginxUser'], '--base-url', frontend['baseUrl']]
        return base + ['verify', frontend['candidate'], '--base-url', frontend['baseUrl']]

    def runProcess(self, argv, logPath, timeout, environment, captureOutput=False):
        """执行 argv；默认不保存原始输出，只保存退出状态。"""
        descriptor = os.open(str(logPath), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            try:
                destination = stream if captureOutput else subprocess.DEVNULL
                result = subprocess.run(argv, stdout=destination,
                                        stderr=(subprocess.STDOUT if captureOutput
                                                else subprocess.DEVNULL),
                                        timeout=timeout, env=environment)
            except subprocess.TimeoutExpired:
                raise ReleaseError('STEP_TIMEOUT')
            stream.write(json.dumps({'returnCode': result.returncode,
                                     'capturedOutput': captureOutput},
                                    sort_keys=True).encode('utf-8') + b'\n')
        require(result.returncode == 0, 'STEP_FAILED')

    def runPipeline(self, commands, outputPath, logPath, timeout, environment):
        """执行管道并逐段检查退出码，不把末段成功误判为整体成功。"""
        processes = []
        deadline = time.monotonic() + timeout
        descriptor = os.open(str(logPath), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        temporary = str(outputPath) + '.partial-' + uuid.uuid4().hex
        try:
            with os.fdopen(descriptor, 'wb') as log, open(temporary, 'wb') as output:
                previous = None
                for index, command in enumerate(commands):
                    stdout = output if index == len(commands) - 1 else subprocess.PIPE
                    process = subprocess.Popen(
                        command, stdin=previous, stdout=stdout,
                        stderr=subprocess.DEVNULL,
                        env=environment)
                    if previous is not None:
                        previous.close()
                    previous = process.stdout if stdout == subprocess.PIPE else None
                    processes.append(process)
                for process in processes:
                    remaining = max(0.1, deadline - time.monotonic())
                    try:
                        process.wait(timeout=remaining)
                    except subprocess.TimeoutExpired:
                        raise ReleaseError('STEP_TIMEOUT')
                output.flush()
                os.fsync(output.fileno())
                log.write(json.dumps({'returnCodes': [process.returncode
                                                      for process in processes]},
                                     sort_keys=True).encode('utf-8') + b'\n')
            require(all(process.returncode == 0 for process in processes),
                    'PIPELINE_FAILED')
            os.chmod(temporary, 0o600)
            os.replace(temporary, str(outputPath))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            if os.path.exists(temporary):
                os.unlink(temporary)

    def executeStep(self, step, rollback=False):
        """执行一个步骤并记录摘要，不输出命令正文或敏感响应。"""
        identifier = step['id'] + ('-rollback' if rollback else '')
        logPath = self.evidenceDir / (identifier + '.log')
        outputPath = Path(step['outputFile']).absolute() if step.get('outputFile') else None
        timeout = int(step.get('timeoutSeconds', 900))
        require(1 <= timeout <= 86400, 'PLAN_TIMEOUT')
        stepType = step['type']
        timer = StepTimer(self.recorder, dict(step, id=identifier))
        with timer:
            try:
                if stepType == 'frontendCheck':
                    checked = []
                    extraLogs = []
                    for index, nginxUser in enumerate(self.plan['frontend']['nginxUsers']):
                        identityLog = (logPath if index == 0 else self.evidenceDir /
                                       (identifier + '-identity-' + str(index + 1) + '.log'))
                        self.runProcess(self.gateCommand(stepType, nginxUser), identityLog,
                                        timeout, commandEnvironment(step), False)
                        checked.append(nginxUser)
                        if identityLog != logPath:
                            extraLogs.append(identityLog)
                    with logPath.open('wb') as stream:
                        stream.write(json.dumps({'passed': True,
                                                 'nginxUsersChecked': checked},
                                                sort_keys=True).encode('utf-8') + b'\n')
                    for extraLog in extraLogs:
                        extraLog.unlink()
                elif stepType in ('frontendPrepare', 'frontendSwitch', 'frontendVerify'):
                    self.runProcess(self.gateCommand(stepType), logPath, timeout,
                                    commandEnvironment(step), False)
                elif stepType == 'command':
                    self.runProcess(step['argv'], logPath, timeout,
                                    commandEnvironment(step),
                                    step.get('captureOutput') is True)
                else:
                    require(outputPath is not None, 'PLAN_PIPELINE_OUTPUT')
                    outputPath.parent.mkdir(parents=True, exist_ok=True)
                    self.runPipeline(step['commands'], outputPath, logPath, timeout,
                                     commandEnvironment(step))
                digest, size = sha256File(logPath)
                evidence = {'path': str(logPath), 'sha256': digest, 'size': size}
                if outputPath and outputPath.is_file():
                    outputDigest, outputSize = sha256File(outputPath)
                    evidence['output'] = {'path': str(outputPath),
                                          'sha256': outputDigest,
                                          'size': outputSize}
                evidencePath = self.evidenceDir / (identifier + '.evidence.json')
                writeJsonAtomic(evidencePath, evidence)
                metrics = parseMetrics(step.get('metricsFile'))
                timer.finish('passed', str(evidencePath), metrics)
                return evidence
            except ReleaseError as error:
                timer.finish('failed', str(logPath), errorCode=error.code)
                error.step = step['id']
                raise
            except Exception:
                timer.finish('failed', str(logPath), errorCode='STEP_FAILED')
                raise ReleaseError('STEP_FAILED', step['id'])

    def runResourceProbe(self, reason):
        """执行真实资源探针；磁盘不足失败关闭，API/锁压力触发串行降级。"""
        guard = self.plan.get('resourceGuard')
        if not guard:
            return {'pressure': False}
        self.resourceProbeCount += 1
        startedAt = utcNow()
        startedMonotonic = time.monotonic()
        identifier = 'resource-probe-%03d' % self.resourceProbeCount
        try:
            result = subprocess.run(
                guard['argv'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=guard.get('timeoutSeconds', 30),
                env=commandEnvironment({'environment': guard.get('environment', {})}))
            require(result.returncode == 0, 'RESOURCE_PROBE_FAILED')
            require(len(result.stdout) <= 65536, 'RESOURCE_PROBE_INVALID')
            try:
                payload = json.loads(result.stdout.decode('utf-8'))
            except (UnicodeDecodeError, ValueError):
                raise ReleaseError('RESOURCE_PROBE_INVALID')
            fields = ('diskFreeBytes', 'apiLatencyMs', 'lockWaitMs')
            require(isinstance(payload, dict) and payload.get('passed') is True
                    and all(isinstance(payload.get(field), int)
                            and not isinstance(payload.get(field), bool)
                            and payload.get(field) >= 0 for field in fields),
                    'RESOURCE_PROBE_INVALID')
            require(payload['diskFreeBytes'] >= guard['minimumDiskFreeBytes'],
                    'RESOURCE_DISK_LOW')
            pressure = (payload['apiLatencyMs'] > guard['maximumApiLatencyMs']
                        or payload['lockWaitMs'] > guard['maximumLockWaitMs'])
            if pressure:
                self.forceSerial = True
            evidence = {
                'passed': True,
                'reason': reason,
                'diskFreeBytes': payload['diskFreeBytes'],
                'apiLatencyMs': payload['apiLatencyMs'],
                'lockWaitMs': payload['lockWaitMs'],
                'parallelDegraded': pressure,
            }
            evidencePath = self.evidenceDir / (identifier + '.json')
            writeJsonAtomic(evidencePath, evidence)
            metrics = dict(payload)
            metrics['parallelDegraded'] = 1 if pressure else 0
            self.recorder.record(
                'resource-guard', identifier, startedAt, utcNow(),
                (time.monotonic() - startedMonotonic) * 1000, 'passed',
                waitReason=('resource-pressure' if pressure else reason),
                evidenceRef=str(evidencePath), metrics=metrics)
            return {'pressure': pressure, 'evidence': str(evidencePath)}
        except subprocess.TimeoutExpired:
            error = ReleaseError('RESOURCE_PROBE_TIMEOUT')
        except ReleaseError as caught:
            error = caught
        except Exception:
            error = ReleaseError('RESOURCE_PROBE_FAILED')
        self.recorder.record(
            'resource-guard', identifier, startedAt, utcNow(),
            (time.monotonic() - startedMonotonic) * 1000, 'failed',
            waitReason=reason, errorCode=error.code)
        raise error

    def runParallelGroup(self, steps):
        """最多两个只读任务并发；压力后停止启动新任务并串行降级。"""
        require(bool(steps), 'PARALLEL_LIMIT')
        self.runResourceProbe('parallel-group-start')
        if self.forceSerial:
            for step in steps:
                self.runResourceProbe('serial-fallback-before-step')
                self.executeStep(step)
                self.markCompleted(step)
            return
        pending = list(steps)
        firstError = None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            running = {}
            while pending or running:
                while pending and len(running) < 2 and not self.forceSerial:
                    step = pending.pop(0)
                    running[pool.submit(self.executeStep, step)] = step
                if not running:
                    break
                done, _notDone = concurrent.futures.wait(
                    list(running), return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    step = running.pop(future)
                    try:
                        future.result()
                        self.markCompleted(step)
                    except Exception as error:
                        if firstError is None:
                            firstError = error
                if firstError:
                    pending = []
                    continue
                if pending:
                    self.runResourceProbe('parallel-group-progress')
            for future, step in list(running.items()):
                try:
                    future.result()
                    self.markCompleted(step)
                except Exception as error:
                    if firstError is None:
                        firstError = error
        if firstError:
            raise firstError
        for step in pending:
            self.runResourceProbe('serial-fallback-before-step')
            self.executeStep(step)
            self.markCompleted(step)

    def markCompleted(self, step):
        """记录完成步骤与可回退的组件变更。"""
        if step['id'] not in self.state['completedSteps']:
            self.state['completedSteps'].append(step['id'])
        if step.get('mutatesComponents') and step not in self.completedMutations:
            self.completedMutations.append(step)
        if self.state.get('pendingMutation') == step['id']:
            self.state['pendingMutation'] = None
        self.saveState()

    def beginMutation(self, step):
        """写前日志：崩溃后留下 unknown，恢复时禁止重放非幂等动作。"""
        if not step.get('mutatesComponents'):
            return
        require(not self.state.get('pendingMutation'), 'UNKNOWN_MUTATION_STATE')
        self.state['pendingMutation'] = step['id']
        self.state['pendingMutationStartedAtUtc'] = utcNow()
        self.saveState()
        if step['type'] != 'frontendSwitch' and step not in self.completedMutations:
            self.completedMutations.append(step)

    def rollback(self):
        """前端门禁之外，按反序独立回退 API/Worker 等组件。"""
        failures = []
        for original in reversed(self.completedMutations):
            originalFailed = False
            if original['type'] == 'frontendSwitch':
                frontend = self.plan['frontend']
                rollbackCommands = [[
                    frontend.get('python', sys.executable), frontend['gateScript'],
                    'switch', frontend['expectedCurrent'], '--current',
                    frontend['current'], '--expected-current', frontend['candidate'],
                    '--nginx-user', frontend['nginxUser'], '--base-url',
                    frontend['baseUrl']] + (['--rollback'] if
                        (Path(frontend['candidate']) / 'rollback-target.json').is_file() else [])]
            else:
                rollbackCommands = original.get('rollback', [])
            for index, command in enumerate(rollbackCommands):
                rollbackStep = {
                    'id': original['id'] + '-' + str(index + 1),
                    'stage': 'rollback',
                    'type': 'command',
                    'argv': command,
                    'timeoutSeconds': original.get('rollbackTimeoutSeconds', 900),
                }
                try:
                    self.executeStep(rollbackStep, rollback=True)
                except ReleaseError as error:
                    failures.append({'step': original['id'], 'code': error.code})
                    originalFailed = True
            if not originalFailed:
                self.rolledBackSteps.append(original['id'])
        return failures

    def runResumeChecks(self):
        """重入前重核迁移台账、当前指针及逐组件版本。"""
        if not self.resume:
            return
        checks = self.plan.get('resumeChecks')
        require(isinstance(checks, list) and checks, 'RESUME_CHECKS_REQUIRED')
        for index, command in enumerate(checks):
            validateArgv(command)
            step = {'id': 'resume-check-' + str(index + 1), 'stage': 'baseline',
                    'type': 'command', 'argv': command, 'readOnly': True}
            self.executeStep(step)

    def run(self):
        """运行计划；正式锁从首个关键步骤保持至最终验证结束。"""
        self.verifyBaselineEvidence()
        self.state['status'] = 'running'
        self.state['startedAtUtc'] = self.state.get('startedAtUtc') or utcNow()
        self.saveState()
        steps = self.plan['steps']
        index = 0
        try:
            self.runResourceProbe('release-preflight')
            while index < len(steps):
                step = steps[index]
                if step.get('requiresReleaseLock') is True and not self.lockHeld:
                    lockStarted = utcNow()
                    monotonic = time.monotonic()
                    try:
                        self.releaseLock.acquire()
                        self.lockHeld = True
                        self.verifyBaselineEvidence()
                        self.runResumeChecks()
                        require(not self.state.get('pendingMutation'),
                                'UNKNOWN_MUTATION_STATE')
                        self.recorder.record(
                            'release', 'acquire-release-lock', lockStarted, utcNow(),
                            (time.monotonic() - monotonic) * 1000, 'passed')
                    except ReleaseError as error:
                        self.recorder.record(
                            'release', 'acquire-release-lock', lockStarted, utcNow(),
                            (time.monotonic() - monotonic) * 1000, 'failed',
                            waitReason='concurrent-release', errorCode=error.code)
                        raise
                if step['id'] in self.state['completedSteps']:
                    require(step.get('resumeSafe') is True, 'RESUME_NON_IDEMPOTENT_STEP')
                    index += 1
                    continue
                group = step.get('parallelGroup')
                if group:
                    grouped = []
                    while (index < len(steps)
                           and steps[index].get('parallelGroup') == group):
                        grouped.append(steps[index])
                        index += 1
                    self.runParallelGroup(grouped)
                    continue
                self.beginMutation(step)
                self.executeStep(step)
                self.markCompleted(step)
                index += 1
            self.state['status'] = 'passed'
            self.state['finishedAtUtc'] = utcNow()
            self.saveState()
            summary = buildSummary(self.journalPath, self.state)
            writeJsonAtomic(self.evidenceDir / 'release-summary.json', summary)
            return summary
        except ReleaseError as error:
            rollbackFailures = self.rollback() if self.lockHeld else []
            if not rollbackFailures:
                self.state['completedSteps'] = [
                    stepId for stepId in self.state['completedSteps']
                    if stepId not in self.rolledBackSteps]
                if self.state.get('pendingMutation') in self.rolledBackSteps:
                    self.state['pendingMutation'] = None
            self.state['status'] = ('rollback_failed' if rollbackFailures else
                                    'rolled_back' if self.rolledBackSteps else 'failed')
            self.state['errorCode'] = error.code
            self.state['failedStep'] = error.step
            self.state['rollbackFailures'] = rollbackFailures
            self.state['finishedAtUtc'] = utcNow()
            self.saveState()
            raise ReleaseError('ROLLBACK_FAILED' if rollbackFailures else error.code,
                               error.step)
        finally:
            self.releaseLock.release()
            self.lockHeld = False


def buildSummary(journalPath, state=None):
    """按事件边界计算墙钟，不把并行步骤耗时直接相加。"""
    events = []
    with Path(journalPath).open('r', encoding='utf-8') as stream:
        for line in stream:
            if line.strip():
                events.append(json.loads(line))
    require(bool(events), 'SUMMARY_EMPTY')
    started = min(event['startedAt'] for event in events)
    finished = max(event['finishedAt'] for event in events)
    startTime = datetime.datetime.strptime(started, '%Y-%m-%dT%H:%M:%S.%fZ')
    finishTime = datetime.datetime.strptime(finished, '%Y-%m-%dT%H:%M:%S.%fZ')
    stages = {}
    for event in events:
        stage = stages.setdefault(event['stage'], {'steps': 0, 'failed': 0,
                                                    'taskDurationMs': 0})
        stage['steps'] += 1
        stage['failed'] += 1 if event['status'] == 'failed' else 0
        stage['taskDurationMs'] += event['durationMs']
    return {
        'passed': (state or {}).get('status') == 'passed',
        'releaseId': events[0]['releaseId'],
        'attemptId': events[0]['attemptId'],
        'startedAtUtc': started,
        'finishedAtUtc': finished,
        'wallDurationMs': int((finishTime - startTime).total_seconds() * 1000),
        'eventCount': len(events),
        'stages': stages,
        'stateStatus': (state or {}).get('status'),
        'criticalPathNote': 'wallDurationMs uses event boundaries; parallel task durations are not summed',
    }


def resolveUnknownMutation(plan, outcome, reconciliationEvidence):
    """锁内先对账 unknown mutation，再以已知结果执行恢复状态检查。"""
    require(outcome in ('completed', 'rolled-back'), 'RESOLUTION_OUTCOME')
    evidencePath = Path(reconciliationEvidence).absolute()
    require(evidencePath.is_file() and not evidencePath.is_symlink(),
            'RESOLUTION_EVIDENCE')
    try:
        evidence = json.loads(evidencePath.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise ReleaseError('RESOLUTION_EVIDENCE')
    statePath = Path(plan['evidenceDir']).absolute() / 'release-state.json'
    require(statePath.is_file(), 'RESOLUTION_STATE')
    lock = ReleaseLock(plan['lockPath'], plan['releaseId'], plan['attemptId'])
    try:
        lock.acquire()
        digest, _size = sha256File(plan['baselineEvidence'])
        require(digest == plan['baselineDigest'], 'BASELINE_CHANGED')
        state = json.loads(statePath.read_text(encoding='utf-8'))
        planDigest = sha256Bytes(canonicalBytes(plan))
        require(state.get('releaseId') == plan['releaseId']
                and state.get('attemptId') == plan['attemptId']
                and state.get('planDigest') == planDigest
                and state.get('sourceDigest') == plan['sourceDigest']
                and state.get('baselineDigest') == plan['baselineDigest'],
                'RESOLUTION_STATE_MISMATCH')
        pending = state.get('pendingMutation')
        require(isinstance(pending, str) and pending, 'RESOLUTION_NOT_PENDING')
        pendingStep = next((step for step in plan['steps']
                            if step['id'] == pending), None)
        require(pendingStep is not None, 'RESOLUTION_NOT_PENDING')
        reconciliationKey = ('reconcileCompleted' if outcome == 'completed'
                             else 'reconcileRolledBack')
        reconciliationCommand = pendingStep.get(reconciliationKey)
        validateArgv(reconciliationCommand)
        checks = plan.get('resumeChecks')
        require(isinstance(checks, list) and checks, 'RESUME_CHECKS_REQUIRED')
        for command in checks:
            validateArgv(command)
        require(evidence.get('passed') is True and evidence.get('step') == pending
                and evidence.get('outcome') == outcome
                and evidence.get('releaseId') == plan['releaseId']
                and evidence.get('attemptId') == plan['attemptId']
                and evidence.get('planDigest') == planDigest
                and evidence.get('sourceDigest') == plan['sourceDigest']
                and evidence.get('baselineDigest') == plan['baselineDigest']
                and evidence.get('components') == plan['components'],
                'RESOLUTION_EVIDENCE')
        evidenceDigest, _size = sha256File(evidencePath)
        result = subprocess.run(reconciliationCommand, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        require(result.returncode == 0, 'RESOLUTION_RECONCILIATION_FAILED')
        if outcome == 'completed' and pending not in state['completedSteps']:
            state['completedSteps'].append(pending)
        if outcome == 'rolled-back' and pending in state['completedSteps']:
            state['completedSteps'].remove(pending)
        state['pendingMutation'] = None
        state['mutationResolution'] = {
            'step': pending, 'outcome': outcome, 'evidence': str(evidencePath),
            'evidenceDigest': evidenceDigest, 'resolvedAtUtc': utcNow(),
            'resumeChecksPassed': False,
        }
        writeJsonAtomic(statePath, state)
        for command in checks:
            result = subprocess.run(command, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL)
            if result.returncode != 0:
                state['status'] = 'resolution_check_failed'
                state['errorCode'] = 'RESOLUTION_POSTCHECK_FAILED'
                state['mutationResolution']['postCheckFailedAtUtc'] = utcNow()
                writeJsonAtomic(statePath, state)
                raise ReleaseError('RESOLUTION_POSTCHECK_FAILED')
        state['status'] = 'running'
        state.pop('errorCode', None)
        state['mutationResolution']['resumeChecksPassed'] = True
        state['mutationResolution']['resumeChecksPassedAtUtc'] = utcNow()
        writeJsonAtomic(statePath, state)
        return {'passed': True, 'step': pending, 'outcome': outcome,
                'evidenceDigest': evidenceDigest}
    finally:
        lock.release()


def main():
    """命令行入口。"""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    for name in ('validate', 'run', 'resume'):
        command = sub.add_parser(name)
        command.add_argument('--plan', required=True)
    summary = sub.add_parser('summary')
    summary.add_argument('--journal', required=True)
    summary.add_argument('--state')
    resolve = sub.add_parser('resolve-unknown')
    resolve.add_argument('--plan', required=True)
    resolve.add_argument('--outcome', required=True,
                         choices=('completed', 'rolled-back'))
    resolve.add_argument('--evidence', required=True)
    args = parser.parse_args()
    try:
        require(args.command is not None, 'COMMAND_REQUIRED')
        if args.command == 'summary':
            state = None
            if args.state:
                state = json.loads(Path(args.state).read_text(encoding='utf-8'))
            result = buildSummary(args.journal, state)
        elif args.command == 'resolve-unknown':
            result = resolveUnknownMutation(
                loadPlan(args.plan), args.outcome, args.evidence)
        else:
            plan = loadPlan(args.plan)
            if args.command == 'validate':
                result = {'passed': True, 'releaseId': plan['releaseId'],
                          'planDigest': sha256Bytes(canonicalBytes(plan)),
                          'steps': len(plan['steps'])}
            else:
                result = ReleaseExecutor(plan, resume=args.command == 'resume').run()
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, ReleaseError) else 'RELEASE_FAILED'
        result = {'passed': False, 'code': code}
        if isinstance(error, ReleaseError) and error.step:
            result['step'] = error.step
        print(json.dumps(result, sort_keys=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
