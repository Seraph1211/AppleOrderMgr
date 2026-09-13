import { useCallback, useEffect, useState } from 'react';
import { readIngestion, writeIngestion } from '../api/orderIngestionApi';
const STATUS = {
  queued: '等待设备领取',
  downloading: '下载中',
  installing: '安装中',
  succeeded: '更新成功',
  failed: '更新失败',
  rolled_back: '已回滚',
};
/** 管理员按设备下发已验签版本，展示任务回报。 */
export default function CollectorUpdates({ devices }) {
  const [releases, setReleases] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [version, setVersion] = useState('');
  const [selected, setSelected] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [r, j] = await Promise.all([
        readIngestion('/collector-releases'),
        readIngestion('/collector-updates'),
      ]);
      setReleases(r.data.items);
      setJobs(j.data.items);
      if (!r.data.configured) setMessage('尚未配置签名发布目录与公钥，配置后可下发更新。');
    } catch (e) {
      setMessage(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const submit = async () => {
    setBusy(true);
    setMessage('');
    try {
      await writeIngestion(
        'POST',
        '/collector-updates',
        { deviceIds: selected, releaseVersion: version },
        crypto.randomUUID()
      );
      setSelected([]);
      await refresh();
      setMessage('更新任务已下发；离线设备会在上线后领取。');
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold text-gray-900">采集器统一更新</h2>
        <button className="btn btn-secondary" onClick={refresh} disabled={busy}>
          刷新更新状态
        </button>
      </div>
      <p className="text-sm text-gray-500">
        首次需在 Windows 安装引导版本及更新组件；建议先选择一台验证，再升级其余设备。
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="目标采集器版本"
          className="input"
          value={version}
          onChange={e => setVersion(e.target.value)}
        >
          <option value="">选择目标版本</option>
          {releases.map(r => (
            <option key={r.version} value={r.version}>
              {r.version}
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          disabled={busy || !version || selected.length === 0}
          onClick={submit}
        >
          {busy ? '下发中…' : `下发更新（${selected.length} 台）`}
        </button>
      </div>
      {message && (
        <p role="status" className="text-sm text-gray-700">
          {message}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="p-2 text-left">选择</th>
              <th className="p-2 text-left">设备</th>
              <th className="p-2 text-left">上报版本</th>
              <th className="p-2 text-left">目标版本</th>
              <th className="p-2 text-left">更新状态</th>
            </tr>
          </thead>
          <tbody>
            {devices.map(d => {
              const job = jobs.find(j => j.deviceId === d.id);
              return (
                <tr key={d.id} className="border-t border-gray-100">
                  <td className="p-2">
                    <input
                      type="checkbox"
                      aria-label={`选择更新设备 ${d.name}`}
                      checked={selected.includes(d.id)}
                      disabled={busy || !d.enabled}
                      onChange={e =>
                        setSelected(s =>
                          e.target.checked ? [...s, d.id] : s.filter(id => id !== d.id)
                        )
                      }
                    />
                  </td>
                  <td className="p-2">{d.name}</td>
                  <td className="p-2">{job?.agentVersion || d.agentVersion || '待上报'}</td>
                  <td className="p-2">{job?.releaseVersion || '—'}</td>
                  <td className="p-2">
                    {STATUS[job?.status] || '暂无任务'}
                    {job?.errorCode && <span className="block text-red-700">{job.errorCode}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
