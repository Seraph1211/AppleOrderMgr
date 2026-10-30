"""发布权限、HTTP 内容与原子切换回退回归；仅使用合成目录及回环 HTTP。"""
import fcntl
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'frontendGate', str(Path(__file__).resolve().parents[1] / 'scripts/productionFrontendGate.py'))
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


class ProductionFrontendGateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='frontend-gate-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.releases = self.root / 'releases'
        self.releases.mkdir()
        self.old = self.fixture('old')
        self.new = self.fixture('new')
        self.current = self.root / 'current'
        self.current.symlink_to(self.old)
        self.fault = None
        self.requests = []
        self.health = {'success': True, 'data': {'status': 'healthy', 'db': 'ok'}}

    def fixture(self, name):
        release = self.releases / name
        (release / 'frontend/assets').mkdir(parents=True)
        (release / 'frontend/index.html').write_text(
            '<html><title>' + name + '</title><script src="/assets/' + name + '-app.js"></script>'
            '<link rel="stylesheet" href="/assets/common.css"></html>', encoding='utf-8')
        (release / 'frontend/assets' / (name + '-app.js')).write_text(
            '/* ' + name + ' */', encoding='utf-8')
        (release / 'frontend/assets/common.css').write_text('body{}', encoding='utf-8')
        GATE.prepare(release)
        return release

    def entry(self, release):
        return release / 'frontend/assets' / (release.name + '-app.js')

    def server(self):
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                test.requests.append(self.path)
                fault = test.fault if test.current.resolve() == test.new else None
                status, contentType = 200, 'text/html'
                if self.path == '/api/health/ready':
                    body = json.dumps(test.health).encode()
                    contentType = 'application/json'
                else:
                    relative = self.path.lstrip('/') if self.path.startswith('/assets/') else 'index.html'
                    body = (test.current / 'frontend' / relative).read_bytes()
                    if relative.endswith('.js'):
                        contentType = 'application/javascript'
                    elif relative.endswith('.css'):
                        contentType = 'text/css'
                    if fault == 'mime' and relative.endswith('.js'):
                        contentType = 'text/html'
                    elif fault == 'digest':
                        body = body.replace(b'new', b'old')
                    elif fault == 'length':
                        body += b'extra'
                    elif fault == '500':
                        status = 500
                    elif fault == 'redirect':
                        status = 302
                self.send_response(status)
                self.send_header('Content-Type', contentType)
                self.send_header('Content-Length', str(len(body)))
                if status == 302:
                    self.send_header('Location', '/login')
                self.end_headers()
                self.wfile.write(body)

        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.daemon = True
        thread.start()

        def cleanup():
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

        self.addCleanup(cleanup)
        return 'http://127.0.0.1:' + str(server.server_port)

    def assertCode(self, code, function, *args, **kwargs):
        with self.assertRaises(GATE.GateError) as result:
            function(*args, **kwargs)
        self.assertEqual(result.exception.code, code)
        return result.exception

    def switch(self, url, expected=None):
        # HTTP/原子链接用真实文件系统；用户降权另由独立用例和生产宿主回归验证。
        original = GATE.check
        with mock.patch.object(GATE, 'check', side_effect=lambda release, user:
                               original(release, user, permissionsOnly=True)):
            return GATE.switch(self.new, self.current, expected or self.old, url,
                               allowHttpLoopback=True)

    def test_umask_077_reproduces_and_prepare_preserves_private_files(self):
        previous = os.umask(0o077)
        try:
            release = self.releases / 'restricted'
            release.mkdir(mode=0o755)
            shutil.copytree(str(self.old / 'frontend'), str(release / 'frontend'))
            secret = release / 'release.env'
            secret.write_text('SYNTHETIC_PRIVATE', encoding='utf-8')
        finally:
            os.umask(previous)
        self.assertEqual(mode(release), 0o700)
        self.assertCode('PUBLIC_DIRECTORY_MODE', GATE.check, release, permissionsOnly=True)
        before = (secret.read_bytes(), secret.stat().st_ino, mode(secret))
        GATE.prepare(release)
        self.assertEqual(mode(release), 0o755)
        self.assertEqual((secret.read_bytes(), secret.stat().st_ino, mode(secret)), before)
        self.assertTrue(GATE.check(release, permissionsOnly=True)['passed'])

    def test_prepare_only_changes_public_tree(self):
        (self.new / 'evidence').mkdir(mode=0o700)
        secret = self.new / 'evidence/private.json'
        secret.write_text('{}', encoding='utf-8')
        secret.chmod(0o600)
        GATE.prepare(self.new)
        self.assertEqual(mode(self.new / 'evidence'), 0o700)
        self.assertEqual(mode(secret), 0o600)

    def test_prepare_rejects_symlinks_before_chmod(self):
        outside = self.root / 'secret'
        outside.write_text('private', encoding='utf-8')
        outside.chmod(0o600)
        (self.new / 'frontend/assets/linked').symlink_to(outside)
        self.new.chmod(0o700)
        self.assertCode('FRONTEND_SYMLINK_REJECTED', GATE.prepare, self.new)
        self.assertEqual(mode(outside), 0o600)
        self.assertEqual(mode(self.new), 0o700)

    def test_release_symlink_rejected(self):
        alias = self.releases / 'alias'
        alias.symlink_to(self.new)
        self.assertCode('RELEASE_DIRECTORY_INVALID', GATE.prepare, alias)

    def test_special_file_rejected(self):
        os.mkfifo(str(self.new / 'frontend/assets/pipe'))
        self.assertCode('FRONTEND_SPECIAL_FILE', GATE.prepare, self.new)

    def test_missing_asset_rejected(self):
        self.entry(self.new).unlink()
        self.assertCode('ENTRY_ASSET_MISSING', GATE.check, self.new, permissionsOnly=True)

    def test_missing_lazy_asset_rejected(self):
        app = self.entry(self.new)
        app.write_text('import("./Stock-missing.js")', encoding='utf-8')
        self.assertCode('LAZY_ASSET_MISSING', GATE.check, self.new, permissionsOnly=True)

    def test_verify_follows_lazy_asset_graph(self):
        app = self.entry(self.old)
        lazy = self.old / 'frontend/assets/Stock-current.js'
        app.write_text('const deps = ["assets/Stock-current.js"]; import("./Stock-current.js")',
                       encoding='utf-8')
        lazy.write_text('import "./old-app.js"; export default 1', encoding='utf-8')
        lazy.chmod(0o644)
        result = GATE.verify(self.old, self.server(), True)
        self.assertEqual(result['assets'], 3)
        self.assertIn('/assets/Stock-current.js', self.requests)

    def test_changed_immutable_lazy_asset_blocks_switch(self):
        for release, entry, lazy in (
                (self.old, 'old-entry', 'import "./old-app.js"; export default "old"'),
                (self.new, 'new-entry', 'import "./new-app.js"; export default "new"')):
            app = self.entry(release)
            stock = release / 'frontend/assets/Stock-fixed-name.js'
            app.write_text(entry + '; import("./Stock-fixed-name.js")', encoding='utf-8')
            stock.write_text(lazy, encoding='utf-8')
            stock.chmod(0o644)
        self.assertCode('IMMUTABLE_ASSET_REUSED', self.switch, self.server())
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.requests, [])

    def test_unchanged_shared_asset_is_allowed(self):
        shared = 'export const shared = true'
        for release in (self.old, self.new):
            app = self.entry(release)
            common = release / 'frontend/assets/common.js'
            app.write_text(app.read_text() + '; import("./common.js")', encoding='utf-8')
            common.write_text(shared, encoding='utf-8')
            common.chmod(0o644)
        self.assertTrue(self.switch(self.server())['switched'])

    def test_external_and_traversing_assets_rejected(self):
        for url in ('https://example.test/app.js', '//example.test/app.js',
                    '/assets/%2e%2e/release.env'):
            (self.new / 'frontend/index.html').write_text('<script src="' + url + '"></script>')
            self.assertCode('ENTRY_ASSET_URL_INVALID', GATE.prepare, self.new)

    def test_unreadable_static_file_rejected(self):
        self.entry(self.new).chmod(0o600)
        self.assertCode('PUBLIC_FILE_MODE', GATE.check, self.new, permissionsOnly=True)

    def test_existing_external_fonts_are_not_fetched(self):
        index = self.old / 'frontend/index.html'
        index.write_text(index.read_text() +
                         '<link href="https://fonts.googleapis.com/css2?family=Test" rel="stylesheet">')
        result = GATE.verify(self.old, self.server(), True)
        self.assertEqual(result['assets'], 2)
        self.assertEqual(len(self.requests), 6)

    def test_actual_nginx_user_is_invoked_for_all_files(self):
        with mock.patch.object(GATE.pwd, 'getpwnam', return_value=mock.Mock(pw_uid=1001)), \
                mock.patch.object(GATE.subprocess, 'run', return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(GATE.check(self.new)['nginxUserChecked'])
        command = run.call_args[0][0]
        self.assertEqual(command[:4], ['runuser', '-u', 'nginx', '--'])
        self.assertEqual(len(json.loads(run.call_args[1]['input'].decode())), 3)

    def test_nginx_denial_is_not_masked_by_root_readability(self):
        with mock.patch.object(GATE.pwd, 'getpwnam', return_value=mock.Mock(pw_uid=1001)), \
                mock.patch.object(GATE.subprocess, 'run', return_value=mock.Mock(returncode=1)):
            self.assertCode('NGINX_CANNOT_READ_FRONTEND', GATE.check, self.new)

    def test_container_nginx_numeric_identity_clears_supplementary_groups(self):
        with mock.patch.object(GATE.subprocess, 'run', return_value=mock.Mock(returncode=0)) as run:
            self.assertTrue(GATE.check(self.new, '33:33')['nginxUserChecked'])
        self.assertEqual(run.call_args[0][0][:7],
                         ['setpriv', '--reuid', '33', '--regid', '33', '--clear-groups', '--'])
        self.assertEqual(len(json.loads(run.call_args[1]['input'].decode())), 3)

    def test_numeric_nginx_identity_must_be_explicit_and_non_root(self):
        for identity in ['0:33', '33:0', '33:x', '-1:33', '33:33:33', '4294967295:33']:
            with self.subTest(identity=identity):
                self.assertCode('NGINX_IDENTITY_INVALID', GATE.check, self.new, identity)

    def test_numeric_nginx_read_denial_stops_gate(self):
        with mock.patch.object(GATE.subprocess, 'run', return_value=mock.Mock(returncode=1)):
            self.assertCode('NGINX_CANNOT_READ_FRONTEND', GATE.check, self.new, '33:33')

    def test_root_cannot_be_used_as_nginx_user(self):
        self.assertCode('NGINX_USER_IS_ROOT', GATE.check, self.new, 'root')

    @unittest.skipUnless(os.environ.get('FRONTEND_GATE_NGINX_USER'),
                         '真实降权检查需要 root 与显式 Nginx 用户')
    def test_real_worker_parent_permissions(self):
        self.root.chmod(0o700)
        user = os.environ['FRONTEND_GATE_NGINX_USER']
        self.assertCode('NGINX_CANNOT_READ_FRONTEND', GATE.check, self.new, user)
        self.root.chmod(0o755)
        self.assertTrue(GATE.check(self.new, user)['passed'])

    def test_verify_real_http_content_and_ready(self):
        url = self.server()
        result = GATE.verify(self.old, url, True)
        self.assertEqual(result, {'passed': True, 'pages': 3, 'assets': 2, 'apiReady': True})
        self.assertEqual(len(self.requests), 6)

    def test_base_url_rejects_credentials_plaintext_and_query(self):
        for url in ('http://example.test', 'https://user:private@example.test',
                    'https://example.test/?private=1', 'https://example.test/api'):
            self.assertCode('BASE_URL_INVALID', GATE.origin, url)
        self.assertCode('BASE_URL_INVALID', GATE.origin, 'http://127.0.0.1')

    def test_successful_switch(self):
        result = self.switch(self.server())
        self.assertTrue(result['switched'])
        self.assertEqual(self.current.resolve(), self.new)
        self.assertEqual(list(self.root.glob('.frontend-next-*')), [])

    def test_700_blocks_before_switch_or_http(self):
        self.new.chmod(0o700)
        self.assertCode('PUBLIC_DIRECTORY_MODE', self.switch, self.server())
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.requests, [])

    def test_wrong_expected_current_refuses_switch(self):
        expected = self.fixture('unrelated')
        self.assertCode('CURRENT_CHANGED', self.switch, self.server(), expected)
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual(self.requests, [])

    def test_lock_refuses_concurrent_switch(self):
        with (self.root / '.frontend-release.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(OSError):
                self.switch(self.server())
        self.assertEqual(self.current.resolve(), self.old)

    def test_http_failure_restores_and_rechecks_previous_release(self):
        for fault, code in (('500', 'PUBLIC_HTTP_CHECK_FAILED'),
                            ('mime', 'FRONTEND_HTTP_TYPE'),
                            ('digest', 'FRONTEND_HTTP_DIGEST'),
                            ('length', 'FRONTEND_HTTP_LENGTH'),
                            ('redirect', 'PUBLIC_HTTP_CHECK_FAILED')):
            self.fault = fault
            with self.subTest(fault=fault):
                error = self.assertCode(code, self.switch, self.server())
                self.assertTrue(error.rolledBack)
                self.assertEqual(self.current.resolve(), self.old)
                self.assertEqual(self.requests[-1], '/api/health/ready')
                self.assertEqual(list(self.root.glob('.frontend-next-*')), [])

    def test_api_health_200_but_unhealthy_fails(self):
        self.health['data']['db'] = 'failed'
        self.assertCode('API_NOT_READY', GATE.verify, self.old, self.server(), True)

    def test_rollback_failure_is_reported_after_pointer_is_restored(self):
        self.health['data']['db'] = 'failed'
        error = self.assertCode('ROLLBACK_HTTP_CHECK_FAILED', self.switch, self.server())
        self.assertTrue(error.rolledBack)
        self.assertEqual(self.current.resolve(), self.old)

    def test_cli_failure_is_nonzero_without_private_output(self):
        self.new.chmod(0o700)
        result = subprocess.run([sys.executable, '-B', SPEC.origin, 'check', str(self.new),
                                 '--permissions-only'], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout.decode()), {
            'passed': False, 'code': 'PUBLIC_DIRECTORY_MODE'})

    def test_build_entrypoint_handles_umask_077_with_synthetic_docker(self):
        repo = self.root / 'build-repo'
        (repo / 'scripts').mkdir(parents=True)
        (repo / 'frontend').mkdir()
        source = Path(SPEC.origin).parent
        for name in (
                'buildProductionRelease.sh', 'productionFrontendGate.py', 'productionSourceGuard.py',
                'productionRelease.py', 'productionReleaseBackup.py',
                'productionReleaseFiles.py', 'productionReleaseResourceProbe.py',
                'productionReleaseDatabaseValidation.sql',
                'productionReleaseSchemaDiagnostic.sql',
                'productionReleaseSchemaInventory.sql'):
            shutil.copy2(str(source / name), str(repo / 'scripts' / name))
        (repo / 'config').mkdir()
        (repo / 'src').mkdir()
        (repo / 'src/feature.js').write_text('restoredFeature', encoding='utf-8')
        (repo / 'config/productionCapabilities.json').write_text(json.dumps({
            'schemaVersion': 1, 'capabilities': [{
                'id': 'synthetic', 'source': {'src/feature.js': ['restoredFeature']},
                'frontendTokens': []}]}), encoding='utf-8')
        for name in ('docker-compose.prod.yml', 'nginx-apple-order-mgr.conf'):
            (repo / name).write_text('synthetic', encoding='utf-8')
        (repo / '.gitignore').write_text('release-artifacts/\n', encoding='utf-8')
        binary = self.root / 'bin'
        binary.mkdir()
        docker = binary / 'docker'
        docker.write_text('#!' + sys.executable + '\nimport pathlib,shutil,sys,tarfile\n'
                          'if sys.argv[1]=="run":\n'
                          ' with tarfile.open(fileobj=sys.stdout.buffer,mode="w|") as t:\n'
                          '  t.add("src",arcname="src")\n'
                          'elif sys.argv[1:3]==["image","inspect"]: print("sha256:synthetic")\n'
                          'elif sys.argv[1]=="create": print("synthetic")\n'
                          'elif sys.argv[1]=="cp":\n'
                          ' destination=pathlib.Path(sys.argv[-1])\n'
                          ' (destination/"assets").mkdir(exist_ok=True)\n'
                          ' source=pathlib.Path(' + repr(str(self.old / 'frontend')) + ')\n'
                          ' for p in source.rglob("*"):\n'
                          '  if p.is_file(): shutil.copy2(str(p),str(destination/p.relative_to(source)))\n'
                          'elif sys.argv[1]=="save": sys.stdout.write("synthetic-image")\n')
        docker.chmod(0o755)
        for args in (['init', '-b', 'main'], ['add', '.'],
                     ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'test']):
            subprocess.run(['git'] + args, cwd=str(repo), check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        environment = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['bash', '-c', 'umask 077; bash scripts/buildProductionRelease.sh'],
                                cwd=str(repo), env=environment, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        release = Path(result.stdout.decode().strip())
        self.assertTrue(GATE.check(release, permissionsOnly=True)['passed'])
        self.assertEqual(mode(release / 'release.env'), 0o600)
        self.assertEqual((release / 'productionFrontendGate.py').read_bytes(),
                         (source / 'productionFrontendGate.py').read_bytes())
        self.assertIn('productionFrontendGate.py', (release / 'SHA256SUMS').read_text())


if __name__ == '__main__':
    unittest.main()
