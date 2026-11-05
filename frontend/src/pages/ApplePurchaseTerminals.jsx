import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Laptop, Plus, RefreshCw } from 'lucide-react';
import { applePurchaseInventoryApi as api } from '../api/applePurchaseInventoryApi';
import './applePurchaseInventory.css';

const timeText = value =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'medium',
        timeStyle: 'medium',
        hour12: false,
      }).format(new Date(value))
    : '—';

export default function ApplePurchaseTerminals() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [oneTimeToken, setOneTimeToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.terminals();
      setItems(result.data);
      setError('');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const act = async work => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const create = event => {
    event.preventDefault();
    act(async () => {
      const result = await api.createTerminal({ name: name.trim() });
      setOneTimeToken(result.data);
      setName('');
    });
  };
  const toggle = item =>
    act(async () => {
      await api.updateTerminal(item.terminalId, { enabled: !item.enabled });
      setNotice(item.enabled ? '终端已禁用，现有 Token 立即拒绝' : '终端已启用');
    });
  const rotate = item => {
    if (!window.confirm(`确认轮换“${item.name}”的 Token？旧 Token 会立即失效。`)) return;
    act(async () => {
      const result = await api.rotateTerminalToken(item.terminalId);
      setOneTimeToken(result.data);
    });
  };
  const rename = item => {
    const nextName = window.prompt('请输入新的终端名称', item.name)?.trim();
    if (!nextName || nextName === item.name) return;
    act(async () => {
      await api.updateTerminal(item.terminalId, { name: nextName });
      setNotice('终端名称已更新');
    });
  };
  const copyToken = async () => {
    await navigator.clipboard.writeText(oneTimeToken.token);
    setNotice('Token 已复制；关闭提示后系统无法再次显示');
  };
  return (
    <div className="apple-purchase-page">
      <div className="apple-purchase-header">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ApplePurchase 同步终端</h1>
          <p className="mt-1 text-sm text-gray-500">
            Token 只在创建或轮换后显示一次，页面不读取数据库摘要。
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1 inline h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      <form className="card flex flex-col gap-3 sm:flex-row" onSubmit={create}>
        <input
          className="input flex-1"
          value={name}
          onChange={event => setName(event.target.value)}
          maxLength={128}
          placeholder="终端名称，例如 Mac 采集端"
          required
        />
        <button className="btn btn-primary" disabled={busy || !name.trim()} type="submit">
          <Plus className="mr-1 inline h-4 w-4" />
          创建终端
        </button>
      </form>
      {oneTimeToken && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <KeyRound className="h-5 w-5 shrink-0 text-amber-700" />
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-amber-900">一次性终端 Token</h2>
              <p className="mt-1 text-sm text-amber-800">
                请通过安全渠道立即交付；关闭后无法再次查看。
              </p>
              <code className="mt-3 block overflow-x-auto rounded-lg bg-white p-3 text-xs text-gray-900">
                {oneTimeToken.token}
              </code>
              <div className="mt-3 flex gap-2">
                <button className="btn btn-primary" onClick={copyToken}>
                  <Copy className="mr-1 inline h-4 w-4" />
                  复制
                </button>
                <button className="btn btn-secondary" onClick={() => setOneTimeToken(null)}>
                  已安全保存并关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800" role="status">
          {notice}
        </p>
      )}
      <div className="apple-purchase-table-wrap">
        {loading ? (
          <p className="py-12 text-center text-gray-500" role="status">
            正在加载终端…
          </p>
        ) : items.length ? (
          <table className="apple-purchase-table">
            <thead>
              <tr>
                <th>终端</th>
                <th>状态</th>
                <th>Token 前缀</th>
                <th>最后访问</th>
                <th>最后成功</th>
                <th>高水位</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.terminalId}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Laptop className="h-5 w-5 text-primary" />
                      <div>
                        <div className="font-medium text-gray-900">{item.name}</div>
                        <div className="font-mono text-xs text-gray-500">{item.terminalId}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${item.enabled ? 'badge-success' : 'badge-error'}`}>
                      {item.enabled ? '已启用' : '已禁用'}
                    </span>
                  </td>
                  <td className="font-mono text-xs">{item.tokenPrefix}</td>
                  <td>{timeText(item.lastSeenAt)}</td>
                  <td>{timeText(item.lastSuccessAt)}</td>
                  <td className="font-mono text-xs">
                    {item.highWater.observations} / {item.highWater.monitorChanges}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn btn-secondary"
                        onClick={() => rename(item)}
                        disabled={busy}
                      >
                        改名
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => toggle(item)}
                        disabled={busy}
                      >
                        {item.enabled ? '禁用' : '启用'}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => rotate(item)}
                        disabled={busy}
                      >
                        轮换 Token
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-12 text-center text-gray-500">
            <Laptop className="mx-auto mb-2 h-10 w-10 text-gray-300" />
            <p>尚未创建同步终端</p>
          </div>
        )}
      </div>
    </div>
  );
}
