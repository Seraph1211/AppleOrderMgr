import { useEffect, useState } from 'react';
import { Search, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { listMailContacts, saveMailContact, deleteMailContact } from '../api/mailContactsApi';

/** 管理员维护全局邮件通讯录。 */
export default function MailContacts() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await listMailContacts({ search, page, limit: 50 });
        if (active) {
          setData(response.data);
          setError('');
        }
      } catch (failure) {
        if (active) setError(failure.message || '联系人加载失败');
      } finally {
        if (active) setLoading(false);
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, page, revision]);
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaveError('');
    try {
      await saveMailContact(draft.id, { name: draft.name, email: draft.email });
      setDraft(null);
      setRevision(value => value + 1);
    } catch (failure) {
      setSaveError(failure.message || '保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function remove(item) {
    if (
      busy ||
      !window.confirm('删除联系人 ' + item.name + ' <' + item.email + '>？已有转发任务不受影响。')
    )
      return;
    setBusy(true);
    try {
      await deleteMailContact(item.id);
      if (data.items.length === 1 && page > 1) setPage(page - 1);
      setRevision(value => value + 1);
    } catch (failure) {
      setError(failure.message || '删除失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">邮件联系人</h1>
          <p className="text-gray-500 mt-1">
            统一维护常用联系人，转发邮件时可选择一个或多个联系人。
          </p>
        </div>
        <button
          className="btn btn-primary inline-flex items-center gap-2"
          disabled={busy}
          onClick={() => {
            setDraft({ name: '', email: '' });
            setSaveError('');
          }}
        >
          <Plus className="w-4 h-4" />
          新增联系人
        </button>
      </div>
      {draft && (
        <form onSubmit={save} className="bg-white border rounded-lg p-4 space-y-3">
          <h2 className="font-semibold text-gray-900">{draft.id ? '编辑联系人' : '新增联系人'}</h2>
          <label className="block text-sm text-gray-700">
            联系人名
            <input
              autoFocus
              required
              maxLength={100}
              disabled={busy}
              className="input w-full mt-1"
              value={draft.name}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="block text-sm text-gray-700">
            邮箱
            <input
              type="email"
              required
              maxLength={254}
              disabled={busy}
              className="input w-full mt-1"
              value={draft.email}
              onChange={event => setDraft({ ...draft, email: event.target.value })}
            />
          </label>
          {saveError && (
            <p role="alert" className="text-red-600">
              {saveError}
            </p>
          )}
          <div className="flex gap-2">
            <button disabled={busy} className="btn btn-primary">
              {busy ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              disabled={busy}
              className="btn btn-secondary"
              onClick={() => setDraft(null)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <label className="relative block">
        <Search className="w-5 h-5 absolute left-3 top-2.5 text-gray-400" />
        <input
          aria-label="搜索联系人"
          placeholder="搜索联系人名或邮箱"
          maxLength={100}
          className="input pl-10 w-full sm:max-w-md"
          value={search}
          onChange={event => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </label>
      {error && (
        <div role="alert" className="text-red-600">
          {error}
          <button
            className="btn btn-secondary ml-2"
            onClick={() => setRevision(value => value + 1)}
          >
            重新加载
          </button>
        </div>
      )}
      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left p-4">联系人名</th>
              <th className="text-left p-4">邮箱</th>
              <th className="text-right p-4">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="p-8 text-center text-gray-500">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                  加载中…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={3} className="p-8 text-center text-gray-500">
                  联系人暂不可用，请重试
                </td>
              </tr>
            ) : !data.items.length ? (
              <tr>
                <td colSpan={3} className="p-8 text-center text-gray-500">
                  {search ? '没有匹配的联系人' : '暂无联系人，点击新增联系人开始配置'}
                </td>
              </tr>
            ) : (
              data.items.map(item => (
                <tr key={item.id} className="border-t hover:bg-gray-50">
                  <td className="p-4 break-words">{item.name}</td>
                  <td className="p-4 break-all">{item.email}</td>
                  <td className="p-4 text-right whitespace-nowrap">
                    <button
                      className="btn btn-secondary mr-2"
                      disabled={busy}
                      onClick={() => {
                        setDraft(item);
                        setSaveError('');
                      }}
                    >
                      <Pencil className="w-4 h-4 inline mr-1" />
                      编辑
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => remove(item)}
                    >
                      <Trash2 className="w-4 h-4 inline mr-1" />
                      删除
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm text-gray-600">
        <span>
          共 {data.total} 位联系人 · 第 {page} 页
        </span>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary"
            disabled={page === 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <button
            className="btn btn-secondary"
            disabled={page * 50 >= data.total || loading}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
