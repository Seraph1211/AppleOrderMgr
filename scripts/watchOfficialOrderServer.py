from __future__ import print_function
import json, time, subprocess, datetime, sys
try:
    from urllib.request import urlopen
except ImportError:
    from urllib2 import urlopen

NAME = sys.argv[1]
if NAME != 'apple-official-order-collector':
    raise ValueError('UNEXPECTED_CONTAINER')
ROOT = '/var/tmp/apple-account-research-20261003/evidence'
started = time.time()
last_cpu = None
high_cpu_since = None
health_failures = 0

while True:
    now = time.time()
    with open('/proc/meminfo') as stream:
        memory = dict((line.split(':')[0], int(line.split()[1])) for line in stream)
    with open('/proc/stat') as stream:
        cpu = [int(value) for value in stream.readline().split()[1:9]]
    total, idle = sum(cpu), cpu[3] + cpu[4]
    usage = None
    if last_cpu and total > last_cpu[0]:
        usage = 100.0 * (1.0 - float(idle-last_cpu[1]) / (total-last_cpu[0]))
    last_cpu = (total, idle)
    high_cpu_since = (high_cpu_since or now) if usage is not None and usage > 85 else None
    try:
        healthy = urlopen('http://127.0.0.1:3001/api/health/ready', timeout=2).getcode() == 200
    except Exception:
        healthy = False
    health_failures = 0 if healthy else health_failures+1
    try:
        state = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .State}}', NAME]))
    except Exception:
        state = {'Status': 'missing', 'Running': False}
    record = {'time': datetime.datetime.utcnow().isoformat()+'Z', 'availableMemoryMiB': memory.get('MemAvailable', 0)/1024.0,
              'hostCpuPercent': usage, 'apiHealthy': healthy, 'workerState': state.get('Status'), 'oomKilled': state.get('OOMKilled', False)}
    if state.get('Running'):
        try:
            record['container'] = json.loads(subprocess.check_output(['docker', 'stats', '--no-stream', '--format', '{{json .}}', NAME]))
        except Exception:
            record['containerStatsUnavailable'] = True
    stop = None
    if memory.get('MemAvailable', 0) < 1536*1024: stop = 'HOST_MEMORY_FLOOR'
    elif health_failures >= 3: stop = 'API_HEALTH_FAILURE'
    elif high_cpu_since and now-high_cpu_since >= 60: stop = 'HOST_CPU_LIMIT'
    elif now-started >= 190: stop = 'PHASE_TIMEOUT'
    if stop and state.get('Running'):
        record['stopReason'] = stop
        subprocess.call(['docker', 'stop', '-t', '5', NAME], stdout=open('/dev/null', 'w'))
    with open(ROOT+'/resources.jsonl', 'a') as stream:
        stream.write(json.dumps(record)+'\n')
    print(json.dumps(record))
    if not state.get('Running') or stop: break
    time.sleep(1)
