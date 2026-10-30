import { useEffect, useState } from 'react';
import { RefreshCw, Save, X } from 'lucide-react';
import client from '../api/client';

function TagRow({ resource, onSaved, onCatalog }) {
  const [draft, setDraft] = useState(resource.tag || '');
  const [version, setVersion] = useState(resource.tagVersion || 0);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!editing) {
      setDraft(resource.tag || '');
      setVersion(resource.tagVersion || 0);
    }
  }, [resource.tag, resource.tagVersion, editing]);
  async function save(tag) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await client.put('/server-monitor/logs/tags', {
        deviceId: resource.deviceId,
        localId: resource.localId,
        tag,
        expectedVersion: version,
      });
      onSaved(response.data);
      setDraft(response.data.tag);
      setVersion(response.data.tagVersion);
      setEditing(false);
      setConflict(false);
      setNotice(response.data.tag ? '已保存' : '已清空');
    } catch (failure) {
      setError(failure.message || '标签保存失败');
      setConflict(failure.code === 'CONCURRENT_MODIFICATION');
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    try {
      const response = await client.get('/server-monitor/logs/states');
      const latest = resource.localId
        ? response.data.instances.find(
            item => item.deviceId === resource.deviceId && item.localId === resource.localId
          )
        : response.data.devices.find(item => item.id === resource.deviceId);
      if (!latest) throw new Error('资源已不存在，请刷新页面');
      onCatalog(response.data);
      setVersion(latest.tagVersion || 0);
      setConflict(false);
      setError('');
      setNotice(`最新标签：${latest.tag || '未设置'}；已保留当前输入，请确认后保存`);
    } catch (failure) {
      setError(failure.message || '重新读取失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr className="border-t border-gray-100">
      <td className="whitespace-nowrap px-3 py-3 align-top text-gray-600">
        {resource.localId ? '实例' : '服务器'}
      </td>
      <td className="min-w-44 max-w-xs break-words px-3 py-3 align-top text-gray-900">
        {resource.name}
        {resource.status && <span className="ml-1 text-gray-500">{resource.status}</span>}
      </td>
      <td className="px-3 py-2 align-top">
        <input
          aria-label={`${resource.name}标签`}
          className="input min-h-11 w-full min-w-40 text-base sm:min-h-0 sm:text-sm"
          maxLength={100}
          placeholder="未设置标签"
          disabled={busy}
          value={draft}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!busy && draft.trim() !== (resource.tag || '')) save(draft);
            }
          }}
          onChange={event => {
            setDraft(event.target.value);
            setEditing(true);
            setNotice('');
          }}
        />
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-1 max-w-md break-words text-xs text-gray-600">
            {notice}
          </p>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary inline-flex min-h-11 items-center gap-1 whitespace-nowrap sm:min-h-0"
            disabled={busy || draft.trim() === (resource.tag || '')}
            onClick={() => save(draft)}
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {busy ? '处理中…' : '保存'}
          </button>
          <button
            type="button"
            className="btn btn-secondary inline-flex min-h-11 items-center gap-1 whitespace-nowrap sm:min-h-0"
            disabled={busy || !(resource.tag || draft)}
            onClick={() => save('')}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            清空
          </button>
          {conflict && (
            <button
              type="button"
              className="btn btn-secondary inline-flex min-h-11 items-center gap-1 whitespace-nowrap sm:min-h-0"
              disabled={busy}
              onClick={reload}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              重新读取
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** 服务器与实例人工标签表格；逐行保存，冲突时保留草稿。 */
export default function MonitorLogTags({ catalog, onSaved, onCatalog }) {
  const [search, setSearch] = useState('');
  const resources = (catalog?.devices || []).flatMap(device => [
    {
      ...device,
      name: device.name,
      deviceId: device.id,
      localId: null,
      status: device.enabled ? '' : '（已停用）',
    },
    ...(catalog.instances || [])
      .filter(item => item.deviceId === device.id)
      .map(item => ({
        ...item,
        name: `${device.name} / ${item.label}`,
        status: item.active === false ? '（已移除）' : '',
      })),
  ]);
  const keyword = search.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  const filtered = resources.filter(item =>
    `${item.name} ${item.tag || ''}`.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(keyword)
  );
  return (
    <section
      role="region"
      aria-label="服务器与实例标签管理"
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h3 className="font-semibold text-gray-900">服务器与实例标签管理</h3>
      <p className="mt-1 text-sm text-gray-500">
        每台服务器、每个实例可设置一个标签，最多100字符；保存后在查询下拉框中展示。
      </p>
      <input
        className="input mt-3 w-full text-base sm:max-w-sm sm:text-sm"
        aria-label="搜索标签管理资源"
        placeholder="搜索服务器、实例或标签"
        value={search}
        onKeyDown={event => {
          if (event.key === 'Enter') event.preventDefault();
        }}
        onChange={event => setSearch(event.target.value)}
      />
      <div className="mt-3 max-h-96 overflow-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">服务器／实例</th>
              <th className="px-3 py-2 font-medium">标签</th>
              <th className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(resource => (
              <TagRow
                key={`${resource.deviceId}:${resource.localId || ''}`}
                resource={resource}
                onSaved={onSaved}
                onCatalog={onCatalog}
              />
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p role="status" className="p-4 text-center text-sm text-gray-500">
            {resources.length ? '无匹配资源' : '暂无服务器或实例'}
          </p>
        )}
      </div>
    </section>
  );
}
