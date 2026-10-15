"""仅合成文本测试，不执行SSH、Docker构建或生产操作。"""
import unittest
from pathlib import Path
from patchNginx import patch_site

BASE = '''# existing site configuration
server {
 listen 80;
 server_name apple.godp.me;
 return 301 https://$server_name$request_uri;
}
server {
 listen 443 ssl http2;
 server_name apple.godp.me;
 ssl_certificate /synthetic/cert;
 access_log /old/access.log;
 error_log /old/error.log;
 location / { root /keep/current/frontend; }
 location /api/ { proxy_pass http://127.0.0.1:3001; }
 location /collector-v2/ { alias /keep/collector/; }
}
server {
 listen 443 ssl;
 server_name unrelated.example;
 location / { return 200 'unrelated'; }
}
'''


class ReleaseTests(unittest.TestCase):
    def test_preserve_unrelated_server_and_location(self):
        candidate = patch_site(BASE, 'apple.godp.me')
        self.assertTrue(candidate.endswith(BASE[BASE.index("server {\n listen 443 ssl;\n server_name unrelated.example;"):]))
        self.assertIn('location /collector-v2/ { alias /keep/collector/; }', candidate)
        self.assertIn('root /keep/current/frontend;', candidate)
        self.assertEqual(candidate.count('location ~* ^/api/internal/v1/identity'), 2)
        self.assertEqual(candidate.count('add_header Referrer-Policy "no-referrer" always;'), 4)
        self.assertEqual(candidate.count('add_header Cache-Control "no-store" always;'), 4)
        self.assertIn('proxy_next_upstream off;', candidate)
        self.assertNotIn('error_log /old/error.log;', candidate)
        self.assertEqual(candidate.count('return 301 https://$server_name$request_uri;'), 1)

    def test_prefix_priority_requires_review(self):
        with self.assertRaisesRegex(AssertionError, 'PREFIX_PRIORITY'):
            patch_site(BASE.replace('location /api/', 'location ^~ /api/'), 'apple.godp.me')

    def test_second_application_rejected(self):
        with self.assertRaisesRegex(AssertionError, 'ALREADY_PRESENT'):
            patch_site(patch_site(BASE, 'apple.godp.me'), 'apple.godp.me')

    def test_multiple_domains_require_review(self):
        with self.assertRaisesRegex(AssertionError, 'MULTI_DOMAIN'):
            patch_site(BASE.replace('server_name apple.godp.me;', 'server_name apple.godp.me other.example;', 1), 'apple.godp.me')

    def test_quoted_brace_preserved(self):
        source = BASE.replace('location /collector-v2/', "add_header X-Synthetic '}';\n location /collector-v2/")
        self.assertIn("add_header X-Synthetic '}';", patch_site(source, 'apple.godp.me'))

    def test_real_baseline_candidate_generated(self):
        baseline = Path(__file__).with_name('生产站点基线.conf')
        if baseline.exists():
            self.assertIn('proxy_next_upstream off;', patch_site(baseline.read_text(), 'apple.godp.me'))


if __name__ == '__main__':
    unittest.main()
