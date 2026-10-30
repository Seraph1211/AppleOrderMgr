import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'productionRelease.py'
SPEC = importlib.util.spec_from_file_location('productionReleaseExecutor', MODULE_PATH)
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)


def writeJson(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding='utf-8')


class ProductionReleaseExecutorTest(unittest.TestCase):
    def plan(self, root):
        baseline = root / 'baseline.json'
        components = {'api': {'expectedVersion': 'old', 'targetVersion': 'new'}}
        writeJson(baseline, {
            'passed': True,
            'releaseId': 'release-1',
            'components': components,
        })
        return {
            'schemaVersion': 1,
            'releaseId': 'release-1',
            'attemptId': 'attempt-1',
            'evidenceDir': str(root / 'evidence'),
            'lockPath': str(root / 'release.lock'),
            'sourceDigest': 'a' * 64,
            'baselineDigest': hashlib.sha256(baseline.read_bytes()).hexdigest(),
            'baselineEvidence': str(baseline),
            'frontend': {
                'gateScript': '/gate.py',
                'candidate': '/releases/new',
                'current': '/releases/current',
                'expectedCurrent': '/releases/old',
                'nginxUser': '33:33',
                'nginxUsers': ['33:33', '997:995'],
                'baseUrl': 'https://example.test',
            },
            'components': components,
            'resumeChecks': [['resume-check']],
            'steps': [
                {
                    'id': 'frontend-prepare', 'stage': 'prepare',
                    'type': 'frontendPrepare', 'requiresReleaseLock': True,
                    'resumeSafe': True,
                },
                {
                    'id': 'frontend-check', 'stage': 'prepare',
                    'type': 'frontendCheck', 'requiresReleaseLock': True,
                    'resumeSafe': True,
                },
                {
                    'id': 'api-switch', 'stage': 'switch', 'type': 'command',
                    'argv': ['api-switch'], 'rollback': [['api-rollback']],
                    'reconcileCompleted': ['api-is-new'],
                    'reconcileRolledBack': ['api-is-old'],
                    'requiresReleaseLock': True, 'mutatesComponents': ['api'],
                },
                {
                    'id': 'frontend-switch', 'stage': 'switch',
                    'type': 'frontendSwitch', 'requiresReleaseLock': True,
                    'mutatesComponents': ['frontend'],
                    'reconcileCompleted': ['frontend-is-new'],
                    'reconcileRolledBack': ['frontend-is-old'],
                },
                {
                    'id': 'frontend-verify', 'stage': 'verify',
                    'type': 'frontendVerify', 'requiresReleaseLock': True,
                },
            ],
        }

    def prepareUnknownState(self, plan, root, step='api-switch', outcome='completed'):
        state = {
            'schemaVersion': 1,
            'releaseId': plan['releaseId'],
            'attemptId': plan['attemptId'],
            'planDigest': RELEASE.sha256Bytes(RELEASE.canonicalBytes(plan)),
            'sourceDigest': plan['sourceDigest'],
            'baselineDigest': plan['baselineDigest'],
            'completedSteps': ['frontend-prepare', 'frontend-check'],
            'status': 'running',
            'pendingMutation': step,
        }
        statePath = Path(plan['evidenceDir']) / 'release-state.json'
        writeJson(statePath, state)
        evidencePath = root / 'reconciliation.json'
        writeJson(evidencePath, {
            'passed': True,
            'step': step,
            'outcome': outcome,
            'releaseId': plan['releaseId'],
            'attemptId': plan['attemptId'],
            'planDigest': RELEASE.sha256Bytes(RELEASE.canonicalBytes(plan)),
            'sourceDigest': plan['sourceDigest'],
            'baselineDigest': plan['baselineDigest'],
            'components': plan['components'],
        })
        return statePath, evidencePath

    def unchangedPlan(self, root):
        plan = self.plan(root)
        plan = json.loads(json.dumps(plan))
        plan['frontendPointerMode'] = 'unchanged'
        plan['frontend']['candidate'] = plan['frontend']['expectedCurrent']
        plan['components'] = {
            'api': {'expectedVersion': 'old', 'targetVersion': 'old'},
            'frontend': {'expectedVersion': 'old', 'targetVersion': 'old'},
            'queueWriter': {'expectedVersion': '1', 'targetVersion': '2'},
        }
        plan['steps'] = [
            step for step in plan['steps'] if step['type'] != 'frontendSwitch'
        ]
        mutation = next(
            step for step in plan['steps'] if step['id'] == 'api-switch')
        mutation['id'] = 'queue-writer'
        mutation['argv'] = ['queue-writer-2']
        mutation['rollback'] = [['queue-writer-1']]
        mutation['reconcileCompleted'] = ['queue-writer-is-2']
        mutation['reconcileRolledBack'] = ['queue-writer-is-1']
        mutation['mutatesComponents'] = ['queueWriter']
        return plan

    def test_unknown_mutation_is_reconciled_before_resume_checks(self):
        with tempfile.TemporaryDirectory(prefix='release-resolution-') as temporary:
            root = Path(temporary)
            plan = self.plan(root)
            RELEASE.validatePlan(plan)
            statePath, evidencePath = self.prepareUnknownState(plan, root)
            commands = []

            def run(command, **_kwargs):
                commands.append(command)
                return mock.Mock(returncode=0)

            with mock.patch.object(RELEASE.subprocess, 'run', side_effect=run):
                result = RELEASE.resolveUnknownMutation(
                    plan, 'completed', str(evidencePath))
            self.assertTrue(result['passed'])
            self.assertEqual(commands, [['api-is-new'], ['resume-check']])
            state = json.loads(statePath.read_text(encoding='utf-8'))
            self.assertIsNone(state['pendingMutation'])
            self.assertIn('api-switch', state['completedSteps'])
            self.assertTrue(state['mutationResolution']['resumeChecksPassed'])

    def test_post_resolution_check_failure_preserves_auditable_outcome(self):
        with tempfile.TemporaryDirectory(prefix='release-resolution-failed-') as temporary:
            root = Path(temporary)
            plan = self.plan(root)
            statePath, evidencePath = self.prepareUnknownState(
                plan, root, outcome='rolled-back')
            results = [mock.Mock(returncode=0), mock.Mock(returncode=1)]
            with mock.patch.object(RELEASE.subprocess, 'run', side_effect=results):
                with self.assertRaises(RELEASE.ReleaseError) as raised:
                    RELEASE.resolveUnknownMutation(
                        plan, 'rolled-back', str(evidencePath))
            self.assertEqual(raised.exception.code, 'RESOLUTION_POSTCHECK_FAILED')
            state = json.loads(statePath.read_text(encoding='utf-8'))
            self.assertIsNone(state['pendingMutation'])
            self.assertEqual(state['status'], 'resolution_check_failed')
            self.assertEqual(state['mutationResolution']['outcome'], 'rolled-back')
            self.assertFalse(state['mutationResolution']['resumeChecksPassed'])

    def test_unknown_resolution_rejects_state_plan_mismatch_before_command(self):
        with tempfile.TemporaryDirectory(prefix='release-resolution-mismatch-') as temporary:
            root = Path(temporary)
            plan = self.plan(root)
            statePath, evidencePath = self.prepareUnknownState(plan, root)
            state = json.loads(statePath.read_text(encoding='utf-8'))
            state['sourceDigest'] = 'f' * 64
            writeJson(statePath, state)
            with mock.patch.object(RELEASE.subprocess, 'run') as run:
                with self.assertRaises(RELEASE.ReleaseError) as raised:
                    RELEASE.resolveUnknownMutation(
                        plan, 'completed', str(evidencePath))
            self.assertEqual(raised.exception.code, 'RESOLUTION_STATE_MISMATCH')
            run.assert_not_called()

    def test_frontend_prepare_is_required_locked_and_uses_gate(self):
        with tempfile.TemporaryDirectory(prefix='release-prepare-') as temporary:
            plan = self.plan(Path(temporary))
            RELEASE.validatePlan(plan)
            executor = RELEASE.ReleaseExecutor.__new__(RELEASE.ReleaseExecutor)
            executor.plan = plan
            self.assertEqual(executor.gateCommand('frontendPrepare'), [
                sys.executable, '/gate.py', 'prepare', '/releases/new'])
            withoutPrepare = dict(plan)
            withoutPrepare['steps'] = plan['steps'][1:]
            with self.assertRaises(RELEASE.ReleaseError) as raised:
                RELEASE.validatePlan(withoutPrepare)
            self.assertEqual(raised.exception.code, 'PLAN_FRONTEND_REQUIRED')

    def test_unchanged_pointer_mode_requires_locked_prepare_check_and_verify(self):
        with tempfile.TemporaryDirectory(prefix='release-unchanged-') as temporary:
            plan = self.unchangedPlan(Path(temporary))
            self.assertIs(RELEASE.validatePlan(plan), plan)
            self.assertFalse(any(
                step['type'] == 'frontendSwitch' for step in plan['steps']))

    def test_unchanged_pointer_mode_fails_closed_for_pointer_or_mutation_drift(self):
        with tempfile.TemporaryDirectory(prefix='release-unchanged-invalid-') as temporary:
            root = Path(temporary)
            cases = []

            differentCandidate = self.unchangedPlan(root)
            differentCandidate['frontend']['candidate'] = '/releases/different'
            cases.append((differentCandidate, 'PLAN_FRONTEND_POINTER_UNCHANGED'))

            frontendSwitch = self.unchangedPlan(root)
            frontendSwitch['steps'].insert(-1, {
                'id': 'frontend-switch', 'stage': 'switch',
                'type': 'frontendSwitch', 'requiresReleaseLock': True,
                'mutatesComponents': ['frontend'],
                'reconcileCompleted': ['frontend-is-new'],
                'reconcileRolledBack': ['frontend-is-old'],
            })
            cases.append((frontendSwitch, 'PLAN_FRONTEND_UNCHANGED_SWITCH'))

            apiMutation = self.unchangedPlan(root)
            apiMutation['steps'][2]['mutatesComponents'] = ['api']
            cases.append((apiMutation, 'PLAN_FRONTEND_UNCHANGED_MUTATION'))

            changedApiComponent = self.unchangedPlan(root)
            changedApiComponent['components']['api']['targetVersion'] = 'new'
            cases.append((changedApiComponent,
                          'PLAN_FRONTEND_UNCHANGED_COMPONENTS'))

            missingApiComponent = self.unchangedPlan(root)
            missingApiComponent['components'].pop('api')
            cases.append((missingApiComponent,
                          'PLAN_FRONTEND_UNCHANGED_COMPONENTS'))

            missingFrontendComponent = self.unchangedPlan(root)
            missingFrontendComponent['components'].pop('frontend')
            cases.append((missingFrontendComponent,
                          'PLAN_FRONTEND_UNCHANGED_COMPONENTS'))

            singleIdentity = self.unchangedPlan(root)
            singleIdentity['frontend']['nginxUsers'] = ['33:33']
            cases.append((singleIdentity, 'PLAN_FRONTEND_IDENTITIES'))

            mutationAfterVerify = self.unchangedPlan(root)
            mutation = mutationAfterVerify['steps'].pop(2)
            mutationAfterVerify['steps'].append(mutation)
            cases.append((mutationAfterVerify, 'PLAN_FRONTEND_ORDER'))

            for invalidPlan, expectedCode in cases:
                with self.subTest(expectedCode=expectedCode):
                    with self.assertRaises(RELEASE.ReleaseError) as raised:
                        RELEASE.validatePlan(invalidPlan)
                    self.assertEqual(raised.exception.code, expectedCode)


if __name__ == '__main__':
    unittest.main()
