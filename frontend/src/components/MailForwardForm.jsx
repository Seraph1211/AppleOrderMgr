import { useEffect, useId, useRef, useState } from 'react';
import { CheckSquare, ChevronDown, Loader2, Search, Send, Square, X } from 'lucide-react';
import { listMailContacts } from '../api/mailContactsApi';
import { forwardOrderEmailBatch } from '../api/orderMailApi';

/** 搜索多选联系人，固定待重试请求，独立记录各收件人的发送结果。 */
export default function MailForwardForm({ orderId, messageId, onQueued, onSendingChange }) {
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState([]);
  const [selected, setSelected] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);
  const busyRef = useRef(false);
  const selectorRef = useRef(null);
  const searchRef = useRef(null);
  const dropdownId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const closeOutside = event => {
      if (!selectorRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  const locked = sending || Boolean(pending);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await listMailContacts({ search, page, limit: 20 });
        if (active) {
          setContacts(response.data.items);
          setTotal(response.data.total);
          setLoadError('');
        }
      } catch (failure) {
        if (active) setLoadError(failure.message || '联系人加载失败');
      } finally {
        if (active) setLoading(false);
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, page, revision]);
  function toggle(item) {
    setSelected(previous =>
      previous.some(value => value.id === item.id)
        ? previous.filter(value => value.id !== item.id)
        : [...previous, item]
    );
  }
  async function send(event) {
    event.preventDefault();
    if (busyRef.current) return;
    const recipients = [
      ...new Set(
        [...selected.map(item => item.email), recipient.trim()]
          .filter(Boolean)
          .map(email => email.toLowerCase())
      ),
    ];
    if (!pending && (!recipients.length || recipients.length > 50)) {
      setError('请选择1至50个不同的收件邮箱');
      return;
    }
    if (
      !pending &&
      !window.confirm(
        '确认将这封邮件及附件分别转发至以下 ' +
          recipients.length +
          ' 个邮箱？\n' +
          recipients.join('\n')
      )
    )
      return;
    const request = pending || { recipients, note, idempotencyKey: crypto.randomUUID() };
    setOpen(false);
    setPending(request);
    setSending(true);
    onSendingChange(true);
    setError('');
    busyRef.current = true;
    try {
      const response = await forwardOrderEmailBatch(orderId, messageId, request);
      onQueued(response.data.items);
      setPending(null);
      setSelected([]);
      setRecipient('');
      setNote('');
    } catch (failure) {
      setError((failure.message || '提交失败') + '。可以重试原请求，不会重复排队。');
    } finally {
      setSending(false);
      onSendingChange(false);
      busyRef.current = false;
    }
  }
  function resetRequest() {
    if (
      !window.confirm(
        '提交结果可能尚未确认。请先核对下方转发记录，重新填写后再次发送可能重复投递。确认重新填写？'
      )
    )
      return;
    setPending(null);
    setError('');
  }
  return (
    <form onSubmit={send} className="bg-primary-50 rounded-lg p-4 space-y-3">
      <h3 className="font-semibold text-gray-900">转发这封邮件</h3>
      <p className="text-sm text-gray-600">选择联系人（可多选，最多50个邮箱）</p>
      <div className="flex flex-wrap gap-2">
        {selected.map(item => (
          <button
            type="button"
            key={item.id}
            disabled={locked}
            onClick={() => toggle(item)}
            className="btn btn-secondary text-left break-all"
            aria-label={'移除 ' + item.name}
          >
            {item.name} &lt;{item.email}&gt;
            <X className="w-4 h-4 inline ml-1" />
          </button>
        ))}
      </div>
      <div
        ref={selectorRef}
        className="relative"
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            searchRef.current?.focus();
            setOpen(false);
          }
        }}
      >
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
          <input
            aria-label="搜索转发联系人"
            disabled={locked}
            placeholder="搜索联系人名或邮箱"
            maxLength={100}
            className="input w-full pl-9 pr-10"
            ref={searchRef}
            aria-expanded={open && !locked}
            aria-controls={open && !locked ? dropdownId : undefined}
            autoComplete="off"
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'Enter') {
                event.preventDefault();
                if (!open) setOpen(true);
                else
                  selectorRef.current?.querySelector('[role="checkbox"]:not(:disabled)')?.focus();
              }
            }}
            value={search}
            onChange={event => {
              setOpen(true);
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <button
            type="button"
            disabled={locked}
            aria-label={open ? '收起联系人' : '展开联系人'}
            aria-expanded={open && !locked}
            className="absolute inset-y-0 right-0 px-3 text-gray-500"
            onClick={() => {
              if (open) setOpen(false);
              else {
                setOpen(true);
                searchRef.current?.focus();
              }
            }}
          >
            <ChevronDown className={'w-4 h-4 transition-transform ' + (open ? 'rotate-180' : '')} />
          </button>
        </div>
        {open && !locked && (
          <div
            id={dropdownId}
            role="group"
            aria-label="可选联系人"
            className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
          >
            <div className="max-h-52 overflow-y-auto">
              {loading ? (
                <p className="p-3 text-gray-500">加载中…</p>
              ) : loadError ? (
                <div role="alert" className="p-3 text-red-600">
                  {loadError}
                  <button
                    type="button"
                    className="btn btn-secondary ml-2"
                    onClick={() => setRevision(value => value + 1)}
                  >
                    重试
                  </button>
                </div>
              ) : !contacts.length ? (
                <p className="p-3 text-gray-500">
                  {search ? '没有匹配的联系人' : '暂无联系人，可手动填写邮箱或联系管理员配置'}
                </p>
              ) : (
                contacts.map(item => {
                  const checked = selected.some(value => value.id === item.id);
                  return (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      key={item.id}
                      disabled={locked || (!checked && selected.length >= 50)}
                      onClick={() => toggle(item)}
                      className="flex w-full min-h-11 items-center gap-2 p-2 text-left hover:bg-gray-50 cursor-pointer text-sm break-all disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    >
                      {checked ? (
                        <CheckSquare aria-hidden="true" className="w-4 h-4 shrink-0 text-primary" />
                      ) : (
                        <Square aria-hidden="true" className="w-4 h-4 shrink-0 text-gray-400" />
                      )}
                      <span>
                        {item.name} &lt;{item.email}&gt;
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            {total > 20 && (
              <div className="flex items-center justify-between text-sm p-2 border-t">
                <span>第 {page} 页</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={locked || loading || page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={locked || loading || page * 20 >= total}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <label className="block text-sm text-gray-700">
        手动添加邮箱（可选）
        <input
          type="email"
          maxLength={254}
          value={recipient}
          disabled={locked}
          autoComplete="off"
          placeholder="输入一个额外的收件邮箱"
          className="input w-full mt-1"
          onChange={event => setRecipient(event.target.value)}
        />
      </label>
      <label className="block text-sm text-gray-700">
        备注（可选）
        <textarea
          value={note}
          maxLength={2000}
          rows={2}
          disabled={locked}
          className="input w-full mt-1"
          onChange={event => setNote(event.target.value)}
        />
      </label>
      <p className="text-xs text-gray-600">
        分别发送给每个邮箱，保留原邮件正文排版、图片、原附件及原始邮件文件。
      </p>
      {error && (
        <p role="alert" className="text-red-600 text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="btn btn-primary inline-flex items-center gap-2"
          disabled={sending || (!pending && !selected.length && !recipient.trim())}
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {sending ? '提交中…' : pending ? '重试原请求' : '转发邮件'}
        </button>
        {pending && !sending && (
          <button type="button" className="btn btn-secondary" onClick={resetRequest}>
            重新填写
          </button>
        )}
      </div>
    </form>
  );
}
