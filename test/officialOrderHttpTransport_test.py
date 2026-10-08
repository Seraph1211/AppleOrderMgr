"""HTTP 传输替身回归；不发出任何网络请求。"""
import base64
import importlib.util
import io
import json
import pathlib
import types
import unittest
from http.cookiejar import Cookie

try:
    from curl_cffi.requests.cookies import CurlMorsel
    from curl_cffi.requests.headers import Headers
    from curl_cffi.requests.models import Response
except ImportError:
    CurlMorsel = Headers = Response = None

SPEC = importlib.util.spec_from_file_location(
    'official_http_transport', pathlib.Path(__file__).parents[1] / 'scripts/officialOrder/httpTransport.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
URL = 'https://www.apple.com.cn/shop/order/list'
PROXY = {'host': 'proxy.test', 'port': 12345, 'username': 'private-user', 'password': 'private-password'}


def jar_cookie(name='synthetic', value='private', domain='www.apple.com.cn', path='/',
               subdomains=False, secure=True, http_only=True, expires=None, rest=None):
    """合成真实 Cookie 类型，使用锁定库实际导出的 http_only 属性格式。"""
    return Cookie(version=0, name=name, value=value, port=None, port_specified=False,
                  domain=domain, domain_specified=subdomains, domain_initial_dot=domain.startswith('.'),
                  path=path, path_specified=True, secure=secure, expires=expires, discard=expires is None,
                  comment=None, comment_url=None, rest=rest if rest is not None else {'http_only': str(http_only)},
                  rfc2109=False)


class FakeSession:
    def __init__(self, **kwargs):
        self.options = kwargs
        self.cookies = types.SimpleNamespace(jar=[])
        self.calls = []
        self.body = b'private response'
        self.status = 200
        self.response_url = None
        self.error = None
        self.closed = False
        self.raw_headers = [('Content-Type', 'text/html')]

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.error:
            raise self.error
        if kwargs['content_callback'](self.body) == MODULE.WRITE_ERROR:
            raise RuntimeError('private response rejected')
        return types.SimpleNamespace(status_code=self.status, url=self.response_url or url,
                                     headers=types.SimpleNamespace(multi_items=lambda: self.raw_headers))

    def close(self):
        self.closed = True


class HttpTransportTests(unittest.TestCase):
    def setUp(self):
        self.transport = MODULE.HttpTransport(session_factory=FakeSession)
        self.init = {'id': 1, 'op': 'init', 'proxy': PROXY}
        self.transport.initialize(self.init)
        self.session = self.transport.session
        self.request = {'id': 2, 'op': 'request', 'url': URL}

    def tearDown(self):
        self.transport.close()

    def test_session_security_settings(self):
        self.assertEqual(self.session.options['impersonate'], 'chrome150')
        self.assertEqual(self.session.options['proxy_auth'], ('private-user', 'private-password'))
        for key in ('allow_redirects', 'trust_env', 'debug'):
            self.assertIs(self.session.options[key], False)
        self.assertIs(self.session.options['verify'], True)
        self.assertEqual(self.session.options['retry'], 0)
        self.assertEqual(self.session.options['max_redirects'], 0)

    def test_response_and_cookie_metadata_are_private_protocol(self):
        self.session.cookies.jar = [types.SimpleNamespace(name='shld_bt_ck', value='secret',
            domain='www.apple.com.cn', path='/', expires=None, secure=True, domain_specified=False,
            _rest={'HttpOnly': None, 'SameSite': 'lAx'})]
        self.session.raw_headers = [('Set-Cookie', 'a=one'), ('Set-Cookie', 'b=two'),
                                   ('Set-Cookie', 'shld_bt_ck=secret; Path=/; Secure; HttpOnly; SameSite=lAx')]
        result = self.transport.request(self.request)
        self.assertEqual(base64.b64decode(result['bodyBase64']), b'private response')
        self.assertEqual(result['rawHeaders'], self.session.raw_headers)
        self.assertEqual(result['cookies'][0]['value'], 'secret')
        self.assertTrue(result['cookies'][0]['hostOnly'])
        self.assertTrue(result['cookies'][0]['httpOnly'])
        self.assertEqual(result['cookies'][0]['sameSite'], 'Lax')
        self.assertEqual(result['cookies'][0]['expires'], -1)

    def test_http_only_true_false_and_standard_cookiejar_presence(self):
        for rest, expected in [({'http_only': 'True'}, True), ({'http_only': 'False'}, False),
                               ({'http_only': True}, True), ({'http_only': False}, False),
                               ({'HttpOnly': None}, True), ({}, False)]:
            with self.subTest(rest=rest):
                self.session.cookies.jar = [jar_cookie(rest=rest)]
                actual = self.transport.request(self.request)['cookies'][0]
                self.assertIs(actual['httpOnly'], expected)
                self.assertNotIn('sameSite', actual)

    def test_unknown_http_only_value_fails_closed(self):
        self.session.cookies.jar = [jar_cookie(rest={'http_only': 'unknown-private'})]
        with self.assertRaisesRegex(MODULE.TransportError, '^HTTP_COOKIE_METADATA_INVALID$'):
            self.transport.request(self.request)

    def test_samesite_is_from_multi_headers_not_cookiejar_assumptions(self):
        self.session.cookies.jar = [jar_cookie(name='a'), jar_cookie(name='b'),
                                    jar_cookie(name='c'), jar_cookie(name='d', rest={'SameSite': 'None'})]
        self.session.raw_headers = [
            ('Set-Cookie', 'a=private; Path=/; Secure; HttpOnly; SameSite=Strict'),
            ('set-cookie', 'b=private; Path=/; Secure; HttpOnly; samesite=lax'),
            ('SET-COOKIE', 'c=private; Path=/; Secure; HttpOnly; SameSite=None'),
        ]
        cookies = {item['name']: item for item in self.transport.request(self.request)['cookies']}
        self.assertEqual([cookies[name]['sameSite'] for name in ('a', 'b', 'c')], ['Strict', 'Lax', 'None'])
        self.assertNotIn('sameSite', cookies['d'])
        self.session.raw_headers = []
        cookies = {item['name']: item for item in self.transport.request(self.request)['cookies']}
        self.assertEqual(cookies['a']['sameSite'], 'Strict')
        self.assertEqual(cookies['c']['sameSite'], 'None')

    def test_samesite_update_absence_and_invalid_value_clear_previous_attribute(self):
        self.session.cookies.jar = [jar_cookie()]
        for suffix, expected in [('; SameSite=Strict', 'Strict'), ('; SameSite=Lax', 'Lax'),
                                 ('', None), ('; SameSite=None', 'None'), ('; SameSite=Unknown', None)]:
            with self.subTest(suffix=suffix):
                self.session.raw_headers = [('Set-Cookie', 'synthetic=private; Path=/; Secure; HttpOnly' + suffix)]
                cookie = self.transport.request(self.request)['cookies'][0]
                if expected is None:
                    self.assertNotIn('sameSite', cookie)
                else:
                    self.assertEqual(cookie['sameSite'], expected)

    def test_samesite_delete_expire_and_recreate_do_not_inherit_old_attribute(self):
        for deletion in ['Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']:
            with self.subTest(deletion=deletion):
                self.session.cookies.jar = [jar_cookie()]
                self.session.raw_headers = [('Set-Cookie', 'synthetic=private; Path=/; Secure; HttpOnly; SameSite=Strict')]
                self.transport.request(self.request)
                self.session.cookies.jar = []
                self.session.raw_headers = [('Set-Cookie', 'synthetic=private; Path=/; Secure; HttpOnly; ' + deletion)]
                self.assertEqual(self.transport.request(self.request)['cookies'], [])
                self.assertEqual(self.transport.cookie_attributes, {})
                self.session.cookies.jar = [jar_cookie()]
                self.session.raw_headers = []
                self.assertNotIn('sameSite', self.transport.request(self.request)['cookies'][0])

    def test_samesite_default_path_domain_and_same_name_are_bound_to_accepted_cookie(self):
        self.session.cookies.jar = [
            jar_cookie(path='/shop/order'), jar_cookie(path='/'),
            jar_cookie(domain='.apple.com.cn', path='/', subdomains=True),
        ]
        self.session.raw_headers = [
            ('Set-Cookie', 'synthetic=private; Secure; HttpOnly; SameSite=Strict'),
            ('Set-Cookie', 'synthetic=private; Path=/; Secure; HttpOnly; SameSite=Lax'),
            ('Set-Cookie', 'synthetic=private; Domain=.apple.com.cn; Path=/; Secure; HttpOnly; SameSite=None'),
        ]
        cookies = self.transport.request(self.request)['cookies']
        self.assertEqual([item['sameSite'] for item in cookies], ['Strict', 'Lax', 'None'])
        self.assertEqual([item['hostOnly'] for item in cookies], [True, True, False])

    def test_samesite_repeated_headers_use_final_accepted_value_and_response_order(self):
        self.session.cookies.jar = [jar_cookie(value='new')]
        self.session.raw_headers = [
            ('Set-Cookie', 'synthetic=old; Path=/; Secure; HttpOnly; SameSite=Strict'),
            ('Set-Cookie', 'synthetic=new; Path=/; Secure; HttpOnly; SameSite=Lax'),
            ('Set-Cookie', 'synthetic=new; Path=/; Secure; HttpOnly; SameSite=None'),
        ]
        self.assertEqual(self.transport.request(self.request)['cookies'][0]['sameSite'], 'None')
        self.session.raw_headers.append(('Set-Cookie', 'synthetic=new; Path=/; Secure; HttpOnly'))
        self.assertNotIn('sameSite', self.transport.request(self.request)['cookies'][0])

    def test_rejected_cookie_does_not_overwrite_metadata_of_accepted_cookie(self):
        self.session.cookies.jar = [jar_cookie()]
        self.session.raw_headers = [('Set-Cookie', 'synthetic=private; Path=/; Secure; HttpOnly; SameSite=Strict')]
        self.transport.request(self.request)
        for rejected in ['synthetic=other; Path=/; Secure; HttpOnly; SameSite=None',
                         'synthetic=private; Domain=evil.test; Path=/; Secure; HttpOnly; SameSite=None',
                         'synthetic=private; Path=/other; Secure; HttpOnly; SameSite=None',
                         'synthetic=private; Path=/; HttpOnly; SameSite=None']:
            with self.subTest(rejected=rejected):
                self.session.raw_headers = [('Set-Cookie', rejected)]
                self.assertEqual(self.transport.request(self.request)['cookies'][0]['sameSite'], 'Strict')

    def test_unexplained_cookie_change_clears_old_samesite(self):
        self.session.cookies.jar = [jar_cookie()]
        self.session.raw_headers = [('Set-Cookie', 'synthetic=private; Path=/; Secure; HttpOnly; SameSite=Strict')]
        self.transport.request(self.request)
        self.session.cookies.jar = [jar_cookie(value='new')]
        self.session.raw_headers = []
        self.assertNotIn('sameSite', self.transport.request(self.request)['cookies'][0])

    def test_ambiguous_cookie_header_fails_closed_without_private_error_text(self):
        for text in ['', 'private-invalid-header', 'a=one; unknown=value', 'a="unclosed-private']:
            with self.subTest(text=text), self.assertRaisesRegex(MODULE.TransportError, '^HTTP_COOKIE_METADATA_INVALID$'):
                self.session.raw_headers = [('Set-Cookie', text)]
                self.transport.request(self.request)

    @unittest.skipUnless(CurlMorsel is not None, '锁定curl_cffi依赖在隔离venv中验证')
    def test_real_curl_morsel_headers_and_response_preserve_cookie_flags_offline(self):
        original = self.session.request
        def real_response(method, url, **kwargs):
            value = original(method, url, **kwargs)
            response = Response()
            response.status_code = value.status_code
            response.url = value.url
            response.headers = Headers(self.session.raw_headers)
            return response
        self.session.request = real_response
        for flag in (True, False):
            self.session.cookies.jar = [CurlMorsel(name='synthetic', value='private', hostname='www.apple.com.cn',
                                                   secure=True, http_only=flag).to_cookiejar_cookie()]
            self.session.raw_headers = [('Set-Cookie', 'synthetic=private; Path=/; Secure; SameSite=None' +
                                         ('; HttpOnly' if flag else ''))]
            cookie = self.transport.request(self.request)['cookies'][0]
            self.assertIs(cookie['httpOnly'], flag)
            self.assertTrue(cookie['hostOnly'])
            self.assertEqual(cookie['sameSite'], 'None')

    def test_no_redirect_follow_or_retry(self):
        self.session.status = 302
        self.session.raw_headers = [('Location', 'https://evil.test/private')]
        result = self.transport.request(self.request)
        self.assertEqual(result['status'], 302)
        self.assertEqual(len(self.session.calls), 1)
        kwargs = self.session.calls[0][2]
        self.assertIs(kwargs['allow_redirects'], False)
        self.assertEqual(kwargs['max_redirects'], 0)
        self.assertIs(kwargs['verify'], True)
        self.assertEqual(kwargs['timeout'], 30)

    def test_reused_session_and_binary_post_body(self):
        self.transport.request(self.request)
        self.transport.request(dict(self.request, id=3, method='POST', bodyBase64='AAH/'))
        self.assertEqual(len(self.session.calls), 2)
        self.assertEqual(self.session.calls[1][2]['data'], b'\x00\x01\xff')

    def test_oversized_decompressed_response_aborts(self):
        self.session.body = b'x' * (MODULE.MAX_BODY_BYTES + 1)
        with self.assertRaisesRegex(MODULE.TransportError, '^HTTP_RESPONSE_TOO_LARGE$'):
            self.transport.request(self.request)
        self.assertEqual(len(self.session.calls), 1)

    def test_exact_response_limit_accepted(self):
        self.session.body = b'x' * MODULE.MAX_BODY_BYTES
        self.assertEqual(len(base64.b64decode(self.transport.request(self.request)['bodyBase64'])), MODULE.MAX_BODY_BYTES)

    def test_invalid_destinations_never_call_library(self):
        for url in ['http://www.apple.com.cn/', 'https://evil.test/', 'https://apple.com.cn.evil.test/',
                    'https://127.0.0.1/', 'https://www.apple.com.cn:444/',
                    'https://user:secret@www.apple.com.cn/', 'https://www.apple.com.cn/#token',
                    'https://www.apple.com.cn/\nsecret', 'https://www.apple.com.cn\\@evil.test/']:
            with self.subTest(url=url), self.assertRaisesRegex(MODULE.TransportError, '^DESTINATION_DENIED$'):
                self.transport.request(dict(self.request, url=url))
        self.assertEqual(self.session.calls, [])

    def test_headers_cannot_inject_proxy_auth_or_fingerprint(self):
        for headers in [{'Proxy-Authorization': 'secret'}, {'User-Agent': 'Chrome/144'},
                        {'sec-ch-ua': 'Chrome144'}, {'Host': 'evil.test'},
                        {'X-Test': 'a\r\nb'}, {'X-Test': 'a', 'x-test': 'b'}]:
            with self.subTest(headers=headers), self.assertRaisesRegex(MODULE.TransportError, '^HTTP_HEADERS_INVALID$'):
                self.transport.request(dict(self.request, headers=headers))
        self.assertEqual(self.session.calls, [])

    def test_request_boundaries(self):
        for patch in [{'timeoutMs': 30001}, {'timeoutMs': True}, {'method': 'DELETE'},
                      {'method': 'POST', 'bodyBase64': 'invalid'}, {'bodyBase64': 'eA=='},
                      {'method': 'POST', 'bodyBase64': base64.b64encode(b'x' * (MODULE.MAX_REQUEST_BYTES + 1)).decode()}]:
            with self.subTest(patch=list(patch)), self.assertRaises(MODULE.TransportError):
                self.transport.request(dict(self.request, **patch))
        self.assertEqual(self.session.calls, [])

    def test_error_classification_never_uses_private_exception_text(self):
        for code, expected in [(28, 'HTTP_TIMEOUT'), (60, 'HTTP_TLS_FAILED'),
                               (56, 'PROXY_CONNECTION_FAILED'), (999, 'HTTP_TRANSPORT_FAILED')]:
            self.session.error = RuntimeError('private-password https://private.test')
            self.session.error.code = code
            with self.subTest(code=code), self.assertRaisesRegex(MODULE.TransportError, '^' + expected + '$'):
                self.transport.request(self.request)

    def test_changed_effective_url_rejected(self):
        self.session.response_url = 'https://www.apple.com.cn/other'
        with self.assertRaisesRegex(MODULE.TransportError, '^HTTP_UNEXPECTED_REDIRECT$'):
            self.transport.request(self.request)

    def test_version_and_profile_locked(self):
        other = MODULE.HttpTransport(session_factory=FakeSession)
        with self.assertRaisesRegex(MODULE.TransportError, '^HTTP_PROFILE_UNSUPPORTED$'):
            other.initialize(dict(self.init, impersonate='chrome144'))
        self.assertEqual(MODULE.CURL_CFFI_VERSION, '0.16.3')

    def test_protocol_serializes_and_closes(self):
        other = MODULE.HttpTransport(session_factory=FakeSession)
        output = io.StringIO()
        commands = [self.init, self.request, dict(self.request, id=3), {'id': 4, 'op': 'close'}]
        MODULE.serve(io.BytesIO(''.join(json.dumps(c) + '\n' for c in commands).encode()), output, other)
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([r['id'] for r in results], [1, 2, 3, 4])
        self.assertTrue(all(r['ok'] for r in results))
        self.assertIsNone(other.session)

    def test_malformed_and_duplicate_protocol_stops_without_network(self):
        for lines in [b'private-invalid-json\n', b'{}\n', b'x' * (MODULE.MAX_INPUT_BYTES + 1),
                      (json.dumps(self.init) + '\n' + json.dumps(self.init) + '\n').encode()]:
            output = io.StringIO()
            other = MODULE.HttpTransport(session_factory=FakeSession)
            MODULE.serve(io.BytesIO(lines), output, other)
            last = json.loads(output.getvalue().splitlines()[-1])
            self.assertFalse(last['ok'])
            self.assertRegex(last['code'], '^HTTP_(PROTOCOL|INIT)_(INVALID|FAILED)$')
            self.assertNotIn('private-invalid-json', output.getvalue())


if __name__ == '__main__':
    unittest.main()
