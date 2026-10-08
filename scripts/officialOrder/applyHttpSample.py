"""官网 HTTP 单样本回写：先核验、持久备份，再显式提交；未知结果停止对账。"""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import uuid

from writeBoundary import MAX_PLAN_BYTES, checkWriteBoundary, privateBytes, strictJson, validateIntent
from externalPayerChange import apply_record

IMAGE = 'mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
API_CONTAINER = 'apple-order-mgr-prod-api-1'
MAX_BYTES = 16777216
SOURCES = (
    'scripts/officialPickupBackfill/applyHttpResult.js',
    'scripts/officialPickupBackfill/verifyExternalPayerChange.js',
    'src/services/officialOrderSupport.js',
    'src/services/officialOrderParser.js',
    'src/services/officialOrderRequestEvidence.js',
    'src/services/officialOrderStatusSync.js',
    'src/services/officialPickupDate.js',
    'src/utils/ApiError.js',
)
PUBLIC_FIELDS = (
    'mode', 'orderId', 'runId', 'statusAction', 'dateAction', 'previousDate', 'proposedDate',
    'proposedOfficialStatus', 'proposedObservedAt', 'statusSaved', 'dateFilled', 'businessWrites',
    'beforeHash', 'afterHash', 'sha256',
)


def writePrivate(path, value):
    """原子保存后同步文件及父目录，提交前必须已完成持久化。"""
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex + '.tmp')
    descriptor = None
    try:
        descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            descriptor = None
            json.dump(value, handle, ensure_ascii=True, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        if os.geteuid() == 0:
            os.chown(str(temporary), 1000, 1000)
        os.replace(str(temporary), str(path))
        directory = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def readPrivate(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_BYTES:
        raise RuntimeError('HTTP_APPLY_PRIVATE_FILE_INVALID')
    return strictJson(privateBytes(path, MAX_BYTES))


def checkBoundary(root, planSha256, ownIntent=None):
    """保持 HTTP 错误码；已保存自家意图后的任何边界异常由调用方保留为待对账。"""
    try:
        checkWriteBoundary(root, planSha256, ownIntent)
    except RuntimeError as error:
        codes = {'WRITE_BOUNDARY_PLAN_CHANGED': 'HTTP_APPLY_PLAN_CHANGED',
                 'WRITE_BOUNDARY_STOP_REQUESTED': 'HTTP_APPLY_STOP_REQUESTED',
                 'WRITE_BOUNDARY_CLEANUP_PENDING': 'HTTP_APPLY_CLEANUP_PENDING'}
        raise RuntimeError(codes.get(str(error), 'MANUAL_RECONCILIATION_REQUIRED')) from None


def call(args, **kwargs):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def safeCode(value, fallback='HTTP_APPLY_FAILED'):
    return value if isinstance(value, str) and re.fullmatch(r'HTTP_APPLY_[A-Z_]{1,80}', value) else fallback


def parseOutput(result, applying=False):
    try:
        if len(result.stdout) > MAX_BYTES:
            raise ValueError()
        value = json.loads(result.stdout.decode('utf-8'))
        if not isinstance(value, dict):
            raise ValueError()
        if result.returncode or value.get('ok') is not True:
            if value.get('code') == 'MANUAL_RECONCILIATION_REQUIRED':
                raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
            if value.get('ok') is False and value.get('rollbackConfirmed') is True:
                raise RuntimeError(safeCode(value.get('code')))
            if applying:
                raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
            raise RuntimeError(safeCode(value.get('code')))
        return value['result']
    except (ValueError, KeyError, UnicodeError):
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED' if applying else 'HTTP_APPLY_OUTPUT_INVALID')


def verify(root, audit, attemptId):
    """只读无网络容器核验原文与审计，私密输出只进入内存。"""
    name = 'apple-official-http-verify-' + attemptId
    result = None
    try:
        result = call([
            'docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
            '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '256m', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,size=33554432',
            '-e', 'NODE_PATH=/research/node_modules', '-v', str(root) + ':/research:ro',
            '-v', str(root / 'deps') + ':/research/node_modules:ro', '--entrypoint', 'node', IMAGE,
            '/research/release/scripts/officialPickupBackfill/applyHttpResult.js', '--verify', '/research', audit,
        ], timeout=30)
    finally:
        # --rm 正常退出时已移除；超时时仍按唯一名称作有界清理，整个容器无业务网络。
        try:
            call(['docker', 'rm', '-f', name], timeout=15)
        except Exception:
            pass
    if result.returncode:
        try:
            code = json.loads(result.stderr.decode('utf-8')).get('outcome')
        except (ValueError, AttributeError, UnicodeError):
            code = None
        raise RuntimeError(safeCode(code, 'HTTP_APPLY_VERIFY_FAILED'))
    if len(result.stdout) > MAX_BYTES:
        raise RuntimeError('HTTP_APPLY_INPUT_TOO_LARGE')
    try:
        return json.loads(result.stdout.decode('utf-8'))
    except (ValueError, UnicodeError):
        raise RuntimeError('HTTP_APPLY_OUTPUT_INVALID')


BRIDGE = r'''
const Module = require('module');
const path = require('path');
const external = Module.createRequire('/app/package.json');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  if (!Object.hasOwn(bundle, name)) throw Error('MODULE_NOT_BUNDLED');
  const file = '/tmp/official-http-apply/' + name;
  const item = new Module(file);
  item.filename = file;
  item.paths = ['/app/node_modules'];
  item.require = request => request.startsWith('.')
    ? load(path.posix.normalize(path.posix.join(path.posix.dirname(name), request)) + '.js')
    : external(request);
  modules.set(name, item);
  item._compile(bundle[name], file);
  return item.exports;
}
let client;
let transactionStarted = false;
let rollbackConfirmed = false;
let commitStarted = false;
let commitConfirmed = false;
(async () => {
  try {
    if (process.env.NODE_ENV !== 'production' || !process.env.DB_HOST || !process.env.DB_NAME ||
        /research|study/i.test(process.env.DB_HOST + ' ' + process.env.DB_NAME))
      throw Object.assign(Error(), { code: 'HTTP_APPLY_BUSINESS_DATABASE_REQUIRED' });
    const { Client } = external('pg');
    client = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT,
      database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      connectionTimeoutMillis: 10000, options: '-c statement_timeout=10000' });
    await client.connect();
    const check = await client.query("SELECT current_database() AS name, to_regclass('public.orders') AS orders");
    if (check.rows[0]?.name !== process.env.DB_NAME || !check.rows[0].orders)
      throw Object.assign(Error(), { code: 'HTTP_APPLY_BUSINESS_DATABASE_REQUIRED' });
    const query = client.query.bind(client);
    client.query = async (...args) => {
      const sql = args[0];
      if (typeof sql === 'string' && sql.startsWith('BEGIN')) transactionStarted = true;
      if (sql === 'COMMIT') commitStarted = true;
      const result = await query(...args);
      if (sql === 'COMMIT') commitConfirmed = true;
      if (sql === 'ROLLBACK') rollbackConfirmed = true;
      return result;
    };
    if (input.payerRecord) {
      const { verifyExternalPayerRecord, buildExternalPayerBasis } =
        load('scripts/officialPickupBackfill/verifyExternalPayerChange.js');
      await verifyExternalPayerRecord(client, input.payerRecord);
      input.basis = buildExternalPayerBasis(input.payerRecord, input.payload, input.basis);
    }
    const { applyHttpPayload } = load('scripts/officialPickupBackfill/applyHttpResult.js');
    const result = await applyHttpPayload(client, input.payload, {
      mode: input.mode, basis: input.basis, preview: input.preview,
    });
    if (input.mode === 'apply' && !commitConfirmed) throw Error('COMMIT_NOT_CONFIRMED');
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) {
    const unknown = input.mode === 'apply' &&
      ((commitStarted && !commitConfirmed) || (transactionStarted && !commitConfirmed && !rollbackConfirmed));
    const code = unknown ? 'MANUAL_RECONCILIATION_REQUIRED' :
      /^HTTP_APPLY_[A-Z_]+$/.test(error.code || '') ? error.code : 'HTTP_APPLY_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, code,
      rollbackConfirmed: !commitStarted && (!transactionStarted || rollbackConfirmed) }) + '\n');
    process.exitCode = 2;
  } finally {
    if (client) await client.end().catch(() => {});
  }
})();
'''


def database(root, payload, mode, basis=None, preview=None, beforeStart=None):
    """通过 stdin 编译指定源码，不落盘凭据、不修改 API 安装目录。"""
    bundle = {name: (root / 'release' / name).read_text(encoding='utf-8') for name in SOURCES}
    data = {'payload': payload, 'mode': mode, 'basis': basis, 'preview': preview,
            'payerRecord': apply_record(root, payload)}
    script = ('const bundle=' + json.dumps(bundle, ensure_ascii=True) + ';\nconst input=' +
              json.dumps(data, ensure_ascii=True, allow_nan=False) + ';\n' + BRIDGE).encode('utf-8')
    if beforeStart is not None:
        beforeStart()
    try:
        result = call(['docker', 'exec', '-i', API_CONTAINER, 'node', '-'], input=script, timeout=45)
    except Exception:
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED' if mode == 'apply' else 'HTTP_APPLY_DATABASE_UNAVAILABLE')
    return parseOutput(result, mode == 'apply')


def validateResult(result, payload, mode, preview=None):
    if (not isinstance(result, dict) or result.get('version') != 1 or result.get('mode') != mode or
            result.get('orderId') != payload['entry']['id'] or result.get('runId') != payload['audit']['runId'] or
            not isinstance(result.get('basis'), dict) or not isinstance(result.get('snapshot'), dict) or
            not re.fullmatch(r'[a-f0-9]{64}', result.get('payloadSha256', '')) or
            not re.fullmatch(r'[a-f0-9]{32}', result.get('beforeHash', ''))):
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED' if mode == 'apply' else 'HTTP_APPLY_OUTPUT_INVALID')
    if preview and any(result.get(key) != preview.get(key) for key in
                       ('payloadSha256', 'basis', 'beforeHash', 'devicesHash', 'stableRowHash')):
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--audit', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = pathlib.Path(args.root)
    match = re.fullmatch(r'http-sample-([1-9][0-9]*)-([a-f0-9]{32})\.json', args.audit)
    summary = {'outcome': 'HTTP_APPLY_FAILED', 'mode': 'apply' if args.apply else 'dry-run', 'businessWrites': 0}
    lock = None
    attemptId = uuid.uuid4().hex
    applyStarted = False
    intentFile = None
    resolved = False
    applyReturned = False
    databaseStarted = False
    private = None
    try:
        if not root.is_absolute() or not match or not (root / 'private').is_dir() or (root / 'private').is_symlink():
            raise RuntimeError('HTTP_APPLY_ARGUMENT_INVALID')
        orderId = int(match.group(1))
        summary['orderId'] = orderId
        private = root / 'private'
        planSha256 = hashlib.sha256(privateBytes(private / 'plan.json', MAX_PLAN_BYTES)).hexdigest()
        descriptor = os.open(str(private / 'http-apply.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        lock = os.fdopen(descriptor, 'a', encoding='utf-8')
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise RuntimeError('HTTP_APPLY_PRIVATE_FILE_INVALID')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('HTTP_APPLY_BUSY')
        intentFile = private / ('http-apply-intent-' + str(orderId) + '.json')
        if intentFile.exists():
            try:
                previous = readPrivate(intentFile)
                validateIntent(intentFile, previous)
            except Exception:
                raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED') from None
            if previous.get('state') not in ('APPLIED', 'ROLLED_BACK'):
                raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
            if args.apply and previous.get('state') == 'APPLIED' and previous.get('sourceAudit') == args.audit:
                summary = dict(readPrivate(private / previous['auditFile']), replayed=True, businessWrites=0)
                return summary
        checkBoundary(root, planSha256)
        payload = verify(root, args.audit, attemptId)
        checkBoundary(root, planSha256)
        if (not isinstance(payload, dict) or payload.get('entry', {}).get('id') != orderId or
                payload.get('audit', {}).get('attemptId') != match.group(2) or
                not isinstance(payload.get('audit', {}).get('runId'), int)):
            raise RuntimeError('HTTP_APPLY_OUTPUT_INVALID')
        summary['runId'] = payload['audit']['runId']
        prefix = 'http-apply-' + str(orderId) + '-' + attemptId
        payloadFile = private / (prefix + '-payload.json')
        previewFile = private / (prefix + '-preview.json')
        resultFile = private / (prefix + '-result.json')
        auditFile = private / (prefix + '-audit.json')
        basisFile = private / ('http-apply-basis-' + str(orderId) + '-run-' + str(summary['runId']) + '.json')
        basis = readPrivate(basisFile) if basisFile.exists() else None
        writePrivate(payloadFile, payload)
        checkBoundary(root, planSha256)
        preview = database(root, payload, 'dry-run', basis=basis,
                           beforeStart=lambda: checkBoundary(root, planSha256))
        checkBoundary(root, planSha256)
        validateResult(preview, payload, 'dry-run')
        writePrivate(previewFile, preview)
        checkBoundary(root, planSha256)
        summary.update(previewFile=previewFile.name, auditFile=auditFile.name)
        if not args.apply:
            summary.update({key: preview[key] for key in PUBLIC_FIELDS if key in preview})
            summary['outcome'] = 'DRY_RUN'
            writePrivate(auditFile, summary)
            checkBoundary(root, planSha256)
            return summary
        intent = {'state': 'APPLY_STARTED', 'sourceAudit': args.audit, 'attemptId': attemptId,
                  'orderId': orderId, 'runId': summary['runId'], 'payloadFile': payloadFile.name,
                  'previewFile': previewFile.name, 'resultFile': resultFile.name, 'auditFile': auditFile.name}
        ownIntent = (intentFile, json.dumps(intent, ensure_ascii=True, allow_nan=False).encode('utf-8'))
        checkBoundary(root, planSha256)
        applyStarted = True
        writePrivate(intentFile, intent)
        checkBoundary(root, planSha256, ownIntent)
        def beforeApply():
            nonlocal databaseStarted
            checkBoundary(root, planSha256, ownIntent)
            databaseStarted = True
        result = database(root, payload, 'apply', basis=preview['basis'], preview=preview, beforeStart=beforeApply)
        applyReturned = True
        validateResult(result, payload, 'apply', preview)
        writePrivate(resultFile, result)
        writePrivate(basisFile, result['basis'])
        summary.update({key: result[key] for key in PUBLIC_FIELDS if key in result})
        summary['outcome'] = 'SUCCEEDED'
        summary['resultFile'] = resultFile.name
        summary['basisFile'] = basisFile.name
        writePrivate(auditFile, summary)
        writePrivate(intentFile, dict(intent, state='APPLIED'))
        resolved = True
        return summary
    except Exception as error:
        code = str(error)
        if code == 'MANUAL_RECONCILIATION_REQUIRED' or (applyStarted and not databaseStarted) or (applyReturned and not resolved) or (applyStarted and not resolved and
                not re.fullmatch(r'HTTP_APPLY_[A-Z_]{1,80}', code)):
            code = 'MANUAL_RECONCILIATION_REQUIRED'
        else:
            code = safeCode(code)
        summary['outcome'] = code
        if code == 'MANUAL_RECONCILIATION_REQUIRED':
            summary['businessWrites'] = None
        elif applyStarted and intentFile is not None:
            try:
                intent = readPrivate(intentFile)
                writePrivate(intentFile, dict(intent, state='ROLLED_BACK', outcome=code))
            except Exception:
                summary.update(outcome='MANUAL_RECONCILIATION_REQUIRED', businessWrites=None)
        if private is not None:
            try:
                errorAudit = private / ('http-apply-error-' + attemptId + '.json')
                summary['auditFile'] = errorAudit.name
                writePrivate(errorAudit, summary)
            except Exception:
                pass
        return summary
    finally:
        if lock is not None:
            lock.close()
        print(json.dumps(summary, ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
