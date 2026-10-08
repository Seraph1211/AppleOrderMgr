#!/usr/bin/env python3
"""受限 JSON-lines HTTP 子进程；stdout 只返回私密协议，不写凭据日志。

安装锁定：python -m pip install --index-url https://pypi.org/simple curl_cffi==0.16.3
依据：https://curl-cffi.readthedocs.io/en/v0.16.3/_modules/curl_cffi/requests/session.html
请求许可由父进程逐次取得；本进程不自动重定向、重试或刷新指纹。
"""
import base64
import binascii
import http.cookies
import json
import re
import sys
from urllib.parse import urlsplit

CURL_CFFI_VERSION = '0.16.3'
DEFAULT_IMPERSONATE = 'chrome150'
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_REQUEST_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 128 * 1024
MAX_TIMEOUT_MS = 30000
MAX_HEADERS = 100
WRITE_ERROR = 0xFFFFFFFF
APPLE_HOST = re.compile(r'^(?:[a-z0-9-]+\.)*(?:apple\.com\.cn|apple\.com|cdn-apple\.com|aaplimg\.com|mzstatic\.com)$')
HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
RESERVED_HEADERS = {'host', 'proxy-authorization', 'proxy-connection', 'connection',
                    'content-length', 'transfer-encoding', 'user-agent', 'sec-ch-ua',
                    'sec-ch-ua-mobile', 'sec-ch-ua-platform'}


class TransportError(Exception):
    """仅携带可公开的稳定错误码，不保留底层异常。"""


def permitted_url(value):
    if not isinstance(value, str) or len(value) > 16384 or re.search(r'[\x00-\x20\x7f\\]', value):
        raise TransportError('DESTINATION_DENIED')
    try:
        url = urlsplit(value)
        if (url.scheme != 'https' or url.username or url.password or url.fragment or
                url.port not in (None, 443) or not APPLE_HOST.fullmatch(url.hostname or '')):
            raise ValueError()
    except (ValueError, TypeError):
        raise TransportError('DESTINATION_DENIED') from None
    return value


def validate_proxy(value):
    if not isinstance(value, dict) or set(value) != {'host', 'port', 'username', 'password'}:
        raise TransportError('HTTP_PROXY_INVALID')
    if (not isinstance(value['host'], str) or
            not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', value['host']) or
            type(value['port']) is not int or not 1 <= value['port'] <= 65535 or
            any(not isinstance(value[k], str) or not 1 <= len(value[k]) <= 4096 or
                re.search(r'[\x00-\x1f\x7f]', value[k]) for k in ('username', 'password'))):
        raise TransportError('HTTP_PROXY_INVALID')
    return value


def validate_request(value):
    if not isinstance(value, dict) or set(value) - {'id', 'op', 'url', 'method', 'headers', 'bodyBase64', 'timeoutMs'}:
        raise TransportError('HTTP_REQUEST_INVALID')
    url = permitted_url(value.get('url'))
    method = value.get('method', 'GET')
    timeout_ms = value.get('timeoutMs', MAX_TIMEOUT_MS)
    if method not in ('GET', 'HEAD', 'POST') or type(timeout_ms) is not int or not 1 <= timeout_ms <= MAX_TIMEOUT_MS:
        raise TransportError('HTTP_REQUEST_INVALID')
    headers = value.get('headers', {})
    if not isinstance(headers, dict) or len(headers) > MAX_HEADERS:
        raise TransportError('HTTP_HEADERS_INVALID')
    names = set()
    for name, text in headers.items():
        if (not HEADER_NAME.fullmatch(name) or name.lower() in names or name.lower() in RESERVED_HEADERS or
                not isinstance(text, str) or len(text) > 8192 or re.search(r'[\x00-\x1f\x7f]', text)):
            raise TransportError('HTTP_HEADERS_INVALID')
        names.add(name.lower())
    body = value.get('bodyBase64')
    if body is not None:
        try:
            if not isinstance(body, str) or len(body) > MAX_INPUT_BYTES:
                raise ValueError()
            decoded = base64.b64decode(body, validate=True)
            if base64.b64encode(decoded).decode('ascii') != body or len(decoded) > MAX_REQUEST_BYTES:
                raise ValueError()
            body = decoded
        except (ValueError, binascii.Error):
            raise TransportError('HTTP_REQUEST_BODY_INVALID') from None
        if method != 'POST':
            raise TransportError('HTTP_REQUEST_BODY_INVALID')
    return url, method, headers, body, timeout_ms


class HttpTransport:
    """单线程单会话；私密代理配置只从父进程 stdin 接收。"""

    def __init__(self, session_factory=None):
        self.session = None
        self.session_factory = session_factory
        self.profile = None
        # libcurl 的 CookieJar 不保留 SameSite；仅保存已匹配实际响应的属性。
        self.cookie_attributes = {}

    def initialize(self, value):
        if self.session is not None or set(value) - {'id', 'op', 'proxy', 'impersonate'}:
            raise TransportError('HTTP_INIT_INVALID')
        proxy = validate_proxy(value.get('proxy'))
        profile = value.get('impersonate', DEFAULT_IMPERSONATE)
        # 固定版本的内置 profile，不请求第三方指纹服务，也不覆盖 TLS 对应 UA。
        if profile != DEFAULT_IMPERSONATE:
            raise TransportError('HTTP_PROFILE_UNSUPPORTED')
        options = dict(proxy='http://{}:{}'.format(proxy['host'], proxy['port']),
                       proxy_auth=(proxy['username'], proxy['password']),
                       impersonate=profile, verify=True, allow_redirects=False,
                       max_redirects=0, timeout=MAX_TIMEOUT_MS / 1000,
                       trust_env=False, retry=0, debug=False)
        if self.session_factory is None:
            try:
                import curl_cffi
                from curl_cffi import CurlOpt
                from curl_cffi.requests import Session
                from curl_cffi.requests.impersonate import BrowserType
            except ImportError:
                raise TransportError('HTTP_DEPENDENCY_MISSING') from None
            if curl_cffi.__version__ != CURL_CFFI_VERSION:
                raise TransportError('HTTP_DEPENDENCY_VERSION')
            if profile not in {item.value for item in BrowserType}:
                raise TransportError('HTTP_PROFILE_UNSUPPORTED')
            options['curl_options'] = {CurlOpt.NOPROXY: ''}
            self.session = Session(**options)
        else:
            self.session = self.session_factory(**options)
        self.profile = profile
        return {'version': CURL_CFFI_VERSION, 'impersonate': profile}

    def cookie_metadata(self, url, raw_headers):
        """保留最终 CookieJar 身份；SameSite 仅来自对应服务器 Set-Cookie。"""
        cookies = []
        current = {}
        for item in self.session.cookies.jar:
            rest = {key.lower(): value for key, value in getattr(item, '_rest', {}).items()}
            http_only = rest.get('http_only')
            if http_only is not None and http_only not in (True, False, 'True', 'False', 'true', 'false'):
                raise TransportError('HTTP_COOKIE_METADATA_INVALID')
            cookie = {'name': item.name, 'value': item.value, 'domain': item.domain,
                      'path': item.path, 'expires': -1 if item.expires is None else item.expires,
                      'secure': item.secure, 'hostOnly': not item.domain_specified,
                      'httpOnly': (http_only in (True, 'True', 'true') if http_only is not None
                                   else 'httponly' in rest)}
            identity = (item.name, item.domain.lower().lstrip('.'), item.path, cookie['hostOnly'])
            if identity in current:
                raise TransportError('HTTP_COOKIE_METADATA_INVALID')
            signature = (item.value, item.secure, item.expires, cookie['httpOnly'])
            current[identity] = (cookie, signature)
            cookies.append(cookie)
        # 已删除、已过期或未经本模块解释而改变的 Cookie 不继承旧 SameSite。
        attributes = {identity: value for identity, value in self.cookie_attributes.items()
                      if identity in current and value['signature'] == current[identity][1]}
        origin = urlsplit(url)
        default_path = origin.path.rsplit('/', 1)[0] or '/'
        for header, text in raw_headers:
            if header.lower() != 'set-cookie':
                continue
            try:
                parsed = http.cookies.SimpleCookie()
                parsed.load(text)
                if len(parsed) != 1:
                    raise ValueError()
                name, morsel = next(iter(parsed.items()))
            except (http.cookies.CookieError, ValueError, TypeError):
                raise TransportError('HTTP_COOKIE_METADATA_INVALID') from None
            domain = morsel['domain'].lower().lstrip('.') or origin.hostname
            if origin.hostname != domain and not origin.hostname.endswith('.' + domain):
                continue
            path = morsel['path'] if morsel['path'].startswith('/') else default_path
            identity = (name, domain, path, not bool(morsel['domain']))
            accepted = current.get(identity)
            if accepted is None:
                continue
            cookie, signature = accepted
            # 只关联最终库接受的值和作用域；多条同名 Set-Cookie 按响应顺序处理。
            if (morsel.value != cookie['value'] or bool(morsel['secure']) != cookie['secure'] or
                    bool(morsel['httponly']) != cookie['httpOnly']):
                continue
            attributes.pop(identity, None)
            same_site = morsel['samesite'].lower()
            if same_site in ('strict', 'lax', 'none'):
                attributes[identity] = {'signature': signature, 'sameSite': same_site.title()}
        self.cookie_attributes = attributes
        for identity, value in attributes.items():
            current[identity][0]['sameSite'] = value['sameSite']
        return cookies

    def request(self, value):
        if self.session is None:
            raise TransportError('HTTP_NOT_INITIALIZED')
        url, method, headers, body, timeout_ms = validate_request(value)
        chunks = bytearray()
        overflow = False

        def collect(chunk):
            nonlocal overflow
            if len(chunks) + len(chunk) > MAX_BODY_BYTES:
                overflow = True
                return WRITE_ERROR
            chunks.extend(chunk)
            return len(chunk)

        try:
            response = self.session.request(method, url, headers=headers, data=body,
                                            timeout=timeout_ms / 1000, verify=True,
                                            allow_redirects=False, max_redirects=0,
                                            content_callback=collect)
        except Exception as error:
            if overflow:
                raise TransportError('HTTP_RESPONSE_TOO_LARGE') from None
            code = getattr(error, 'code', None)
            status = getattr(getattr(error, 'response', None), 'status_code', None)
            if status in (407, 429, 541):
                raise TransportError('HTTP_' + str(status)) from None
            if code == 28:
                raise TransportError('HTTP_TIMEOUT') from None
            if code in (51, 58, 60, 77, 83, 90, 91):
                raise TransportError('HTTP_TLS_FAILED') from None
            if code in (5, 6, 7, 35, 52, 55, 56, 97):
                raise TransportError('PROXY_CONNECTION_FAILED') from None
            raise TransportError('HTTP_TRANSPORT_FAILED') from None
        if overflow:
            raise TransportError('HTTP_RESPONSE_TOO_LARGE')
        effective_url = permitted_url(response.url)
        if effective_url != url:
            raise TransportError('HTTP_UNEXPECTED_REDIRECT')
        raw_headers = list(response.headers.multi_items())
        if len(json.dumps(raw_headers).encode('utf8')) > MAX_METADATA_BYTES:
            raise TransportError('HTTP_RESPONSE_METADATA_TOO_LARGE')
        cookies = self.cookie_metadata(effective_url, raw_headers)
        metadata = {'status': response.status_code, 'url': effective_url,
                    'rawHeaders': raw_headers, 'cookies': cookies}
        if len(json.dumps(metadata).encode('utf8')) > MAX_METADATA_BYTES:
            raise TransportError('HTTP_RESPONSE_METADATA_TOO_LARGE')
        return dict(metadata, bodyBase64=base64.b64encode(chunks).decode('ascii'))

    def close(self):
        if self.session is not None:
            try:
                self.session.close()
            finally:
                self.session = None
                self.cookie_attributes.clear()


def serve(input_stream, output_stream, transport=None):
    """按行串行执行，一行一个结果；无效或过长输入不会发出 HTTP 请求。"""
    transport = transport or HttpTransport()
    last_id = 0
    try:
        while True:
            line = input_stream.readline(MAX_INPUT_BYTES + 1)
            if not line:
                return
            request_id = None
            terminal = False
            try:
                if len(line) > MAX_INPUT_BYTES or not line.endswith(b'\n'):
                    raise TransportError('HTTP_PROTOCOL_INVALID')
                value = json.loads(line)
                if not isinstance(value, dict) or type(value.get('id')) is not int or value['id'] <= last_id:
                    raise TransportError('HTTP_PROTOCOL_INVALID')
                request_id = value['id']
                last_id = request_id
                operation = value.get('op')
                if operation == 'init':
                    result = transport.initialize(value)
                elif operation == 'request':
                    result = transport.request(value)
                elif operation == 'close' and set(value) == {'id', 'op'}:
                    transport.close()
                    result = {'closed': True}
                    terminal = True
                else:
                    raise TransportError('HTTP_PROTOCOL_INVALID')
                output = {'id': request_id, 'ok': True, 'result': result}
            except TransportError as error:
                output = {'id': request_id, 'ok': False, 'code': str(error)}
                terminal = True
            except Exception:
                output = {'id': request_id, 'ok': False, 'code': 'HTTP_PROTOCOL_FAILED'}
                terminal = True
            output_stream.write(json.dumps(output, separators=(',', ':')) + '\n')
            output_stream.flush()
            if terminal:
                return
    finally:
        transport.close()


if __name__ == '__main__':
    try:
        serve(sys.stdin.buffer, sys.stdout)
    except Exception:
        # stdout 不混入 traceback、URL、响应或凭据；父进程将 EOF 归为固定错误。
        sys.exit(1)
