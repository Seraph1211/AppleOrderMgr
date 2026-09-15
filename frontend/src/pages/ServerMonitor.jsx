import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CalendarDays,
  Filter,
  Plus,
  RefreshCw,
  Save,
  Server,
  X,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import client from '../api/client';
import TagMultiSelect from '../components/TagMultiSelect';

const BASE = '/server-monitor';
const TODAY = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const STATES = {
  ready: '检测正常',
  missing: '未找到日志',
  unreadable: '目录无法读取',
  invalid: '日志解析异常',
  catching_up: '正在追赶日志',
  rules_pending: '等待规则生效',
  offline: '监控数据过期',
  removed: '已移除',
  disabled: '设备已停用',
};
const ALERT_STATES = { active: '条件持续', recovered: '已恢复', rule_changed: '规则变更终止' };
const ACTIONS = {
  start: '开始处理',
  ignore: '临时忽略',
  extend: '延长静默',
  end: '提前结束静默',
  complete: '人工处理完成',
  note: '添加备注',
};
const HANDLING = {
  processing: '处理中',
  ignored: '暂时忽略',
  completed: '人工已完成',
  ended: '静默已结束',
};
const SEVERITY = { info: '提醒', warning: '警告', critical: '严重' };
const blankRule = () => ({
  name: '',
  enabled: true,
  mode: 'any',
  keywords: [],
  excludes: [],
  windowMinutes: 10,
  threshold: 5,
  severity: 'warning',
  deviceIds: [],
  directoryIds: [],
});
const formatTime = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';
const bytes = n => {
  const value = Number(n || 0);
  return value >= 1e9
    ? `${(value / 1e9).toFixed(3)} GB`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(2)} MB`
      : value >= 1000
        ? `${(value / 1000).toFixed(2)} KB`
        : `${value.toFixed(0)} B`;
};
const selected = event => Array.from(event.target.selectedOptions, option => option.value);
const words = text =>
  text
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);
function Table({ headers, children, empty = false }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full min-w-[700px] text-left text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            {headers.map(h => (
              <th key={h} className="px-3 py-3 whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {empty ? (
            <tr>
              <td colSpan={headers.length} className="p-8 text-center text-gray-500">
                暂无数据
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
function Cell({ children }) {
  return <td className="px-3 py-3 align-top">{children}</td>;
}
function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-gray-600">
      {label}
      {children}
    </label>
  );
}

/** 服务器流量、实例告警和规则管理，唯一权限由路由及服务端共同校验。 */
export default function ServerMonitor() {
  const [tab, setTab] = useState('traffic');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [from, setFrom] = useState(TODAY);
  const [to, setTo] = useState(TODAY);
  const [deviceIds, setDeviceIds] = useState([]);
  const [rows, setRows] = useState([]);
  const [trafficError, setTrafficError] = useState('');
  const [trafficLoading, setTrafficLoading] = useState(true);
  const [granularity, setGranularity] = useState('day');
  const [trafficPage, setTrafficPage] = useState(1);
  const [editor, setEditor] = useState(null);
  const [keywords, setKeywords] = useState('');
  const [excludes, setExcludes] = useState('');
  const [sample, setSample] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('start');
  const [minutes, setMinutes] = useState(30);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const detailRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    try {
      setRefreshing(true);
      const response = await client.get(`${BASE}/overview`);
      if (mounted.current) {
        setData(response.data);
        setError('');
      }
    } catch (e) {
      if (mounted.current) setError(e.message || '监控数据读取失败');
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);
  const selectionKey = deviceIds.join(',');
  useEffect(() => {
    setTrafficPage(1);
  }, [from, to, selectionKey, granularity]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function read() {
      try {
        setTrafficLoading(true);
        const response = await client.get(`${BASE}/traffic`, {
          params: { from, to, deviceIds: selectionKey },
          signal: controller.signal,
        });
        if (active) {
          setRows(response.data.rows);
          setTrafficError('');
        }
      } catch (e) {
        if (active) {
          setRows([]);
          setTrafficError(e.message || '流量读取失败');
        }
      } finally {
        if (active) setTrafficLoading(false);
      }
    }
    read();
    const timer = setInterval(read, 60000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [from, to, selectionKey]);
  useEffect(() => {
    if (!detailId) return undefined;
    let active = true;
    setHistory(null);
    setHistoryError('');
    client
      .get(`${BASE}/instances/${detailId}/history`, { params: { page } })
      .then(r => {
        if (active) setHistory(r.data);
      })
      .catch(e => {
        if (active) setHistoryError(e.message);
      });
    return () => {
      active = false;
    };
  }, [detailId, page, notice]);
  useEffect(() => {
    if (detailId) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [detailId]);
  const deviceName = id => data?.devices.find(d => d.id === id)?.name || id;
  const deviceOptions = useMemo(() => data?.devices.map(device => device.id) || [], [data]);
  const deviceLabels = useMemo(
    () =>
      Object.fromEntries((data?.devices || []).map(device => [device.id, device.name])),
    [data]
  );
  const instance = data?.instances.find(i => i.id === detailId);
  const totals = useMemo(
    () =>
      rows.reduce(
        (a, r) => {
          for (const key of [
            'receivedBytes',
            'sentBytes',
            'collectorReceivedBytes',
            'collectorSentBytes',
            'coveredSeconds',
            'gapSeconds',
          ])
            a[key] += Number(r[key]);
          return a;
        },
        {
          receivedBytes: 0,
          sentBytes: 0,
          collectorReceivedBytes: 0,
          collectorSentBytes: 0,
          coveredSeconds: 0,
          gapSeconds: 0,
        }
      ),
    [rows]
  );
  const grouped = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const time = granularity === 'day' ? row.day : `${row.day} ${row.hour}`;
      const key = `${row.deviceId}/${time}`;
      const item = map.get(key) || {
        deviceId: row.deviceId,
        time,
        receivedBytes: 0,
        sentBytes: 0,
        collectorReceivedBytes: 0,
        collectorSentBytes: 0,
        coveredSeconds: 0,
        gapSeconds: 0,
      };
      for (const field of [
        'receivedBytes',
        'sentBytes',
        'collectorReceivedBytes',
        'collectorSentBytes',
        'coveredSeconds',
        'gapSeconds',
      ])
        item[field] += Number(row[field]);
      map.set(key, item);
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        b.time.localeCompare(a.time) ||
        b.receivedBytes + b.sentBytes - (a.receivedBytes + a.sentBytes)
    );
  }, [rows, granularity]);
  const chart = useMemo(() => {
    const map = new Map();
    for (const row of grouped) {
      const item = map.get(row.time) || { time: row.time, 下载: 0, 上传: 0 };
      item.下载 += row.receivedBytes / 1e9;
      item.上传 += row.sentBytes / 1e9;
      map.set(row.time, item);
    }
    if (!map.size) return [];
    const start = new Date(`${from}T00:00:00+08:00`).getTime();
    const end = Math.min(new Date(`${to}T00:00:00+08:00`).getTime() + 86400000, Date.now());
    const step = granularity === 'day' ? 86400000 : 3600000;
    const points = [];
    for (let time = start; time < end && points.length < 2160; time += step) {
      const local = new Date(time + 8 * 3600000).toISOString();
      const key =
        granularity === 'day'
          ? local.slice(0, 10)
          : `${local.slice(0, 10)} ${local.slice(11, 13)}:00`;
      points.push(map.get(key) || { time: key, 下载: null, 上传: null });
    }
    return points;
  }, [grouped, from, to, granularity]);
  async function perform(work) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
    } catch (e) {
      setError(e.message || '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  function openRule(rule) {
    setEditor(
      rule
        ? { id: rule.id, expectedVersion: rule.version, config: { ...rule.config } }
        : { config: blankRule() }
    );
    setKeywords(rule?.config.keywords.join('\n') || '');
    setExcludes(rule?.config.excludes.join('\n') || '');
    setSample('');
    setTestResult(null);
  }
  function edit(key, value) {
    setEditor(e => ({ ...e, config: { ...e.config, [key]: value } }));
    setTestResult(null);
  }
  const actualRule = () => ({
    ...editor.config,
    keywords: words(keywords),
    excludes: words(excludes),
  });
  const actionable = data?.instances.filter(i => i.actionable && i.alerts.length).length || 0;
  const coverage = item => {
    const start = new Date(
      `${item.time.length === 10 ? item.time + 'T00:00:00' : item.time.replace(' ', 'T') + ':00'}+08:00`
    );
    const expected =
      Math.max(0, Math.min(Date.now() - start, (granularity === 'day' ? 86400 : 3600) * 1000)) /
      1000;
    const missing = Math.max(0, expected - item.coveredSeconds);
    return `${Math.floor(item.coveredSeconds / 60)} / ${Math.ceil(expected / 60)} 分钟${missing > 90 ? ' · 存在未覆盖时段' : ''}${item.gapSeconds ? ' · 含采样异常' : ''}`;
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Activity className="w-5 h-5" />
            服务器监控
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            北京时间 · 历史保留90天 · {actionable} 个实例待核实
          </p>
        </div>
        <button
          className="btn btn-secondary inline-flex items-center gap-1"
          onClick={load}
          disabled={refreshing}
        >
          <RefreshCw className="w-4 h-4 mr-1" />
          {refreshing ? '刷新中…' : '刷新状态'}
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">
          {error}（现有展示可能已过期）
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-blue-50 p-3 text-blue-800">
          {notice}
        </p>
      )}
      <div
        className="flex overflow-x-auto border-b border-gray-200 bg-white"
        role="tablist"
        aria-label="服务器监控功能"
      >
        {[
          ['traffic', '流量统计'],
          ['instances', '实例监控'],
          ['rules', '告警规则'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`-mb-px whitespace-nowrap border-x border-t-2 px-6 py-3 text-sm font-medium transition-colors first:border-l-gray-200 ${
              tab === id
                ? 'border-x-gray-200 border-t-primary bg-white text-primary'
                : 'border-x-transparent border-t-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            }`}
            onClick={() => {
              setTab(id);
              setDetailId(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {!data && !error && <p className="p-8 text-center text-gray-500">正在读取监控数据…</p>}
      {tab === 'traffic' && (
        <>
          <section className="card hover:shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Filter className="h-5 w-5 text-gray-500" />
                <h2 className="font-medium text-gray-800">筛选条件</h2>
                {deviceIds.length > 0 && (
                  <span className="badge badge-info">已选 {deviceIds.length} 台</span>
                )}
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-primary"
                onClick={() => {
                  setFrom(TODAY());
                  setTo(TODAY());
                  setDeviceIds([]);
                  setGranularity('day');
                }}
              >
                <RefreshCw className="h-4 w-4" />
                重置筛选
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  <CalendarDays className="h-4 w-4 text-gray-400" />
                  开始日期
                </label>
                <input
                  aria-label="开始日期"
                  className="input"
                  type="date"
                  value={from}
                  max={to}
                  onChange={event => setFrom(event.target.value)}
                />
              </div>
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  <CalendarDays className="h-4 w-4 text-gray-400" />
                  结束日期
                </label>
                <input
                  aria-label="结束日期"
                  className="input"
                  type="date"
                  value={to}
                  min={from}
                  onChange={event => setTo(event.target.value)}
                />
              </div>
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  <Server className="h-4 w-4 text-gray-400" />
                  服务器
                  <span className="font-normal text-gray-400">可多选</span>
                </label>
                <TagMultiSelect
                  options={deviceOptions}
                  value={deviceIds}
                  onChange={setDeviceIds}
                  ariaLabel="服务器筛选"
                  placeholder="全部服务器"
                  itemLabel="服务器"
                  optionLabels={deviceLabels}
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">汇总粒度</label>
                <select
                  aria-label="汇总粒度"
                  className="input"
                  value={granularity}
                  onChange={event => setGranularity(event.target.value)}
                >
                  <option value="day">每日</option>
                  <option value="hour">每小时</option>
                </select>
              </div>
            </div>
          </section>
          {trafficError && (
            <p role="alert" className="text-red-700">
              {trafficError}
            </p>
          )}
          <div className="bg-blue-50 text-blue-900 rounded-xl p-4">
            <p>
              所选服务器合计：下载 {bytes(totals.receivedBytes)} 上传 {bytes(totals.sentBytes)} 总计{' '}
              {bytes(totals.receivedBytes + totals.sentBytes)}
            </p>
            <p className="text-sm mt-2">
              采集器通信正文参考：接收 {bytes(totals.collectorReceivedBytes)} / 发送{' '}
              {bytes(totals.collectorSentBytes)}。不含全部协议开销，不从整机流量扣减。
            </p>
          </div>
          <p className="text-sm text-gray-500">
            1 GB = 1,000,000,000
            字节。缺失时段不代表零流量；请核对覆盖时间后比较代理账号账单。系统更新、远程桌面等也包含在整机统计内。
          </p>
          {trafficLoading && (
            <p role="status" className="text-gray-500">
              正在加载流量…
            </p>
          )}
          {chart.length > 0 && (
            <div className="bg-white border rounded-xl p-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" />
                  <YAxis unit=" GB" />
                  <Tooltip formatter={value => `${Number(value).toFixed(3)} GB`} />
                  <Legend />
                  <Line dataKey="下载" stroke="#1E3A8A" connectNulls={false} />
                  <Line dataKey="上传" stroke="#0284C7" connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <Table
            headers={['时间', '服务器', '下载', '上传', '合计', '统计覆盖']}
            empty={!grouped.length}
          >
            {grouped.slice((trafficPage - 1) * 50, trafficPage * 50).map(r => (
              <tr key={`${r.deviceId}/${r.time}`} className="hover:bg-gray-50">
                <Cell>{r.time}</Cell>
                <Cell>{deviceName(r.deviceId)}</Cell>
                <Cell>{bytes(r.receivedBytes)}</Cell>
                <Cell>{bytes(r.sentBytes)}</Cell>
                <Cell>{bytes(r.receivedBytes + r.sentBytes)}</Cell>
                <Cell>{coverage(r)}</Cell>
              </tr>
            ))}
          </Table>
          {grouped.length > 50 && (
            <div className="flex gap-3 items-center">
              <button
                className="btn btn-secondary"
                disabled={trafficPage <= 1}
                onClick={() => setTrafficPage(p => p - 1)}
              >
                上一页
              </button>
              <span>
                第 {trafficPage} 页 / 共 {grouped.length} 条汇总
              </span>
              <button
                className="btn btn-secondary"
                disabled={trafficPage * 50 >= grouped.length}
                onClick={() => setTrafficPage(p => p + 1)}
              >
                下一页
              </button>
            </div>
          )}
          {data?.devices
            .filter(
              d =>
                (!deviceIds.length || deviceIds.includes(d.id)) &&
                !rows.some(r => r.deviceId === d.id)
            )
            .map(d => (
              <p key={d.id} className="text-sm text-amber-700">
                {d.name}：所选日期无流量样本，可能尚未升级采集器或未启动监控。
              </p>
            ))}
        </>
      )}
      {tab === 'instances' && (
        <>
          <Table
            headers={['服务器 / 实例', '检测状态', '当前异常', '人工处理', '最近检测', '操作']}
            empty={!data?.instances.length}
          >
            {data?.instances.map(i => (
              <tr key={i.id} className="hover:bg-gray-50">
                <Cell>
                  <p>{deviceName(i.deviceId)}</p>
                  <p className="text-gray-500">{i.label}</p>
                </Cell>
                <Cell>
                  <span
                    className={`badge ${i.state === 'ready' ? 'badge-success' : 'badge-warning'}`}
                  >
                    {STATES[i.state] || i.state}
                  </span>
                </Cell>
                <Cell>
                  {i.alerts.length
                    ? i.alerts.map(a => (
                        <p key={a.id} className={i.actionable ? 'text-red-700' : 'text-gray-500'}>
                          {a.ruleName}：{a.hitCount} 次{i.actionable ? ' · 待核实' : ' · 记录保留'}
                        </p>
                      ))
                    : '无持续告警'}
                </Cell>
                <Cell>
                  {HANDLING[i.handling.status] || '未处理'}
                  {i.muted && (
                    <p className="text-blue-700">
                      静默剩余 {Math.ceil((new Date(i.handling.until) - Date.now()) / 60000)} 分钟
                    </p>
                  )}
                  {i.handling.actorId && (
                    <p className="text-xs text-gray-500">处理用户 ID：{i.handling.actorId}</p>
                  )}
                </Cell>
                <Cell>{formatTime(i.observedAt)}</Cell>
                <Cell>
                  <button
                    className="btn btn-secondary inline-flex items-center gap-1"
                    onClick={() => {
                      setDetailId(i.id);
                      setPage(1);
                      setNote('');
                    }}
                  >
                    查看 / 处理
                  </button>
                </Cell>
              </tr>
            ))}
          </Table>
          {instance && (
            <section ref={detailRef} className="bg-white border rounded-xl p-4 space-y-4">
              <div className="flex justify-between">
                <h2 className="font-semibold">
                  {deviceName(instance.deviceId)} · {instance.label}
                </h2>
                <button aria-label="关闭实例详情" onClick={() => setDetailId(null)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-gray-500">
                检测恢复与人工处理完成分别记录。静默覆盖该实例全部规则，期间继续检测。
              </p>
              <form
                className="flex flex-wrap gap-3 items-end"
                onSubmit={e => {
                  e.preventDefault();
                  perform(async () => {
                    await client.post(`${BASE}/instances/${instance.id}/actions`, {
                      action,
                      minutes,
                      note,
                      expectedVersion: instance.version,
                    });
                    setNote('');
                    setNotice(`${ACTIONS[action]}已记录 · ${new Date().toLocaleTimeString()}`);
                  });
                }}
              >
                <Field label="处理操作">
                  <select
                    className="input"
                    value={action}
                    onChange={e => setAction(e.target.value)}
                  >
                    {Object.entries(ACTIONS).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="静默时长">
                  <select
                    className="input"
                    disabled={!['start', 'ignore', 'extend'].includes(action)}
                    value={minutes}
                    onChange={e => setMinutes(Number(e.target.value))}
                  >
                    {[15, 30, 60, 120].map(n => (
                      <option key={n} value={n}>
                        {n} 分钟
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="备注">
                  <input
                    aria-label="处理备注"
                    className="input min-w-60"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    maxLength={500}
                  />
                </Field>
                <button className="btn btn-primary inline-flex items-center gap-1" disabled={busy}>
                  提交操作
                </button>
              </form>
              <h3 className="font-medium">当前窗口检测结果</h3>
              <Table
                headers={['规则', '命中数', '脱敏样例']}
                empty={!instance.snapshot.results?.length}
              >
                {instance.snapshot.results?.map(r => (
                  <tr key={r.ruleId}>
                    <Cell>
                      {data.rules.find(rule => rule.id === r.ruleId)?.config.name || r.ruleId}
                    </Cell>
                    <Cell>{r.count}</Cell>
                    <Cell>
                      {r.samples.map((s, index) => (
                        <p key={index} className="break-words">
                          {formatTime(s.at)} · {s.file} · {s.keywords.join(' / ')}
                        </p>
                      ))}
                    </Cell>
                  </tr>
                ))}
              </Table>
              <h3 className="font-medium">告警与操作历史</h3>
              {historyError && (
                <p role="alert" className="text-red-700">
                  {historyError}
                </p>
              )}
              {!history && !historyError && <p>正在加载历史…</p>}
              {history && (
                <>
                  <Table
                    headers={['规则', '状态', '命中数', '首次 / 最后异常', '恢复时间']}
                    empty={!history.alerts.rows.length}
                  >
                    {history.alerts.rows.map(a => (
                      <tr key={a.id}>
                        <Cell>{a.ruleName}</Cell>
                        <Cell>{ALERT_STATES[a.status]}</Cell>
                        <Cell>{a.hitCount}</Cell>
                        <Cell>
                          {formatTime(a.firstSeenAt)}
                          <br />
                          {formatTime(a.lastSeenAt)}
                        </Cell>
                        <Cell>{formatTime(a.recoveredAt)}</Cell>
                      </tr>
                    ))}
                  </Table>
                  <Table
                    headers={['时间', '用户 ID', '操作', '备注']}
                    empty={!history.actions.rows.length}
                  >
                    {history.actions.rows.map(a => (
                      <tr key={a.id}>
                        <Cell>{formatTime(a.createdAt)}</Cell>
                        <Cell>{a.actorId}</Cell>
                        <Cell>{ACTIONS[a.action] || a.action}</Cell>
                        <Cell>
                          <span className="whitespace-pre-wrap break-words">{a.note || '—'}</span>
                        </Cell>
                      </tr>
                    ))}
                  </Table>
                  <div className="flex gap-3 items-center">
                    <button
                      className="btn btn-secondary inline-flex items-center gap-1"
                      disabled={page <= 1}
                      onClick={() => setPage(p => p - 1)}
                    >
                      上一页
                    </button>
                    <span>第 {page} 页</span>
                    <button
                      className="btn btn-secondary inline-flex items-center gap-1"
                      disabled={page * 30 >= Math.max(history.alerts.count, history.actions.count)}
                      onClick={() => setPage(p => p + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
      {tab === 'rules' && (
        <>
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-500">
              字面关键词区分大小写；规则变更后采集器重新检查当前窗口。
            </p>
            <button
              className="btn btn-primary inline-flex items-center gap-1"
              onClick={() => openRule(null)}
            >
              <Plus className="w-4 h-4 mr-1" />
              新增规则
            </button>
          </div>
          {editor && (
            <form
              className="bg-white border rounded-xl p-4 space-y-4"
              onSubmit={e => {
                e.preventDefault();
                perform(async () => {
                  const body = {
                    config: actualRule(),
                    ...(editor.id ? { expectedVersion: editor.expectedVersion } : {}),
                  };
                  if (editor.id) await client.put(`${BASE}/rules/${editor.id}`, body);
                  else await client.post(`${BASE}/rules`, body);
                  setEditor(null);
                  setNotice('规则已保存，等待采集器同步生效。');
                });
              }}
            >
              <div className="flex justify-between">
                <h2 className="font-semibold">{editor.id ? '编辑规则' : '新增规则'}</h2>
                <button
                  type="button"
                  aria-label="关闭规则编辑"
                  onClick={() => setEditor(null)}
                  disabled={busy}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <fieldset disabled={busy} className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  <Field label="规则名称">
                    <input
                      className="input"
                      required
                      maxLength={100}
                      value={editor.config.name}
                      onChange={e => edit('name', e.target.value)}
                    />
                  </Field>
                  <Field label="状态">
                    <select
                      className="input"
                      value={String(editor.config.enabled)}
                      onChange={e => edit('enabled', e.target.value === 'true')}
                    >
                      <option value="true">启用</option>
                      <option value="false">停用</option>
                    </select>
                  </Field>
                  <Field label="匹配方式">
                    <select
                      className="input"
                      value={editor.config.mode}
                      onChange={e => edit('mode', e.target.value)}
                    >
                      <option value="any">包含任一关键词</option>
                      <option value="all">同时包含全部关键词</option>
                    </select>
                  </Field>
                  <Field label="级别">
                    <select
                      className="input"
                      value={editor.config.severity}
                      onChange={e => edit('severity', e.target.value)}
                    >
                      {Object.entries(SEVERITY).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="flex flex-wrap gap-4">
                  <Field label="关键词（每行一个，最多20个）">
                    <textarea
                      className="input w-72 h-28"
                      required
                      value={keywords}
                      onChange={e => {
                        setKeywords(e.target.value);
                        setTestResult(null);
                      }}
                    />
                  </Field>
                  <Field label="排除词（任一命中即排除）">
                    <textarea
                      className="input w-72 h-28"
                      value={excludes}
                      onChange={e => {
                        setExcludes(e.target.value);
                        setTestResult(null);
                      }}
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Field label="滚动窗口（分钟）">
                    <input
                      className="input w-32"
                      type="number"
                      min={1}
                      max={60}
                      required
                      value={editor.config.windowMinutes}
                      onChange={e => edit('windowMinutes', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="触发次数">
                    <input
                      className="input w-32"
                      type="number"
                      min={1}
                      max={100000}
                      required
                      value={editor.config.threshold}
                      onChange={e => edit('threshold', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="适用服务器（未选为全部）">
                    <select
                      aria-label="规则适用服务器"
                      className="input h-24 min-w-48"
                      multiple
                      value={editor.config.deviceIds}
                      onChange={e => edit('deviceIds', selected(e))}
                    >
                      {data?.devices.map(d => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="适用实例（未选为全部）">
                    <select
                      aria-label="规则适用实例"
                      className="input h-24 min-w-48"
                      multiple
                      value={editor.config.directoryIds}
                      onChange={e => edit('directoryIds', selected(e))}
                    >
                      {data?.instances.map(i => (
                        <option key={i.id} value={i.localId}>
                          {deviceName(i.deviceId)} / {i.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary inline-flex items-center gap-1"
                  onClick={() => {
                    edit('deviceIds', []);
                    edit('directoryIds', []);
                  }}
                >
                  清空适用范围，使用全部实例
                </button>
                <Field label="脱敏样例试匹配（仅测试文本条件，不保存正文）">
                  <textarea
                    className="input h-24"
                    maxLength={20000}
                    value={sample}
                    onChange={e => {
                      setSample(e.target.value);
                      setTestResult(null);
                    }}
                  />
                </Field>
                <div className="flex gap-3 items-center">
                  <button
                    className="btn btn-secondary inline-flex items-center gap-1"
                    type="button"
                    onClick={() =>
                      perform(async () => {
                        const r = await client.post(`${BASE}/rules/test`, {
                          rule: actualRule(),
                          text: sample,
                        });
                        setTestResult(r.data);
                      })
                    }
                  >
                    试匹配
                  </button>
                  {testResult && (
                    <span role="status">
                      命中 {testResult.count} 行；行号：{testResult.lines.join('、') || '无'}
                    </span>
                  )}
                  <button className="btn btn-primary inline-flex items-center gap-1" type="submit">
                    <Save className="w-4 h-4 mr-1" />
                    保存规则
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          <p className="text-sm text-gray-500">
            规则同步：
            {data?.instances.filter(i => i.fresh && i.snapshot.revision === data.revision).length ||
              0}{' '}
            个实例已应用当前版本；
            {data?.instances.filter(i => !i.fresh || i.snapshot.revision !== data.revision)
              .length || 0}{' '}
            个实例待同步或离线。
          </p>
          <Table
            headers={['规则 / 版本', '匹配关键词', '窗口 / 阈值', '级别 / 状态', '范围', '操作']}
            empty={!data?.rules.length}
          >
            {data?.rules.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <Cell>
                  {r.config.name}
                  <p className="text-xs text-gray-500">版本 {r.version}</p>
                </Cell>
                <Cell>{r.config.keywords.join(' / ')}</Cell>
                <Cell>
                  {r.config.windowMinutes} 分钟 ≥{r.config.threshold} 次
                </Cell>
                <Cell>
                  {SEVERITY[r.config.severity]} / {r.config.enabled ? '启用' : '停用'}
                </Cell>
                <Cell>
                  {r.config.deviceIds.length
                    ? `${r.config.deviceIds.length} 台指定服务器`
                    : '全部服务器'}
                  <br />
                  {r.config.directoryIds.length
                    ? `${r.config.directoryIds.length} 个指定实例`
                    : '全部实例'}
                </Cell>
                <Cell>
                  <button
                    className="btn btn-secondary inline-flex items-center gap-1"
                    onClick={() => openRule(r)}
                  >
                    编辑
                  </button>
                </Cell>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}
