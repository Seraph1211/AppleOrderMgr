#!/usr/bin/env python3
"""发布前端权限与版本切换门禁；兼容生产 Python 3.6，仅使用标准库。"""
import argparse
import fcntl
import hashlib
import json
import os
import pwd
import posixpath
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from html.parser import HTMLParser
from pathlib import Path


class GateError(Exception):
    """只向调用方暴露固定错误码，避免泄露业务正文或敏感 URL。"""

    def __init__(self, code, rolledBack=False):
        super().__init__(code)
        self.code = code
        self.rolledBack = rolledBack


def require(condition, code):
    """条件不满足时中止发布。"""
    if not condition:
        raise GateError(code)


class EntryAssets(HTMLParser):
    """读取入口真正引用的脚本、样式和模块预载资源。"""

    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        url = None
        if tag == 'script':
            url = attrs.get('src')
        elif tag == 'link' and set(attrs.get('rel', '').split()) & {
                'stylesheet', 'modulepreload'}:
            url = attrs.get('href')
            # Google Fonts 等第三方样式不是本站发布制品，不向外部服务发验收请求。
            if url and 'stylesheet' in attrs.get('rel', '').split():
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme or parsed.netloc:
                    return
        if url is not None:
            self.urls.append(url)


ASSET_REFERENCE = re.compile(
    r'''["']((?:/assets/|assets/|\./)[A-Za-z0-9@._/-]+\.(?:js|css))["']''')


def referencedAssets(path, webPath):
    """提取 Vite 产物中的本地 JS/CSS 依赖，覆盖静态导入、动态导入和预载表。"""
    if path.suffix not in ('.js', '.css'):
        return []
    text = path.read_text(encoding='utf-8')
    references = []
    for raw in ASSET_REFERENCE.findall(text):
        if raw.startswith('/assets/'):
            target = raw
        elif raw.startswith('assets/'):
            target = '/' + raw
        else:
            target = posixpath.normpath(posixpath.join(posixpath.dirname(webPath), raw))
        require(target.startswith('/assets/') and '..' not in target.split('/'),
                'LAZY_ASSET_URL_INVALID')
        references.append(target)
    return references


def capabilityProof(release, assets):
    """核验能力证明与实际可达资源；兼容首次登记前的历史回退版本。"""
    path = Path(release) / 'capabilities.json'
    if not path.exists():
        return {}
    require(path.is_file() and not path.is_symlink(), 'CAPABILITY_MANIFEST_INVALID')
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        require(data.get('schemaVersion') == 1, 'CAPABILITY_MANIFEST_INVALID')
        expected = data['assets']
        require(set(expected) == set(assets), 'CAPABILITY_ASSETS_CHANGED')
        for url, asset in assets.items():
            require(expected[url] == fileDigest(asset).hex(), 'CAPABILITY_ASSETS_CHANGED')
        capabilities = {}
        require(bool(data['capabilities']), 'CAPABILITY_MANIFEST_EMPTY')
        for item in data['capabilities']:
            identifier = item['id']
            require(isinstance(identifier, str) and identifier and identifier not in capabilities,
                    'CAPABILITY_MANIFEST_INVALID')
            tokens = item['tokens']
            require(isinstance(tokens, dict), 'CAPABILITY_MANIFEST_INVALID')
            for token, url in tokens.items():
                require(isinstance(token, str) and bool(token) and url in assets
                        and assets[url].suffix == '.js', 'CAPABILITY_PROOF_INVALID')
                require(token in assets[url].read_text(encoding='utf-8'),
                        'CAPABILITY_BUILD_REGRESSED')
            capabilities[identifier] = set(tokens)
        return capabilities
    except GateError:
        raise
    except Exception:
        raise GateError('CAPABILITY_MANIFEST_INVALID')


def rejectDroppedCapabilities(release, expectedCurrent, rollback=False):
    """已登记的能力和行为证据只能保留或增加，禁止缺清单或缩减后切换。"""
    _release, _directories, _files, assets = inventory(release)
    _old, _directories, _files, oldAssets = inventory(expectedCurrent)
    previous = capabilityProof(expectedCurrent, oldAssets)
    candidate = capabilityProof(release, assets)
    if rollback:
        try:
            proof = json.loads((Path(expectedCurrent) / 'rollback-target.json').read_text(encoding='utf-8'))
            expectedAssets = {url: fileDigest(path).hex() for url, path in assets.items()}
            require(proof.get('releasePath') == str(Path(release).resolve())
                    and proof.get('assets') == expectedAssets
                    and proof.get('indexSha256') == fileDigest(
                        Path(release) / 'frontend/index.html').hex(), 'CAPABILITY_ROLLBACK_UNPROVEN')
        except GateError:
            raise
        except Exception:
            raise GateError('CAPABILITY_ROLLBACK_UNPROVEN')
        return
    require(not previous or bool(candidate), 'CAPABILITY_MANIFEST_MISSING')
    for identifier, tokens in previous.items():
        require(identifier in candidate and tokens <= candidate[identifier],
                'RELEASE_CAPABILITY_DROPPED')
    previousSource = sourceCapabilityIds(expectedCurrent)
    candidateSource = sourceCapabilityIds(release)
    require(not previousSource or bool(candidateSource), 'SOURCE_CAPABILITY_MANIFEST_MISSING')
    require(previousSource <= candidateSource, 'SOURCE_CAPABILITY_DROPPED')
    previousMigrations = migrationHistory(expectedCurrent)
    candidateMigrations = migrationHistory(release)
    for name, checksum in previousMigrations.items():
        require(candidateMigrations.get(name) == checksum, 'MIGRATION_HISTORY_CHANGED')


def migrationHistory(release):
    """已登记的正式Migration只能追加，不能遗失或改写历史字节。"""
    path = Path(release) / 'source-capabilities.json'
    if not path.exists():
        return {}
    try:
        inventory = json.loads(path.read_text(encoding='utf-8'))['sourceInventory']
        require(isinstance(inventory, dict), 'SOURCE_CAPABILITY_MANIFEST_INVALID')
        return {name: value for name, value in inventory.items() if name.startswith('migrations/')}
    except GateError:
        raise
    except Exception:
        raise GateError('SOURCE_CAPABILITY_MANIFEST_INVALID')


def sourceCapabilityIds(release):
    """源码能力独立比较；API 增量保全前端字节也不能丢弃后端新能力。"""
    path = Path(release) / 'source-capabilities.json'
    if not path.exists():
        return set()
    try:
        require(not path.is_symlink() and path.is_file(), 'SOURCE_CAPABILITY_MANIFEST_INVALID')
        data = json.loads(path.read_text(encoding='utf-8'))
        rows = data['capabilities']
        ids = set(row['id'] for row in rows)
        require(data['schemaVersion'] == 1 and ids and len(ids) == len(rows),
                'SOURCE_CAPABILITY_MANIFEST_INVALID')
        return ids
    except GateError:
        raise
    except Exception:
        raise GateError('SOURCE_CAPABILITY_MANIFEST_INVALID')


def inventory(release):
    """先检查完整公开树，不跟随符号链接或处理设备文件。"""
    release = Path(release).absolute()
    require(not release.is_symlink() and release.is_dir(), 'RELEASE_DIRECTORY_INVALID')
    require(release == release.resolve(), 'RELEASE_PARENT_SYMLINK')
    frontend = release / 'frontend'
    require(not frontend.is_symlink() and frontend.is_dir(), 'FRONTEND_DIRECTORY_INVALID')
    directories, files = [release, frontend], []
    for root, dirNames, fileNames in os.walk(str(frontend), followlinks=False):
        for name in dirNames + fileNames:
            path = Path(root) / name
            mode = path.lstat().st_mode
            require(not stat.S_ISLNK(mode), 'FRONTEND_SYMLINK_REJECTED')
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), 'FRONTEND_SPECIAL_FILE')
            (directories if stat.S_ISDIR(mode) else files).append(path)
    require(frontend / 'index.html' in files, 'INDEX_MISSING')
    parser = EntryAssets()
    parser.feed((frontend / 'index.html').read_text(encoding='utf-8'))
    require(bool(parser.urls), 'ENTRY_ASSETS_MISSING')
    assets = {}
    fileByUrl = {'/' + str(path.relative_to(frontend)).replace(os.sep, '/'): path
                 for path in files}
    for url in parser.urls:
        parsed = urllib.parse.urlsplit(url)
        decoded = urllib.parse.unquote(parsed.path)
        require(not parsed.scheme and not parsed.netloc and not parsed.query
                and not parsed.fragment and decoded.startswith('/assets/')
                and '\\' not in decoded and '..' not in decoded.split('/'),
                'ENTRY_ASSET_URL_INVALID')
        path = frontend / decoded.lstrip('/')
        require(path in files, 'ENTRY_ASSET_MISSING')
        require(path.suffix in ('.js', '.css'), 'ENTRY_ASSET_TYPE_INVALID')
        assets[parsed.path] = path
    pending = list(assets)
    while pending:
        sourceUrl = pending.pop()
        for targetUrl in referencedAssets(assets[sourceUrl], sourceUrl):
            require(targetUrl in fileByUrl, 'LAZY_ASSET_MISSING')
            target = fileByUrl[targetUrl]
            require(target.suffix in ('.js', '.css'), 'LAZY_ASSET_TYPE_INVALID')
            if targetUrl not in assets:
                assets[targetUrl] = target
                pending.append(targetUrl)
    capabilityProof(release, assets)
    return release, directories, files, assets


def prepare(release):
    """仅规范公开目录及前端文件，其他发布文件保留原权限。"""
    release, directories, files, _assets = inventory(release)
    for directory in directories:
        directory.chmod(0o755)
    for path in files:
        path.chmod(0o644)
    return {'passed': True, 'directories': len(directories), 'files': len(files)}


def check(release, nginxUser='nginx', permissionsOnly=False, expectedCurrent=None):
    """校验明确权限及 Nginx 用户读取全部文件的能力，root 自身可读不作证据。"""
    release, directories, files, _assets = inventory(release)
    require(all(stat.S_IMODE(p.stat().st_mode) == 0o755 for p in directories),
            'PUBLIC_DIRECTORY_MODE')
    require(all(stat.S_IMODE(p.stat().st_mode) == 0o644 for p in files),
            'PUBLIC_FILE_MODE')
    if not permissionsOnly:
        # 容器 Nginx 的 UID/GID 可能不在宿主机 passwd 中；显式 UID:GID 按实际身份降权。
        if ':' in nginxUser:
            parts = nginxUser.split(':')
            require(len(parts) == 2 and all(p.isdigit() for p in parts),
                    'NGINX_IDENTITY_INVALID')
            uid, gid = [int(p) for p in parts]
            require(0 < uid < 4294967295 and 0 < gid < 4294967295,
                    'NGINX_IDENTITY_INVALID')
            identityCommand = ['setpriv', '--reuid', str(uid), '--regid', str(gid),
                               '--clear-groups', '--']
        else:
            require(pwd.getpwnam(nginxUser).pw_uid != 0, 'NGINX_USER_IS_ROOT')
            identityCommand = ['runuser', '-u', nginxUser, '--']
        # 子进程实际降权后打开文件；单次启动且路径经 JSON stdin 传入，不插值 shell。
        code = ('import json,sys\n'
                'for path in json.load(sys.stdin):\n'
                ' with open(path,"rb") as f: f.read(1)\n')
        result = subprocess.run(
            identityCommand + [sys.executable, '-c', code],
            input=json.dumps([str(p) for p in files]).encode('utf-8'),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        require(result.returncode == 0, 'NGINX_CANNOT_READ_FRONTEND')
    if expectedCurrent:
        rejectChangedImmutableAssets(release, expectedCurrent)
        rejectDroppedCapabilities(release, expectedCurrent)
        if (release / 'capabilities.json').is_file():
            rejectDroppedCapabilities(expectedCurrent, release, rollback=True)
    return {'passed': True, 'files': len(files), 'nginxUserChecked': not permissionsOnly}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """登录跳转或错误跳转均不算前端发布成功。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def origin(baseUrl, allowHttpLoopback=False):
    """限定无凭据的单一站点；明文 HTTP 只允许显式启用的回环测试。"""
    parsed = urllib.parse.urlsplit(baseUrl)
    schemeValid = parsed.scheme == 'https' or (
        allowHttpLoopback and parsed.scheme == 'http'
        and parsed.hostname in ('127.0.0.1', 'localhost', '::1'))
    require(schemeValid and bool(parsed.hostname) and parsed.username is None
            and parsed.password is None and parsed.path in ('', '/')
            and not parsed.query and not parsed.fragment, 'BASE_URL_INVALID')
    return baseUrl.rstrip('/')


def fileDigest(path):
    """有界读取静态资源摘要。"""
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    return digest.digest()


def rejectChangedImmutableAssets(release, expectedCurrent):
    """同一 immutable URL 不得在相邻发布间换内容，否则浏览器会混用两版模块。"""
    _release, _directories, _files, candidate = inventory(release)
    _current, _directories, _files, current = inventory(expectedCurrent)
    for url in set(candidate) & set(current):
        require(fileDigest(candidate[url]) == fileDigest(current[url]),
                'IMMUTABLE_ASSET_REUSED')


def verify(release, baseUrl, allowHttpLoopback=False):
    """验证网页和入口资源的类型、长度、摘要，以及 API 数据库就绪状态。"""
    baseUrl = origin(baseUrl, allowHttpLoopback)
    release, _directories, _files, assets = inventory(release)
    checks = {route: (release / 'frontend/index.html', {'text/html'})
              for route in ('/', '/orders', '/login')}
    for url, path in assets.items():
        checks[url] = (path, {'text/css'} if path.suffix == '.css' else {
            'application/javascript', 'text/javascript'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        for route, (path, types) in checks.items():
            request = urllib.request.Request(baseUrl + route, headers={
                'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
            with opener.open(request, timeout=10) as response:
                require(response.status == 200, 'FRONTEND_HTTP_STATUS')
                require(response.headers.get_content_type() in types, 'FRONTEND_HTTP_TYPE')
                digest, length = hashlib.sha256(), 0
                expectedLength = path.stat().st_size
                while True:
                    chunk = response.read(min(65536, expectedLength + 1 - length))
                    if not chunk:
                        break
                    length += len(chunk)
                    require(length <= expectedLength, 'FRONTEND_HTTP_LENGTH')
                    digest.update(chunk)
                require(length == expectedLength and digest.digest() == fileDigest(path),
                        'FRONTEND_HTTP_DIGEST')
        with opener.open(baseUrl + '/api/health/ready', timeout=10) as response:
            require(response.status == 200 and response.headers.get_content_type()
                    == 'application/json', 'API_NOT_READY')
            payload = json.loads(response.read(16385).decode('utf-8'))
            data = payload.get('data', {})
            require(payload.get('success') is True and data.get('status') == 'healthy'
                    and data.get('db') == 'ok', 'API_NOT_READY')
    except urllib.error.HTTPError as error:
        error.close()
        raise GateError('PUBLIC_HTTP_CHECK_FAILED')
    except (urllib.error.URLError, OSError, ValueError):
        raise GateError('PUBLIC_HTTP_CHECK_FAILED')
    return {'passed': True, 'pages': 3, 'assets': len(assets), 'apiReady': True}


def replaceLink(current, release):
    """在同一父目录创建临时链接并原子替换。"""
    temporary = current.parent / ('.frontend-next-' + uuid.uuid4().hex)
    try:
        temporary.symlink_to(release)
        os.replace(str(temporary), str(current))
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def switch(release, current, expectedCurrent, baseUrl, nginxUser='nginx',
           allowHttpLoopback=False, rollback=False):
    """带锁切换；前端/公网门禁失败恢复指针，API 回退由上层发布器负责。"""
    origin(baseUrl, allowHttpLoopback)
    release, current, expectedCurrent = [Path(p).absolute()
                                        for p in (release, current, expectedCurrent)]
    releases = current.parent / 'releases'
    require(release.parent == releases and expectedCurrent.parent == releases
            and release != expectedCurrent, 'RELEASE_LAYOUT_INVALID')
    lockPath = current.parent / '.frontend-release.lock'
    fd = os.open(str(lockPath), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(current.is_symlink() and current.resolve() == expectedCurrent,
                'CURRENT_CHANGED')
        check(release, nginxUser)
        check(expectedCurrent, nginxUser)
        rejectChangedImmutableAssets(release, expectedCurrent)
        rejectDroppedCapabilities(release, expectedCurrent, rollback)
        replaceLink(current, release)
        try:
            result = verify(release, baseUrl, allowHttpLoopback)
            require(current.resolve() == release, 'CURRENT_CHANGED')
        except Exception as error:
            require(current.is_symlink() and current.resolve() == release,
                    'CURRENT_CHANGED_DURING_ROLLBACK')
            replaceLink(current, expectedCurrent)
            try:
                verify(expectedCurrent, baseUrl, allowHttpLoopback)
            except Exception:
                raise GateError('ROLLBACK_HTTP_CHECK_FAILED', rolledBack=True)
            code = error.code if isinstance(error, GateError) else 'PUBLIC_HTTP_CHECK_FAILED'
            raise GateError(code, rolledBack=True)
        return dict(result, switched=True, rolledBack=False)


def main():
    """命令行只输出固定错误码及数量，不输出响应正文或访问令牌。"""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    for name in ('prepare', 'check', 'verify', 'switch'):
        command = sub.add_parser(name)
        command.add_argument('release')
        if name in ('check', 'switch'):
            command.add_argument('--nginx-user', default='nginx')
        if name == 'check':
            command.add_argument('--permissions-only', action='store_true')
            command.add_argument('--expected-current')
        if name in ('verify', 'switch'):
            command.add_argument('--base-url', required=True)
            command.add_argument('--allow-http-loopback', action='store_true')
        if name == 'switch':
            command.add_argument('--current', required=True)
            command.add_argument('--expected-current', required=True)
            command.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    try:
        require(args.command is not None, 'COMMAND_REQUIRED')
        if args.command == 'prepare':
            result = prepare(args.release)
        elif args.command == 'check':
            result = check(args.release, args.nginx_user, args.permissions_only, args.expected_current)
        elif args.command == 'verify':
            result = verify(args.release, args.base_url, args.allow_http_loopback)
        else:
            result = switch(args.release, args.current, args.expected_current,
                            args.base_url, args.nginx_user, args.allow_http_loopback, args.rollback)
        print(json.dumps(result))
        return 0
    except Exception as error:
        result = {'passed': False, 'code': error.code if isinstance(error, GateError)
                  else 'FRONTEND_GATE_FAILED'}
        if isinstance(error, GateError) and error.rolledBack:
            result['rolledBack'] = True
        print(json.dumps(result))
        return 1


if __name__ == '__main__':
    sys.exit(main())
