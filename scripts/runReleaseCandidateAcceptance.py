#!/usr/bin/env python3
"""在临时回环服务器上验收指定最终前端制品，避免误用开发预览目录。"""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
import threading


class CandidateHandler(SimpleHTTPRequestHandler):
    """只对 SPA 页面回退；缺失静态资源保持 404。"""

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if not self.path.startswith('/assets/'):
            self.path = '/index.html'
        super().do_GET()


def main():
    """使用正式制品目录和临时端口运行现有真实浏览器验收。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', default=os.environ.get('RELEASE_CANDIDATE'))
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not args.candidate:
        parser.error('--candidate or RELEASE_CANDIDATE required')
    directory = Path(args.candidate) / 'frontend'
    if not directory.is_absolute() or not (directory / 'index.html').is_file():
        parser.error('CANDIDATE_FRONTEND_MISSING')
    handler = functools.partial(CandidateHandler, directory=str(directory))
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        environment = os.environ.copy()
        environment['CAPABILITIES_BROWSER_URL'] = 'http://127.0.0.1:' + str(server.server_port)
        environment['CAPABILITIES_BROWSER_OUTPUT'] = args.output
        script = Path(__file__).resolve().parents[1] / 'test/browser/productionCapabilitiesAcceptance.cjs'
        return subprocess.run(['node', str(script)], env=environment, timeout=600).returncode
    except (OSError, subprocess.TimeoutExpired):
        return 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    sys.exit(main())
