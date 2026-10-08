"""浏览器收据绑定封装测试：所有外部命令及绑定均 mock，无官网或生产操作。"""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT_DIR = pathlib.Path(__file__).parents[1] / 'scripts/officialOrder'
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location('browser_receipt_apply', SCRIPT_DIR / 'applyBrowserReceipt.py')
sample = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sample)


class BrowserReceiptApplyTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name).resolve()
        (self.root / 'private').mkdir()
        self.plan = self.root / 'private/plan.json'
        sample.writePrivate(self.plan, {'schemaVersion': 3, 'scope': 'missing-fields'})
        self.audit = 'browser-sample-11-' + 'a' * 32 + '.json'
        self.payload = {'startedAt': '2026-10-08T00:00:00.000Z', 'scope': 'missing-fields',
                        'schemaVersion': 3, 'cutoff': None,
                        'entry': {'id': 11, 'orderNumber': 'W1234567890'},
                        'receipt': {'runId': 26, 'detailRun': 25, 'sha256': 'b' * 64,
                                    'detailSha256': 'c' * 64, 'browserAuditFile': self.audit},
                        'parsed': {'items': [{'serialNumber': 'A123456789'}, {'serialNumber': 'B123456789'}]}}
        self.bound = {'orderId': 11, 'outcome': 'SERIALS_VERIFIED', 'serialCount': 2, 'newBindings': 2,
                      'serialsHash': hashlib.sha256(b'["A123456789","B123456789"]').hexdigest(),
                      'deviceIds': ['12345678-1234-4234-8234-123456789abc',
                                    '23456789-2345-4345-9345-23456789abcd'],
                      'actorUserId': 1, 'receiptRunId': 26,
                      'receiptSha256': 'b' * 64, 'detailSha256': 'c' * 64,
                      'orderBeforeHash': 'd' * 32, 'orderAfterHash': 'd' * 32,
                      'manualPickupUnchanged': True, 'inventoryReceiveCreated': False}
        self.originalVerify = sample.verify
        self.originalBind = sample.bind
        self.verifyPatch = patch.object(sample, 'verify', return_value=self.payload)
        self.verifyMock = self.verifyPatch.start()
        self.bindPatch = patch.object(sample, 'bind', return_value=self.bound)
        self.bindMock = self.bindPatch.start()
        self.intent = self.root / 'private/browser-receipt-bind-intent-11.json'

    def tearDown(self):
        self.bindPatch.stop()
        self.verifyPatch.stop()
        self.temporary.cleanup()

    def runMain(self, apply=False, extra=None):
        args = ['applyBrowserReceipt.py', '--root', str(self.root), '--audit', self.audit]
        if apply:
            args.append('--apply')
        args.extend(extra or [])
        output = io.StringIO()
        with patch.object(sys, 'argv', args), contextlib.redirect_stdout(output):
            result = sample.main()
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertNotIn('W1234567890', output.getvalue())
        self.assertNotIn('A123456789', output.getvalue())
        return result

    def testDefaultDryRunOnlyVerifiesAndSavesPrivatePayload(self):
        result = self.runMain()
        self.assertEqual(result['outcome'], 'DRY_RUN')
        self.assertEqual(result['businessWrites'], 0)
        self.assertFalse(self.intent.exists())
        self.bindMock.assert_not_called()
        saved = self.root / 'private' / result['payloadFile']
        self.assertEqual(json.loads(saved.read_text()), self.payload)
        self.assertEqual(saved.stat().st_mode & 0o077, 0)

    def changeBoundary(self, kind):
        if kind == 'stop':
            (self.root / 'private/STOP').touch()
        elif kind == 'cleanup':
            sample.writePrivate(self.root / 'private/http-cleanup-blocked.json', {'outcome': 'PENDING'})
        elif kind == 'plan':
            # 内容含义不变也必须拒绝，合同固定原文字节而非重序列化后的摘要。
            self.plan.write_bytes(self.plan.read_bytes() + b' ')
        elif kind == 'http-unknown':
            sample.writePrivate(self.root / 'private/http-apply-intent-22.json', {'state': 'APPLY_STARTED'})
        elif kind == 'browser-unknown':
            sample.writePrivate(self.root / 'private/browser-receipt-bind-intent-22.json', {'state': 'APPLY_STARTED'})

    def clearBoundary(self):
        for name in ('STOP', 'http-cleanup-blocked.json', 'http-apply-intent-22.json',
                     'browser-receipt-bind-intent-22.json', self.intent.name):
            path = self.root / 'private' / name
            if path.exists():
                path.unlink()

    def testInitialStopOrCleanupPreventsVerification(self):
        for kind, code in (('stop', 'BROWSER_RECEIPT_STOP_REQUESTED'),
                           ('cleanup', 'BROWSER_RECEIPT_CLEANUP_PENDING')):
            with self.subTest(kind=kind):
                self.clearBoundary()
                self.changeBoundary(kind)
                result = self.runMain(True)
                self.assertEqual(result['outcome'], code)
                self.assertEqual(result['businessWrites'], 0)
                self.assertFalse(self.intent.exists())
        self.verifyMock.assert_not_called()
        self.bindMock.assert_not_called()

    def testVerifyWindowChangesPreventApplyAndDryRunSuccess(self):
        for apply in (False, True):
            for kind, code in (('stop', 'BROWSER_RECEIPT_STOP_REQUESTED'),
                               ('cleanup', 'BROWSER_RECEIPT_CLEANUP_PENDING'),
                               ('plan', 'BROWSER_RECEIPT_PLAN_CHANGED'),
                               ('http-unknown', 'MANUAL_RECONCILIATION_REQUIRED'),
                               ('browser-unknown', 'MANUAL_RECONCILIATION_REQUIRED')):
                with self.subTest(apply=apply, kind=kind):
                    self.clearBoundary()
                    def verify(*_args):
                        self.changeBoundary(kind)
                        return self.payload
                    self.verifyMock.side_effect = verify
                    result = self.runMain(apply)
                    self.assertEqual(result['outcome'], code)
                    self.assertFalse(self.intent.exists())
                    self.assertNotIn('payloadFile', result)
        self.bindMock.assert_not_called()

    def testPayloadPersistenceBoundaryPreventsIntent(self):
        original = sample.writePrivate
        for kind, code in (('stop', 'BROWSER_RECEIPT_STOP_REQUESTED'),
                           ('cleanup', 'BROWSER_RECEIPT_CLEANUP_PENDING'),
                           ('plan', 'BROWSER_RECEIPT_PLAN_CHANGED')):
            with self.subTest(kind=kind):
                self.clearBoundary()
                def write(path, value):
                    original(path, value)
                    if path.name.endswith('-payload.json'):
                        self.changeBoundary(kind)
                with patch.object(sample, 'writePrivate', side_effect=write):
                    result = self.runMain(True)
                self.assertEqual(result['outcome'], code)
                self.assertEqual(result['businessWrites'], 0)
                self.assertFalse(self.intent.exists())
        self.bindMock.assert_not_called()

    def testIntentPersistenceBoundaryRetainsUnknownIntentWithoutBinder(self):
        original = sample.writePrivate
        for kind in ('stop', 'cleanup', 'plan', 'http-unknown', 'browser-unknown'):
            with self.subTest(kind=kind):
                self.clearBoundary()
                def write(path, value):
                    original(path, value)
                    if path == self.intent and value['state'] == 'APPLY_STARTED':
                        self.changeBoundary(kind)
                with patch.object(sample, 'writePrivate', side_effect=write):
                    result = self.runMain(True)
                self.assertEqual(result['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
                self.assertIsNone(result['businessWrites'])
                self.assertFalse(result['businessWriteCountKnown'])
                self.assertEqual(sample.readPrivate(self.intent)['state'], 'APPLY_STARTED')
        self.bindMock.assert_not_called()

    def testOwnIntentExceptionRequiresExactOriginalBytes(self):
        original = sample.writePrivate
        for kind in ('whitespace', 'state', 'missing'):
            with self.subTest(kind=kind):
                self.clearBoundary()
                def write(path, value):
                    original(path, value)
                    if path == self.intent and value['state'] == 'APPLY_STARTED':
                        if kind == 'whitespace':
                            path.write_bytes(path.read_bytes() + b' ')
                        elif kind == 'state':
                            original(path, dict(value, state='APPLIED'))
                        else:
                            path.unlink()
                with patch.object(sample, 'writePrivate', side_effect=write):
                    result = self.runMain(True)
                self.assertEqual(result['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
                self.assertIsNone(result['businessWrites'])
        self.bindMock.assert_not_called()

    def testGlobalUnknownIntentBlocksBeforeVerifier(self):
        for name, value in (('http-apply-intent-22.json', {'state': 'APPLY_STARTED'}),
                            ('http-apply-intent-22.json', {'state': 'UNKNOWN'}),
                            ('browser-receipt-bind-intent-22.json', {'state': 'ROLLED_BACK'}),
                            ('browser-receipt-bind-intent-22.json', {'state': 'APPLY_STARTED'})):
            with self.subTest(name=name, value=value):
                self.clearBoundary()
                sample.writePrivate(self.root / 'private' / name, value)
                self.assertEqual(self.runMain(True)['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
                self.assertFalse(self.intent.exists())
        self.verifyMock.assert_not_called()
        self.bindMock.assert_not_called()

    def testAmbiguousIntentAppearingDuringVerifyNeverReachesBinder(self):
        for name in ('http-apply-intent-22.json', 'browser-receipt-bind-intent-22.json'):
            for raw in (b'{"state":"APPLY_STARTED","state":"APPLIED"}',
                        b'{"state":"APPLIED","meta":{"key":1,"key":2}}',
                        b'{"state":"APPLIED","at":NaN}',
                        b'{"state":"APPLIED","at":Infinity}',
                        b'{"state":"APPLIED","at":-Infinity}'):
                with self.subTest(name=name, raw=raw):
                    self.clearBoundary()
                    def verify(*_args):
                        path = self.root / 'private' / name
                        sample.writePrivate(path, {'state': 'APPLIED'})
                        path.write_bytes(raw)
                        return self.payload
                    self.verifyMock.side_effect = verify
                    result = self.runMain(True)
                    self.assertEqual(result['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
                    self.assertFalse(self.intent.exists())
                    self.assertNotIn('payloadFile', result)
        self.bindMock.assert_not_called()

    def testKnownHistoricalIntentsDoNotBlockCurrentOwnIntent(self):
        for state in ('APPLIED', 'ROLLED_BACK'):
            with self.subTest(state=state):
                self.clearBoundary()
                sample.writePrivate(self.root / 'private/http-apply-intent-22.json', {'state': state})
                sample.writePrivate(self.root / 'private/browser-receipt-bind-intent-22.json', {'state': 'APPLIED'})
                self.assertEqual(self.runMain(True)['outcome'], 'SERIALS_VERIFIED')
        self.assertEqual(self.bindMock.call_count, 2)

    def testDryRunPersistenceStopCannotReportSuccess(self):
        original = sample.writePrivate
        def write(path, value):
            original(path, value)
            if path.name.endswith('-audit.json') and value.get('outcome') == 'DRY_RUN':
                self.changeBoundary('stop')
        with patch.object(sample, 'writePrivate', side_effect=write):
            result = self.runMain()
        self.assertEqual(result['outcome'], 'BROWSER_RECEIPT_STOP_REQUESTED')
        self.assertFalse(self.intent.exists())
        self.bindMock.assert_not_called()

    def testStopAfterBinderStartedPreservesConfirmedResultWithoutRetry(self):
        def bind(*_args):
            self.changeBoundary('stop')
            return self.bound
        self.bindMock.side_effect = bind
        result = self.runMain(True)
        self.assertEqual(result['outcome'], 'SERIALS_VERIFIED')
        self.assertEqual(sample.readPrivate(self.intent)['state'], 'APPLIED')
        self.assertEqual(self.bindMock.call_count, 1)

    def testReplayCannotBypassStop(self):
        self.runMain(True)
        self.bindMock.reset_mock()
        self.verifyMock.reset_mock()
        self.changeBoundary('stop')
        self.assertEqual(self.runMain(True)['outcome'], 'BROWSER_RECEIPT_STOP_REQUESTED')
        self.bindMock.assert_not_called()
        self.verifyMock.assert_not_called()

    def testApplyRequiresPersistedPayloadAndIntentBeforeBinder(self):
        def bind(*_args):
            intent = sample.readPrivate(self.intent)
            self.assertEqual(intent['state'], 'APPLY_STARTED')
            payload = self.root / 'private' / intent['payloadFile']
            self.assertEqual(intent['payloadSha256'], hashlib.sha256(payload.read_bytes()).hexdigest())
            self.assertEqual(sample.readPrivate(payload), self.payload)
            return self.bound
        self.bindMock.side_effect = bind
        result = self.runMain(True)
        self.assertEqual(result['outcome'], 'SERIALS_VERIFIED')
        self.assertEqual(result['newBindings'], 2)
        self.assertIsNone(result['businessWrites'])
        self.assertFalse(result['businessWriteCountKnown'])
        self.assertEqual(sample.readPrivate(self.intent)['state'], 'APPLIED')
        self.assertEqual(sample.readPrivate(self.root / 'private' / result['resultFile']), self.bound)

    def testExistingDeviceMayNeedStockBridgeSoZeroNewBindingsIsNotZeroWrites(self):
        self.bound['newBindings'] = 0
        result = self.runMain(True)
        self.assertEqual(result['outcome'], 'SERIALS_VERIFIED')
        self.assertEqual(result['newBindings'], 0)
        self.assertIsNone(result['businessWrites'])
        self.assertFalse(result['businessWriteCountKnown'])

    def testSuccessfulReplayDoesNotVerifyOrBindAgain(self):
        self.runMain(True)
        self.verifyMock.reset_mock()
        self.bindMock.reset_mock()
        result = self.runMain(True)
        self.assertTrue(result['replayed'])
        self.assertEqual(result['businessWrites'], 0)
        self.verifyMock.assert_not_called()
        self.bindMock.assert_not_called()

    def testBinderExceptionLeavesDurableIntentAndBlocksLaterAttempts(self):
        self.bindMock.side_effect = TimeoutError('private backend detail')
        result = self.runMain(True)
        self.assertEqual(result['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertIsNone(result['businessWrites'])
        self.assertEqual(sample.readPrivate(self.intent)['state'], 'APPLY_STARTED')
        self.bindMock.reset_mock()
        self.assertEqual(self.runMain(True)['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.bindMock.assert_not_called()

    def testPartialAndZeroReportedBindingsCannotProveRollback(self):
        for count in (0, 1):
            with self.subTest(newBindings=count):
                if self.intent.exists():
                    self.intent.unlink()
                self.bindMock.return_value = {'orderId': 11, 'outcome': 'BIND_FAILED', 'newBindings': count}
                result = self.runMain(True)
                self.assertEqual(result['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
                self.assertEqual(sample.readPrivate(self.intent)['state'], 'APPLY_STARTED')

    def testSuccessButResultPersistenceFailureRemainsUnknown(self):
        original = sample.writePrivate
        def write(path, value):
            if path.name.endswith('-result.json'):
                raise OSError('disk-full')
            original(path, value)
        with patch.object(sample, 'writePrivate', side_effect=write):
            result = self.runMain(True)
        self.assertEqual(result['outcome'], 'MANUAL_RECONCILIATION_REQUIRED')
        self.assertEqual(sample.readPrivate(self.intent)['state'], 'APPLY_STARTED')

    def testPayloadPersistenceFailurePreventsBinder(self):
        with patch.object(sample, 'writePrivate', side_effect=OSError('disk-full')):
            self.assertEqual(self.runMain(True)['businessWrites'], 0)
        self.bindMock.assert_not_called()

    def testIntentPersistenceFailurePreventsBinder(self):
        original = sample.writePrivate
        def write(path, value):
            if path.name == self.intent.name:
                raise OSError('disk-full')
            original(path, value)
        with patch.object(sample, 'writePrivate', side_effect=write):
            self.assertEqual(self.runMain(True)['businessWrites'], 0)
        self.bindMock.assert_not_called()

    def testBasisAndHttpAuditMustBePaired(self):
        result = self.runMain(True, ['--basis', 'basis.json'])
        self.assertEqual(result['outcome'], 'BROWSER_RECEIPT_ARGUMENT_INVALID')
        self.verifyMock.assert_not_called()
        self.bindMock.assert_not_called()

    def testTraversalArgumentRejectedBeforeVerifier(self):
        result = self.runMain(True, ['--basis', '../basis.json', '--http-source-audit', 'http.json'])
        self.assertEqual(result['outcome'], 'BROWSER_RECEIPT_ARGUMENT_INVALID')
        self.verifyMock.assert_not_called()

    def testBasisPassedExplicitlyToReadonlyVerifier(self):
        self.runMain(extra=['--basis', 'basis.json', '--http-source-audit', 'http.json'])
        self.assertEqual(self.verifyMock.call_args[0][-2:], ('basis.json', 'http.json'))

    def testSharedBusyLockPreventsVerificationAndBinding(self):
        with patch.object(sample.fcntl, 'flock', side_effect=BlockingIOError()):
            self.assertEqual(self.runMain(True)['outcome'], 'BROWSER_RECEIPT_BUSY')
        self.verifyMock.assert_not_called()
        self.bindMock.assert_not_called()

    def testVerifyFailureCannotCreateApplyIntent(self):
        self.verifyMock.side_effect = RuntimeError('BROWSER_RECEIPT_HASH_INVALID')
        self.assertEqual(self.runMain(True)['outcome'], 'BROWSER_RECEIPT_HASH_INVALID')
        self.assertFalse(self.intent.exists())
        self.bindMock.assert_not_called()

    def testSuccessIdentityAndInvariantFieldsAreAllValidated(self):
        for field, value in [('orderId', 12), ('receiptRunId', 30), ('receiptSha256', '0' * 64),
                             ('detailSha256', '0' * 64), ('serialCount', 1), ('serialsHash', '0' * 64),
                             ('newBindings', -1), ('actorUserId', None), ('deviceIds', [1, 1]),
                             ('orderAfterHash', '0' * 32), ('manualPickupUnchanged', False),
                             ('inventoryReceiveCreated', True)]:
            with self.subTest(field=field):
                valueResult = dict(self.bound, **{field: value})
                with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
                    sample.validateBound(valueResult, self.payload)

    def testRealUuidDevicePrimaryKeysAreAccepted(self):
        sample.validateBound(self.bound, self.payload)
        result = self.runMain(True)
        self.assertEqual(result['outcome'], 'SERIALS_VERIFIED')
        self.assertEqual(result['deviceIds'], self.bound['deviceIds'])
        self.assertEqual(json.loads(self.intent.read_text())['state'], 'APPLIED')

    def testInvalidAndDuplicateDeviceIdsCannotCloseIntent(self):
        first = self.bound['deviceIds'][0]
        for ids in ([first, first], [1, 2], [True, False], [first, 'invalid'],
                    [first, first.upper()], [first, first.replace('-', '')],
                    [first, '{' + first + '}'], [first, '00000000-0000-0000-0000-000000000000'],
                    [first, {}], [first, None]):
            with self.subTest(ids=ids):
                with self.assertRaisesRegex(RuntimeError, 'MANUAL_RECONCILIATION_REQUIRED'):
                    sample.validateBound(dict(self.bound, deviceIds=ids), self.payload)

    def testBindSubprocessUsesOnlyStdinAndCurrentBinder(self):
        directory = self.root / 'release/scripts/officialPickupBackfill'
        directory.mkdir(parents=True)
        (directory / 'bindReceipt.js').write_text('/* existing-binder-sentinel */')
        commandResult = SimpleNamespace(returncode=0, stdout=json.dumps(self.bound).encode(), stderr=b'')
        with patch.object(sample, 'call', return_value=commandResult) as call:
            self.assertEqual(self.originalBind(self.root, self.payload), self.bound)
            args = call.call_args
            self.assertEqual(args[0][0], ['docker', 'exec', '-i', sample.API_CONTAINER, 'node', '-'])
            self.assertIn(b'existing-binder-sentinel', args[1]['input'])
            self.assertIn(b'Date.now() - observed > 300000', args[1]['input'])
            self.assertNotIn('A123456789', str(args[0]))

    def testLastBoundaryRunsAfterReadingBinderBeforeSubprocess(self):
        directory = self.root / 'release/scripts/officialPickupBackfill'
        directory.mkdir(parents=True)
        binder = directory / 'bindReceipt.js'
        binder.write_text('/* existing-binder-sentinel */')
        planSha = hashlib.sha256(self.plan.read_bytes()).hexdigest()
        original = pathlib.Path.read_text
        def read(path, **kwargs):
            value = original(path, **kwargs)
            if path == binder:
                self.changeBoundary('stop')
            return value
        with patch.object(pathlib.Path, 'read_text', read), patch.object(sample, 'call') as call:
            with self.assertRaisesRegex(RuntimeError, 'BROWSER_RECEIPT_STOP_REQUESTED'):
                self.originalBind(self.root, self.payload, lambda: sample.checkBoundary(self.root, planSha))
            call.assert_not_called()

    def testVerifierRunsWithoutNetworkAndReadOnlyMount(self):
        result = SimpleNamespace(returncode=0, stdout=json.dumps(self.payload).encode(), stderr=b'')
        with patch.object(sample, 'call', return_value=result) as call:
            self.assertEqual(self.originalVerify(self.root, 11, self.audit, 'a' * 32), self.payload)
            command = call.call_args_list[0][0][0]
            self.assertEqual(command[command.index('--network') + 1], 'none')
            self.assertIn('--read-only', command)
            self.assertIn(str(self.root) + ':/research:ro', command)
            self.assertEqual(call.call_args_list[-1][0][0][:3], ['docker', 'rm', '-f'])


@unittest.skipUnless(shutil.which('node'), '需要本地 Node 离线执行私密输入前置校验')
class PreludeTests(unittest.TestCase):
    def execute(self, observedExpression, environment=None):
        script = ('const PAYLOAD={receipt:{observedAt:' + observedExpression + '}};\n' + sample.PRELUDE +
                  '\nprocess.stdout.write("BINDER_SENTINEL");')
        env = {'NODE_ENV': 'production', 'DB_HOST': 'fake-business', 'DB_NAME': 'business'}
        env.update(environment or {})
        return subprocess.run([shutil.which('node'), '-'], input=script.encode(), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=env, timeout=5)

    def testExpiredFutureOrInvalidObservationNeverExecutesBinder(self):
        for expression in ('new Date(Date.now()-300001).toISOString()',
                           'new Date(Date.now()+60000).toISOString()', '"invalid"'):
            with self.subTest(expression=expression):
                result = self.execute(expression)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout)['outcome'], 'BROWSER_RECEIPT_EXPIRED')
                self.assertNotIn(b'BINDER_SENTINEL', result.stdout)

    def testResearchOrNonProductionEnvironmentNeverExecutesBinder(self):
        for environment in ({'NODE_ENV': 'test'}, {'DB_HOST': 'study-postgres'}, {'DB_NAME': ''}):
            with self.subTest(environment=environment):
                result = self.execute('new Date().toISOString()', environment)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout)['outcome'], 'BROWSER_RECEIPT_DATABASE_INVALID')

    def testFreshVerifiedPayloadCanReachSentinelWithoutAnyBusinessCode(self):
        result = self.execute('new Date().toISOString()')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'BINDER_SENTINEL')


if __name__ == '__main__':
    unittest.main()
