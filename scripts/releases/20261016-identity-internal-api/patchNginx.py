"""从真实站点生成最小安全补丁；不整体套用仓库模板，不写生产配置。"""
import re

FORMAT = 'identity_internal_safe_20261016'
FORMAT_LINE = "log_format " + FORMAT + " '$remote_addr [$time_local] \"$request_method $uri $server_protocol\" $status $body_bytes_sent';\n"
MARKER = '# identity-internal-api 20261016'
HTTP_LOCATION = '''
    # identity-internal-api 20261016 HTTP入口直接拒绝，禁止带query跳转。
    location ~* ^/api/internal/v1/identity {
        access_log off;
        error_log /dev/null crit;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        return 400;
    }
'''
TLS_LOCATION = '''
    # identity-internal-api 20261016 TLS入口不记录query/Referer，不缓存、不重试。
    location ~* ^/api/internal/v1/identity {
        access_log off;
        error_log /dev/null crit;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Referer "";
        proxy_cache off;
        proxy_store off;
        proxy_next_upstream off;
        proxy_connect_timeout 3s;
        proxy_send_timeout 10s;
        proxy_read_timeout 15s;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy "no-referrer" always;
    }
'''


def depths(text):
    result, depth, quoted, comment, escaped = [], 0, '', False, False
    for ch in text:
        result.append(depth)
        if comment:
            if ch == '\n': comment = False
        elif escaped:
            escaped = False
        elif ch == '\\':
            escaped = True
        elif quoted:
            if ch == quoted: quoted = ''
        elif ch == '#': comment = True
        elif ch in ['"', "'"]: quoted = ch
        elif ch == '{': depth += 1
        elif ch == '}': depth -= 1
        assert depth >= 0, 'NGINX_UNBALANCED_BRACES'
    assert depth == 0 and not quoted, 'NGINX_UNBALANCED_CONFIG'
    return result


def patch_site(original, server_name):
    assert MARKER not in original and FORMAT not in original, 'NGINX_PATCH_ALREADY_PRESENT'
    assert re.fullmatch(r'[A-Za-z0-9.-]+', server_name)
    levels = depths(original)
    replacements, modes = [], []
    for match in re.finditer(r'(?m)^[ \t]*server\s*\{', original):
        opening = original.index('{', match.start(), match.end())
        end = opening + 1
        while end < len(original):
            if original[end] == '}' and levels[end] == levels[opening] + 1 and (end + 1 == len(original) or levels[end + 1] == levels[opening]): break
            end += 1
        block = original[match.start():end + 1]
        names = re.search(r'\bserver_name\s+([^;]+);', block)
        if not names or server_name not in names.group(1).split(): continue
        assert names.group(1).split() == [server_name], 'MULTI_DOMAIN_SERVER_REQUIRES_REVIEW'
        assert not re.search(r'location\s+(?:=\s+)?[^;{]*?/api/internal/v1/identity', block), 'EXISTING_IDENTITY_LOCATION_REQUIRES_REVIEW'
        # ^~ 匹配会绕过正则安全入口，不能静默覆盖其他功能规则。
        assert not re.search(r'location\s+\^~\s+/(?:api(?:/[^\s{]*)?)?\s*\{', block), 'PREFIX_PRIORITY_REQUIRES_REVIEW'
        is_tls = bool(re.search(r'\blisten\s+[^;]*\b443\b', block))
        is_http = bool(re.search(r'\blisten\s+[^;]*\b80\b', block))
        assert is_tls != is_http, 'UNEXPECTED_LISTEN_REQUIRES_REVIEW'
        mode = 'tls' if is_tls else 'http'
        modes.append(mode)
        d = depths(block)
        edits = []
        redirect = False
        for directive in re.finditer(r'(?m)^[ \t]*(access_log|error_log|return|rewrite|if)\b[^;]*;', block):
            token_start = directive.start() + len(directive.group(0)) - len(directive.group(0).lstrip())
            if d[token_start] != 1: continue
            kind = directive.group(1)
            if kind in ['access_log', 'error_log']:
                edits.append((directive.start(), directive.end(), ''))
            elif kind == 'return' and is_http:
                assert re.search(r'return\s+30[18]\s+https://(?:\$server_name|\$host|' + re.escape(server_name) + r')\$request_uri\s*;', directive.group(0)), 'HTTP_RETURN_REQUIRES_REVIEW'
                redirect = True
                edits.append((directive.start(), directive.end(), ''))
            elif kind in ['return', 'rewrite', 'if']:
                raise AssertionError('SERVER_REWRITE_REQUIRES_REVIEW')
        for start, stop, replacement in sorted(edits, reverse=True):
            block = block[:start] + replacement + block[stop:]
        names = re.search(r'\bserver_name\s+[^;]+;', block)
        addition = '\n    ' + MARKER + ' 站点安全日志，覆盖location解析前异常。\n    access_log /var/log/nginx/apple-order-mgr-access.log ' + FORMAT + ';\n    error_log /dev/null crit;\n    add_header Cache-Control "no-store" always;\n    add_header Referrer-Policy "no-referrer" always;\n' + (TLS_LOCATION if is_tls else HTTP_LOCATION)
        if redirect:
            assert not re.search(r'location\s+/\s*\{', block), 'DUPLICATE_ROOT_LOCATION_REQUIRES_REVIEW'
            addition += '\n    location / { return 301 https://$server_name$request_uri; }\n'
        block = block[:names.end()] + addition + block[names.end():]
        replacements.append((match.start(), end + 1, block))
    assert sorted(modes) == ['http', 'tls'], 'EXPECTED_EXACTLY_HTTP_AND_TLS_TARGET_SERVERS'
    result = original
    for start, end, block in sorted(replacements, reverse=True):
        result = result[:start] + block + result[end:]
    return FORMAT_LINE + result
