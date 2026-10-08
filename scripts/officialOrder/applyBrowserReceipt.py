"""浏览器收据绑定：默认只读核验；显式应用持久留痕，任何未知或部分写入停止对账。"""
import argparse
import fcntl
import hashlib
import json
import pathlib
import re
import stat
import time
import uuid

from applyHttpSample import IMAGE, API_CONTAINER, MAX_BYTES, call, readPrivate, writePrivate

PUBLIC_FIELDS = ('orderId', 'outcome', 'serialCount', 'newBindings', 'serialsHash', 'deviceIds',
                 'actorUserId', 'receiptRunId', 'receiptSha256', 'detailSha256', 'orderBeforeHash',
                 'orderAfterHash', 'manualPickupUnchanged', 'inventoryReceiveCreated')


def validInt(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validDeviceId(value):
    """逐台设备主键使用 PostgreSQL UUID；只接受非零规范小写表示。"""
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
        return parsed.int > 0 and str(parsed) == value
    except (ValueError, AttributeError):
        return False


def safeName(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json', value)


def safeCode(value):
    return value if isinstance(value, str) and re.fullmatch(r'BROWSER_RECEIPT_[A-Z_]{1,80}', value) else 'BROWSER_RECEIPT_FAILED'


def boundaryBytes(path):
    """边界校验使用同一次原文字节读取，不接受链接或非私密文件。"""
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_BYTES:
        raise RuntimeError('BROWSER_RECEIPT_PRIVATE_FILE_INVALID')
    value = path.read_bytes()
    if len(value) > MAX_BYTES:
        raise RuntimeError('BROWSER_RECEIPT_PRIVATE_FILE_INVALID')
    return value


def boundaryIntent(raw):
    """意图 JSON 不得以重复键或非有限数字产生不同解释。"""
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError()
            value[key] = item
        return value

    def constant(_value):
        raise ValueError()

    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def checkBoundary(root, planSha256, ownIntent=None):
    """提交前复核停机与冻结原文；仅豁免本次精确持久化的意图字节。"""
    private = root / 'private'
    ownFound = ownIntent is None
    try:
        for prefix, accepted in (('http-apply-intent-', ('APPLIED', 'ROLLED_BACK')),
                                 ('browser-receipt-bind-intent-', ('APPLIED',))):
            for path in private.glob(prefix + '*.json'):
                raw = boundaryBytes(path)
                if not re.fullmatch(prefix + r'[1-9][0-9]*\.json', path.name):
                    raise ValueError()
                if ownIntent is not None and path == ownIntent[0]:
                    if raw != ownIntent[1]:
                        raise ValueError()
                    ownFound = True
                    continue
                value = boundaryIntent(raw)
                if not isinstance(value, dict) or value.get('state') not in accepted:
                    raise ValueError()
        if not ownFound:
            raise ValueError()
    except Exception:
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED') from None
    if (private / 'STOP').exists():
        raise RuntimeError('BROWSER_RECEIPT_STOP_REQUESTED')
    if (private / 'http-cleanup-blocked.json').exists():
        raise RuntimeError('BROWSER_RECEIPT_CLEANUP_PENDING')
    try:
        if hashlib.sha256(boundaryBytes(private / 'plan.json')).hexdigest() != planSha256:
            raise ValueError()
    except Exception:
        raise RuntimeError('BROWSER_RECEIPT_PLAN_CHANGED') from None


def verify(root, orderId, audit, attemptId, basis=None, httpAudit=None):
    """无网络容器只读重验，输出仅留私密内存。"""
    name = 'apple-browser-receipt-verify-' + attemptId
    command = [
        'docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
        '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '256m', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,size=33554432',
        '-e', 'NODE_PATH=/research/node_modules', '-v', str(root) + ':/research:ro',
        '-v', str(root / 'deps') + ':/research/node_modules:ro', '--entrypoint', 'node', IMAGE,
        '/research/release/scripts/officialPickupBackfill/verifyBrowserReceipt.js',
        '/research', str(orderId), audit,
    ]
    if basis is not None:
        command.extend([basis, httpAudit])
    try:
        result = call(command, timeout=30)
    finally:
        try:
            call(['docker', 'rm', '-f', name], timeout=15)
        except Exception:
            pass
    if result.returncode:
        raise RuntimeError(safeCode(result.stderr.decode('utf-8', errors='replace').strip()))
    if len(result.stdout) > MAX_BYTES:
        raise RuntimeError('BROWSER_RECEIPT_PAYLOAD_TOO_LARGE')
    try:
        payload = json.loads(result.stdout.decode('utf-8'))
    except (ValueError, UnicodeError):
        raise RuntimeError('BROWSER_RECEIPT_OUTPUT_INVALID')
    if (not isinstance(payload, dict) or payload.get('entry', {}).get('id') != orderId or
            payload.get('receipt', {}).get('browserAuditFile') != audit):
        raise RuntimeError('BROWSER_RECEIPT_OUTPUT_INVALID')
    return payload


PRELUDE = r'''
if (process.env.NODE_ENV !== 'production' || !process.env.DB_HOST || !process.env.DB_NAME ||
    /research|study/i.test(process.env.DB_HOST + ' ' + process.env.DB_NAME)) {
  process.stdout.write(JSON.stringify({outcome:'BROWSER_RECEIPT_DATABASE_INVALID'})+'\n');
  process.exit(1);
}
const observed = Date.parse(PAYLOAD.receipt.observedAt);
if (!Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 300000) {
  process.stdout.write(JSON.stringify({outcome:'BROWSER_RECEIPT_EXPIRED'})+'\n');
  process.exit(1);
}
'''


def bind(root, payload, beforeStart=None):
    """既有 binder 仅通过正式 API stdin 执行，不改业务代码或重新实现绑定逻辑。"""
    binder = (root / 'release/scripts/officialPickupBackfill/bindReceipt.js').read_text(encoding='utf-8')
    script = ('const PAYLOAD=' + json.dumps(payload, ensure_ascii=True, allow_nan=False) + ';\n' +
              PRELUDE + '\n' + binder).encode('utf-8')
    if beforeStart is not None:
        beforeStart()
    result = call(['docker', 'exec', '-i', API_CONTAINER, 'node', '-'], input=script, timeout=90)
    if result.returncode or len(result.stdout) > MAX_BYTES:
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
    try:
        return json.loads(result.stdout.decode('utf-8'))
    except (ValueError, UnicodeError):
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')


def validateBound(result, payload):
    """非事务整单 binder 只有完整成功且所有摘要一致才可关闭意图。"""
    receipt = payload['receipt']
    serials = sorted(item['serialNumber'] for item in payload['parsed']['items'])
    serialHash = hashlib.sha256(json.dumps(serials, separators=(',', ':')).encode('utf-8')).hexdigest()
    if (not isinstance(result, dict) or result.get('outcome') != 'SERIALS_VERIFIED' or
            result.get('orderId') != payload['entry']['id'] or result.get('receiptRunId') != receipt['runId'] or
            result.get('receiptSha256') != receipt['sha256'] or result.get('detailSha256') != receipt['detailSha256'] or
            result.get('serialCount') != len(serials) or result.get('serialsHash') != serialHash or
            type(result.get('newBindings')) is not int or not 0 <= result['newBindings'] <= len(serials) or
            not validInt(result.get('actorUserId')) or not isinstance(result.get('deviceIds'), list) or
            len(result['deviceIds']) != len(serials) or
            any(not validDeviceId(value) for value in result['deviceIds']) or
            len(set(result['deviceIds'])) != len(serials) or
            not re.fullmatch(r'[a-f0-9]{32}', result.get('orderBeforeHash', '')) or
            result.get('orderBeforeHash') != result.get('orderAfterHash') or
            result.get('manualPickupUnchanged') is not True or result.get('inventoryReceiveCreated') is not False):
        raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--audit', required=True)
    parser.add_argument('--basis')
    parser.add_argument('--http-source-audit')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = pathlib.Path(args.root)
    match = re.fullmatch(r'browser-sample-([1-9][0-9]*)-([a-f0-9]{32})\.json', args.audit)
    summary = {'outcome': 'BROWSER_RECEIPT_FAILED', 'mode': 'apply' if args.apply else 'dry-run',
               'businessWrites': 0, 'businessWriteCountKnown': True}
    locks = []
    applying = False
    attemptId = uuid.uuid4().hex
    private = None
    try:
        if (not root.is_absolute() or not match or not (root / 'private').is_dir() or
                ((args.basis is None) != (args.http_source_audit is None)) or
                (args.basis is not None and (not safeName(args.basis) or not safeName(args.http_source_audit)))):
            raise RuntimeError('BROWSER_RECEIPT_ARGUMENT_INVALID')
        root = root.resolve()
        private = root / 'private'
        planSha256 = hashlib.sha256(boundaryBytes(private / 'plan.json')).hexdigest()
        orderId = int(match.group(1))
        summary['orderId'] = orderId
        checkBoundary(root, planSha256)
        # 与采样和 HTTP 回写共用锁，私密输入在核验至绑定结束间不得被另一轮覆盖。
        for name in ('http-sample.lock', 'http-apply.lock'):
            lock = open(str(private / name), 'a', encoding='utf-8')
            locks.append(lock)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('BROWSER_RECEIPT_BUSY')
        checkBoundary(root, planSha256)
        intentFile = private / ('browser-receipt-bind-intent-' + str(orderId) + '.json')
        if intentFile.exists():
            previous = readPrivate(intentFile)
            if previous.get('state') != 'APPLIED':
                raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
            if args.apply and previous.get('sourceAudit') == args.audit:
                if not safeName(previous.get('auditFile')):
                    raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
                saved = readPrivate(private / previous['auditFile'])
                if saved.get('outcome') != 'SERIALS_VERIFIED' or saved.get('orderId') != orderId:
                    raise RuntimeError('MANUAL_RECONCILIATION_REQUIRED')
                summary.update({name: saved[name] for name in PUBLIC_FIELDS if name in saved})
                summary.update(outcome='SERIALS_VERIFIED', replayed=True, businessWrites=0,
                               auditFile=previous['auditFile'])
                checkBoundary(root, planSha256)
                return summary
        payload = verify(root, orderId, args.audit, attemptId, args.basis, args.http_source_audit)
        checkBoundary(root, planSha256)
        prefix = 'browser-receipt-bind-' + str(orderId) + '-' + attemptId
        payloadFile = private / (prefix + '-payload.json')
        resultFile = private / (prefix + '-result.json')
        auditFile = private / (prefix + '-audit.json')
        writePrivate(payloadFile, payload)
        summary.update(payloadFile=payloadFile.name, auditFile=auditFile.name,
                       serialCount=len(payload['parsed']['items']), receiptRunId=payload['receipt']['runId'],
                       receiptSha256=payload['receipt']['sha256'], detailSha256=payload['receipt']['detailSha256'])
        checkBoundary(root, planSha256)
        if not args.apply:
            summary['outcome'] = 'DRY_RUN'
            writePrivate(auditFile, summary)
            checkBoundary(root, planSha256)
            return summary
        intent = {'state': 'APPLY_STARTED', 'sourceAudit': args.audit, 'attemptId': attemptId,
                  'orderId': orderId, 'receiptRunId': payload['receipt']['runId'],
                  'receiptSha256': payload['receipt']['sha256'], 'payloadFile': payloadFile.name,
                  'resultFile': resultFile.name, 'auditFile': auditFile.name,
                  'payloadSha256': hashlib.sha256(payloadFile.read_bytes()).hexdigest(),
                  'startedAt': time.time()}
        ownIntent = (intentFile, json.dumps(intent, ensure_ascii=True, allow_nan=False).encode('utf-8'))
        checkBoundary(root, planSha256)
        writePrivate(intentFile, intent)
        applying = True
        checkBoundary(root, planSha256, ownIntent)
        result = bind(root, payload, lambda: checkBoundary(root, planSha256, ownIntent))
        writePrivate(resultFile, result)
        validateBound(result, payload)
        summary.update({name: result[name] for name in PUBLIC_FIELDS if name in result})
        # 既有 binder 的 newBindings 只统计新增设备；补 stockUnit 桥接也可能写库。
        # 本封装不猜多表写入计数，完整成功只证明绑定结果及不变项。
        summary.update(resultFile=resultFile.name, businessWrites=None, businessWriteCountKnown=False)
        writePrivate(auditFile, summary)
        writePrivate(intentFile, dict(intent, state='APPLIED'))
        applying = False
        return summary
    except Exception as error:
        summary['outcome'] = 'MANUAL_RECONCILIATION_REQUIRED' if applying or str(error) == 'MANUAL_RECONCILIATION_REQUIRED' else safeCode(str(error))
        if summary['outcome'] == 'MANUAL_RECONCILIATION_REQUIRED':
            summary['businessWrites'] = None
            summary['businessWriteCountKnown'] = False
        if private is not None:
            try:
                errorFile = private / ('browser-receipt-bind-error-' + attemptId + '.json')
                summary['auditFile'] = errorFile.name
                writePrivate(errorFile, summary)
            except Exception:
                pass
        return summary
    finally:
        for lock in reversed(locks):
            lock.close()
        print(json.dumps(summary, ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
