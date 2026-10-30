"""隔离 Nginx 验证真实站点日志：出口标记白名单与身份资料脱敏。"""
import os
import pathlib
import re
import subprocess
import tempfile
import time
import unittest
import uuid


@unittest.skipUnless(os.environ.get('OFFICIAL_NGINX_TEST_IMAGE'), '需要显式指定本地 Nginx 测试镜像')
class NginxOfficialEgressTest(unittest.TestCase):
    @classmethod
    def command(cls, *args, **kwargs):
        """执行有界合成测试命令，不连接生产或外部网络。"""
        return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=20, **kwargs).stdout

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='official-egress-nginx-')
        cls.addClassCleanup(cls.directory.cleanup)
        root = pathlib.Path(cls.directory.name)
        cls.name = 'official-egress-test-' + uuid.uuid4().hex
        cls.addClassCleanup(lambda: subprocess.run(
            ['docker', 'rm', '-f', cls.name], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=20))
        cls.command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem'),
                    '-days', '1', '-subj', '/CN=localhost')
        config = pathlib.Path('nginx-apple-order-mgr.conf').read_text(encoding='utf-8')
        config = config.replace('/etc/letsencrypt/live/apple.godp.me/fullchain.pem', '/test/cert.pem')
        config = config.replace('/etc/letsencrypt/live/apple.godp.me/privkey.pem', '/test/key.pem')
        config = config.replace('/var/log/nginx/apple-order-mgr-access.log', '/tmp/egress-access.log')
        # 使用相同站点配置；业务上游仅替换成合成响应，避免访问真实系统。
        config = config.replace('proxy_pass http://127.0.0.1:3001;', 'return 200 \'{"success":true}\';')
        (root / 'default.conf').write_text(config, encoding='utf-8')
        cls.command('docker', 'run', '-d', '--rm', '--network', 'none', '--name', cls.name,
                    '-v', str(root) + ':/test:ro',
                    '-v', str(root / 'default.conf') + ':/etc/nginx/conf.d/default.conf:ro',
                    os.environ['OFFICIAL_NGINX_TEST_IMAGE'])
        cls.command('docker', 'exec', cls.name, 'nginx', '-t')

    def readLog(self):
        """读取隔离实例日志；日志内容只有合成值。"""
        return self.command('docker', 'exec', self.name, 'cat', '/tmp/egress-access.log').decode()

    def request(self, path, scheme='https', expectedLogged=True):
        """发起本机请求并等待 Nginx 完成访问日志追加。"""
        before = self.readLog()
        response = subprocess.run(['docker', 'exec', self.name, 'wget', '-S', '-O', '-',
                        '--no-check-certificate', '--header', 'Connection: close',
                        '--header', 'Referer: https://example.test/?secret=SYNTHETIC_PRIVATE',
                        '--header', 'User-Agent: SYNTHETIC_PRIVATE',
                        scheme + '://127.0.0.1' + path], stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, timeout=10, check=False)
        statuses = re.findall(rb'HTTP/\S+ (\d{3})', response.stderr)
        self.assertTrue(statuses, '合成请求必须实际收到 HTTP 响应')
        self.lastStatus = int(statuses[-1])
        deadline = time.monotonic() + 2
        while True:
            delta = self.readLog()[len(before):]
            if delta or not expectedLogged or time.monotonic() >= deadline:
                return delta
            time.sleep(0.05)

    def test_valid_probe_is_recorded_once_without_query_or_headers(self):
        token = 'http-rebuild-' + uuid.uuid4().hex
        log = self.request('/api/health/ready?' + token)
        self.assertEqual(log.count(token), 1)
        self.assertIn('"GET /api/health/ready HTTP/1.1" 200', log)
        self.assertIn('probe=' + token, log)
        self.assertNotIn('?', log)
        self.assertNotIn('SYNTHETIC_PRIVATE', log)

    def test_non_allowlisted_inputs_never_reach_probe_field(self):
        token = 'http-rebuild-' + uuid.uuid4().hex
        paths = [
            '/api/health/ready',
            '/api/health/ready?' + token + '&token=SYNTHETIC_PRIVATE',
            '/api/health/ready?token=SYNTHETIC_PRIVATE&' + token,
            '/api/health/ready?' + token + '=' + token,
            '/api/health/ready?' + token + '0',
            '/api/health/ready?' + token[:-1],
            '/api/health/ready?' + token.upper(),
            '/api/health/ready?http-rebuild-' + 'g' * 32,
            '/api/health/ready?' + token + '%0A',
            '/api/health/ready?http-rebuild-%61' + 'a' * 31,
            '/api/health/other?' + token,
            '/api/health/ready/?' + token,
        ]
        for path in paths:
            with self.subTest(path=path):
                log = self.request(path)
                self.assertIn('probe=-', log)
                self.assertNotIn(token, log)
                self.assertNotIn('SYNTHETIC_PRIVATE', log)
                self.assertNotIn('?', log)

    def test_identity_endpoints_do_not_write_access_logs(self):
        for scheme in ('http', 'https'):
            for path in ('/api/internal/v1/identity', '/api/internal/v1/IDENTITY/verify'):
                with self.subTest(scheme=scheme, path=path):
                    self.assertEqual(self.request(path + '?name=SYNTHETIC_PRIVATE',
                                                  scheme, expectedLogged=False), '')
                    self.assertEqual(self.lastStatus, 400 if scheme == 'http' else 200)


if __name__ == '__main__':
    unittest.main()
