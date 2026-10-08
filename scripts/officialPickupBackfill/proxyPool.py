"""用户提供的固定 IPRoyal 配置池；跨槽原子领取，不改写供应商会话。"""
import hashlib
import json
import pathlib
import re
import time

from runtime import fileLock, readJson, writeJson

IPROYAL_LEASE_SECONDS = 86400


def proxyHash(proxy):
    if proxy.get('provider') == 'iproyal':
        value = json.dumps([proxy['host'], int(proxy['port']), proxy['username'], proxy['password']],
                           ensure_ascii=False, separators=(',', ':'))
    else:
        value = proxy['host'] + ':' + str(proxy['port']) + ':' + proxy['username']
    return hashlib.sha256(value.encode()).hexdigest()


def providerFor(root):
    path = root / 'private/proxy-provider.json'
    provider = readJson(path).get('provider') if path.exists() else 'fanproxy'
    if provider not in ('fanproxy', 'iproyal'):
        raise RuntimeError('PROXY_PROVIDER_INVALID')
    return provider


class ProvidedProxyPool:
    def __init__(self, root):
        self.root = root
        path = root / 'private/iproyal-proxies.json'
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise RuntimeError('PROXY_POOL_PERMISSIONS')
        data = readJson(path)
        if data.get('provider', '').lower() != 'iproyal':
            raise RuntimeError('PROXY_POOL_INVALID')
        self.entries = {}
        for entry in data.get('entries', []):
            if (not isinstance(entry, dict) or
                    not re.fullmatch(r'[a-zA-Z0-9.-]+', str(entry.get('host', ''))) or
                    not isinstance(entry.get('port'), int) or not 1 <= entry['port'] <= 65535 or
                    any(not isinstance(entry.get(k), str) or not entry[k] or
                        any(ord(c) < 32 for c in entry[k]) for k in ('username', 'password')) or
                    not re.search(r'_session-[A-Za-z0-9]{8}(?:_|$)', entry['password']) or
                    not re.search(r'_lifetime-24h(?:_|$)', entry['password'])):
                raise RuntimeError('PROXY_POOL_INVALID')
            proxy = {k: entry[k] for k in ('host', 'port', 'username', 'password')}
            proxy.update(provider='iproyal', preemptiveAuth=True, maxConnections=16)
            self.entries[proxyHash(proxy)] = proxy
        if not self.entries or len(self.entries) > 1000:
            raise RuntimeError('PROXY_POOL_INVALID')
        self.statePath = root / 'private/iproyal-pool-state.json'
        self.lockPath = root / 'private/iproyal-pool.lock'

    def state(self):
        return readJson(self.statePath) if self.statePath.exists() else {}

    def claim(self, slot, avoidEgress=None):
        with fileLock(self.lockPath):
            state = self.state()
            for key, row in state.items():
                if row.get('slot') == slot and row['status'] == 'claimed':
                    if key in self.entries and 0 <= time.time() - row['startedAt'] < IPROYAL_LEASE_SECONDS - 210:
                        if avoidEgress and row.get('egressHash') == avoidEgress:
                            row.update(status='available', slot=None)
                            continue
                        return self.entries[key], dict(row)
                    row.update(status='retired', reason='LEASE_EXPIRED')
            for key, proxy in sorted(self.entries.items(), key=lambda item: state.get(item[0], {}).get('lastUsedAt', 0)):
                row = state.get(key)
                if row and row.get('status') == 'available' and time.time() - row['startedAt'] >= IPROYAL_LEASE_SECONDS - 210:
                    row.update(status='retired', reason='LEASE_EXPIRED')
                if row is None or (row['status'] == 'available' and
                                   (not avoidEgress or row.get('egressHash') != avoidEgress)):
                    row = row or {'startedAt': time.time(), 'http541Count': 0, 'http541Events': []}
                    row.update(slot=slot, status='claimed', lastUsedAt=time.time())
                    state[key] = row
                    writeJson(self.statePath, state)
                    return proxy, dict(row)
            writeJson(self.statePath, state)
        raise RuntimeError('NO_FRESH_EGRESS')

    def accept(self, proxy, slot, egress):
        key = proxyHash(proxy)
        with fileLock(self.lockPath):
            state = self.state()
            row = state[key]
            if row['slot'] != slot or row['status'] != 'claimed':
                raise RuntimeError('PROXY_CLAIM_INVALID')
            duplicate = any(k != key and r['status'] == 'claimed' and r.get('egressHash') == egress
                            for k, r in state.items())
            if duplicate:
                row.update(status='retired', reason='DUPLICATE_ACTIVE_EGRESS')
            else:
                row['egressHash'] = egress
            writeJson(self.statePath, state)
            return not duplicate

    def retire(self, proxy, reason):
        with fileLock(self.lockPath):
            state = self.state()
            row = state[proxyHash(proxy)]
            row.update(status='retired', reason=reason)
            writeJson(self.statePath, state)

    def record541(self, proxy, eventId):
        """一次真实 541 计一次；先轮换，累计三次才退役，重放审计不重复计数。"""
        with fileLock(self.lockPath):
            state = self.state()
            row = state[proxyHash(proxy)]
            events = row.setdefault('http541Events', [])
            if str(eventId) not in events:
                events.append(str(eventId))
                row['http541Count'] = row.get('http541Count', 0) + 1
            retired = row['http541Count'] >= 3
            row.update(status='retired' if retired else 'available', slot=None,
                       reason='HTTP_541_LIMIT' if retired else 'HTTP_541_ROTATE', lastUsedAt=time.time())
            writeJson(self.statePath, state)
            return {'count': row['http541Count'], 'retired': retired}

    def release(self, proxy, reason):
        with fileLock(self.lockPath):
            state = self.state()
            row = state[proxyHash(proxy)]
            if row['status'] != 'retired':
                row.update(status='available', slot=None, reason=reason, lastUsedAt=time.time())
            writeJson(self.statePath, state)
