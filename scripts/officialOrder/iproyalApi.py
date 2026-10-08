"""IPRoyal 住宅代理 API；只生成已有套餐代理，不购买、不记录凭据。"""
import json
import os
import re
import stat
import urllib.request

API = 'https://resi-api.iproyal.com/v1/access/generate-proxy-list'


def read_private(path):
    with os.fdopen(os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW), 'r', encoding='utf-8') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 1048576:
            raise RuntimeError('IPROYAL_CONFIG_INVALID')
        return json.load(stream)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def generate_proxy(config):
    """生成一个独立中国区粘性会话；失败不自动重复 API 请求。"""
    if not isinstance(config, dict) or not isinstance(config.get('apiToken'), str) or not config['apiToken']:
        raise RuntimeError('IPROYAL_CONFIG_INVALID')
    body = {'format': '{hostname}:{port}:{username}:{password}', 'hostname': 'geo.iproyal.com',
            'port': 'http|https', 'rotation': 'sticky', 'location': '_country-cn',
            'proxy_count': 1, 'lifetime': '24h'}
    if config.get('subuserHash'):
        body['subuser_hash'] = config['subuserHash']
    elif config.get('username') and config.get('password'):
        body.update(username=config['username'], password=config['password'])
    else:
        raise RuntimeError('IPROYAL_CONFIG_INVALID')
    try:
        request = urllib.request.Request(API, data=json.dumps(body).encode(), headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['apiToken']})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            data = json.loads(response.read(65537))
        if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], str):
            raise ValueError()
        host, port, username, password = data[0].split(':', 3)
        if (host != 'geo.iproyal.com' or not port.isdigit() or not 1 <= int(port) <= 65535 or
                not username or any(ord(c) < 32 for c in data[0]) or
                '_country-cn' not in password or '_lifetime-24h' not in password or
                not re.search(r'_session-[A-Za-z0-9]+(?:_|$)', password)):
            raise ValueError()
        if '_killswitch-' in password and '_killswitch-1' not in password:
            raise ValueError()
        if '_killswitch-1' not in password:
            password += '_killswitch-1'
        return {'host': host, 'port': int(port), 'username': username, 'password': password, 'provider': 'iproyal'}
    except Exception:
        raise RuntimeError('IPROYAL_API_FAILED') from None
