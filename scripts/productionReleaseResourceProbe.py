#!/usr/bin/env python3
"""发布并行资源探针；只访问本机只读健康端点并输出三项数值。"""
import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


class ProbeError(Exception):
    """资源探针固定错误码。"""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def require(condition, code):
    """条件不满足时失败关闭。"""
    if not condition:
        raise ProbeError(code)


def parseCommand(value):
    """解析不经 shell 的锁等待探针 argv。"""
    try:
        command = json.loads(value)
    except ValueError:
        raise ProbeError('LOCK_PROBE_COMMAND_INVALID')
    require(isinstance(command, list) and command
            and all(isinstance(item, str) and item for item in command),
            'LOCK_PROBE_COMMAND_INVALID')
    return command


def probeApi(url, timeout):
    """测量本机只读健康端点延迟，拒绝外部网络目标。"""
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme in ('http', 'https')
            and parsed.hostname in ('127.0.0.1', '::1')
            and parsed.path == '/api/health/ready'
            and not parsed.params and not parsed.query and not parsed.fragment
            and not parsed.username and not parsed.password,
            'API_PROBE_URL_INVALID')
    started = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read(65537)
            status = response.getcode()
    except Exception:
        raise ProbeError('API_PROBE_FAILED')
    latency = int((time.monotonic() - started) * 1000)
    require(status == 200 and len(body) <= 65536, 'API_PROBE_FAILED')
    try:
        payload = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise ProbeError('API_PROBE_INVALID')
    data = payload.get('data', {}) if isinstance(payload, dict) else {}
    require(payload.get('success') is True and data.get('status') == 'healthy'
            and data.get('db') == 'ok',
            'API_PROBE_UNHEALTHY')
    return latency


def probeLockWait(command, timeout):
    """执行只读数据库锁等待命令，只接受非负毫秒数。"""
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ProbeError('LOCK_PROBE_TIMEOUT')
    require(result.returncode == 0 and len(result.stdout) <= 65536,
            'LOCK_PROBE_FAILED')
    try:
        text = result.stdout.decode('utf-8').strip()
        payload = json.loads(text)
        value = payload.get('lockWaitMs') if isinstance(payload, dict) else payload
    except (UnicodeDecodeError, ValueError):
        raise ProbeError('LOCK_PROBE_INVALID')
    require(isinstance(value, int) and not isinstance(value, bool) and value >= 0,
            'LOCK_PROBE_INVALID')
    return value


def collect(diskPath, apiUrl, lockCommand, timeout):
    """采集磁盘余量、API延迟和数据库锁等待。"""
    path = Path(diskPath)
    require(path.exists(), 'DISK_PROBE_PATH_INVALID')
    free = shutil.disk_usage(str(path)).free
    return {
        'passed': True,
        'diskFreeBytes': int(free),
        'apiLatencyMs': probeApi(apiUrl, timeout),
        'lockWaitMs': probeLockWait(lockCommand, timeout),
    }


def main():
    """CLI只输出非敏感资源数值或固定错误码。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--disk-path', required=True)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--lock-command-json', required=True)
    parser.add_argument('--timeout-seconds', type=int, default=10)
    args = parser.parse_args()
    try:
        require(1 <= args.timeout_seconds <= 60, 'PROBE_TIMEOUT_INVALID')
        result = collect(args.disk_path, args.api_url,
                         parseCommand(args.lock_command_json),
                         args.timeout_seconds)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, ProbeError) else 'RESOURCE_PROBE_FAILED'
        print(json.dumps({'passed': False, 'code': code}, sort_keys=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
