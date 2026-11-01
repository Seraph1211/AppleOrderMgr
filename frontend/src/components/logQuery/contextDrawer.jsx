import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Crosshair, Info, X } from 'lucide-react';
import client from '../../api/client';

const BASE = '/server-monitor/logs';
const FORMAT = {
  continuation: 'XML 续行',
  unparsed: '未识别格式',
  encoding_error: '编码异常，已保留原始字节',
};

/** 日志阅读抽屉：来源按需展开，正文独立滚动并保留选中位置。 */
export default function MonitorLogContextDrawer({
  selected,
  scope,
  onScopeChange,
  wrapLines,
  onWrapChange,
  onCopy,
  notice,
  highlighted,
  onClose,
  dialogRef,
}) {
  const [context, setContext] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('initial');
  const [retry, setRetry] = useState(0);
  const viewportRef = useRef(null);
  const anchorRef = useRef(null);
  const controllerRef = useRef(null);
  const scrollRestoreRef = useRef(null);
  const pendingCenterRef = useRef(false);
  const busyRef = useRef(false);
  const failedDirectionRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    busyRef.current = true;
    failedDirectionRef.current = null;
    scrollRestoreRef.current = null;
    setContext(null);
    setError('');
    setLoading('initial');
    async function read() {
      try {
        const response = await client.get(`${BASE}/${selected.id}/context`, {
          params: { scope, limit: 100 },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          pendingCenterRef.current = true;
          setContext(response.data);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e.message || '上下文读取失败');
      } finally {
        if (!controller.signal.aborted) {
          busyRef.current = false;
          setLoading('');
        }
      }
    }
    read();
    return () => controller.abort();
  }, [selected.id, scope, retry]);

  function locateAnchor() {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    if (!viewport || !anchor) return;
    const top = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTop += top - viewport.clientHeight / 2 + anchor.offsetHeight / 2;
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !context) return;
    if (scrollRestoreRef.current) {
      const { height, top } = scrollRestoreRef.current;
      viewport.scrollTop = top + viewport.scrollHeight - height;
      scrollRestoreRef.current = null;
    } else if (pendingCenterRef.current) {
      locateAnchor();
      pendingCenterRef.current = false;
    }
  }, [context]);

  async function loadMore(direction) {
    if (!context || busyRef.current) return;
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted) return;
    busyRef.current = true;
    setLoading(direction);
    try {
      const response = await client.get(`${BASE}/${selected.id}/context`, {
        params: {
          scope,
          limit: 100,
          direction,
          cursor: direction === 'before' ? context.items[0]?.id : context.items.at(-1)?.id,
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      failedDirectionRef.current = null;
      setError('');
      if (direction === 'before') {
        const viewport = viewportRef.current;
        scrollRestoreRef.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
      }
      setContext(current => {
        const known = new Set(current.items.map(row => row.id));
        const added = response.data.items.filter(row => !known.has(row.id));
        return {
          ...current,
          items:
            direction === 'before' ? [...added, ...current.items] : [...current.items, ...added],
          [direction === 'before' ? 'hasMoreBefore' : 'hasMoreAfter']: response.data.hasMore,
        };
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        failedDirectionRef.current = direction;
        setError(e.message || '上下文追加失败，请重试');
      }
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setLoading('');
      }
    }
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (
      !loading &&
      !error &&
      context?.hasMoreAfter &&
      viewport &&
      viewport.scrollHeight <= viewport.clientHeight + 1
    )
      loadMore('after');
    // 只在数据或加载状态更新后补满当前阅读区；滚动加载独立处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, loading, error]);

  function checkScroll(event) {
    const viewport = event.currentTarget;
    if (busyRef.current || error || !context) return;
    if (viewport.scrollTop <= 1 && context.hasMoreBefore) loadMore('before');
    else if (
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1 &&
      context.hasMoreAfter
    )
      loadMore('after');
  }

  function closeSourceOnEscape(event) {
    const details = dialogRef.current?.querySelector('.logs-context-source[open]');
    if (event.key === 'Escape' && details) {
      event.stopPropagation();
      details.open = false;
      details.querySelector('summary').focus();
    }
  }

  return (
    <div
      className="logs-context-overlay logs-context-reading-overlay"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-detail-title"
        className="logs-context-drawer logs-context-reading-drawer"
        onKeyDown={closeSourceOnEscape}
      >
        <header className="logs-context-titlebar">
          <h3 id="log-detail-title">日志详情与上下文</h3>
          <details className="logs-context-source">
            <summary aria-label="查看选中日志来源" title="查看选中日志来源">
              <Info className="h-4 w-4" />
            </summary>
            <div className="logs-context-source-popover">
              <h4>选中日志来源</h4>
              <dl>
                <dt>日志时间</dt>
                <dd>
                  {selected.loggedAt
                    ? new Date(selected.loggedAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false,
                        fractionalSecondDigits: 3,
                      })
                    : '无时间戳'}
                </dd>
                <dt>账号</dt>
                <dd>{selected.accountNumber ?? '未识别'}</dd>
                <dt>来源文件</dt>
                <dd>{selected.fileName}</dd>
                <dt>原始位置</dt>
                <dd>
                  第 {selected.lineNumber} 行 · 第 {selected.partIndex + 1} 段
                </dd>
                <dt>文件版本</dt>
                <dd>{selected.fileId}</dd>
                {FORMAT[selected.parseState] && (
                  <>
                    <dt>格式说明</dt>
                    <dd>{FORMAT[selected.parseState]}</dd>
                  </>
                )}
              </dl>
              {selected.rawBase64 && (
                <details>
                  <summary>查看原始字节（Base64）</summary>
                  <pre>{selected.rawBase64}</pre>
                </details>
              )}
            </div>
          </details>
          <div className="logs-context-header-actions">
            <button
              type="button"
              className="btn btn-secondary"
              aria-label="定位选中日志"
              onClick={locateAnchor}
            >
              <Crosshair className="h-4 w-4" />
              <span>定位选中</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              aria-label="复制选中原文"
              onClick={() => onCopy(selected.message)}
            >
              <Copy className="h-4 w-4" />
              <span>复制原文</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              aria-label="关闭日志详情"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="logs-context-controls">
          <div className="logs-context-scopes" role="group" aria-label="上下文范围">
            <button
              type="button"
              className={`btn ${scope === 'account' ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={scope === 'account'}
              disabled={!selected.accountNumber}
              onClick={() => onScopeChange('account')}
            >
              该账号上下文
            </button>
            <button
              type="button"
              className={`btn ${scope === 'instance' ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={scope === 'instance'}
              onClick={() => onScopeChange('instance')}
            >
              整个实例上下文
            </button>
          </div>
          <label>
            <input
              type="checkbox"
              checked={wrapLines}
              onChange={event => onWrapChange(event.target.checked)}
            />
            自动换行
          </label>
          {notice && (
            <span className="logs-context-copy-notice" role="status">
              {notice}
            </span>
          )}
        </div>
        <p className="logs-context-hint">上下滑动继续查看 · 选中日志以浅蓝色标记</p>
        <div
          ref={viewportRef}
          className="logs-context-viewport"
          role="region"
          aria-label="上下文日志阅读区"
          tabIndex={0}
          onScroll={checkScroll}
          aria-busy={Boolean(loading)}
        >
          {loading === 'initial' && (
            <p className="logs-context-placeholder" role="status">
              正在读取上下文…
            </p>
          )}
          {context && (
            <>
              <button
                type="button"
                className="logs-context-edge"
                disabled={Boolean(loading) || !context.hasMoreBefore}
                onClick={() => loadMore('before')}
              >
                {loading === 'before'
                  ? '正在加载…'
                  : context.hasMoreBefore
                    ? '向上滑动加载更早上下文'
                    : '已到当前范围开头'}
              </button>
              <table
                className={`logs-context-table ${wrapLines ? 'logs-context-wrap' : ''}`}
                aria-label="上下文日志列表"
              >
                <caption className="sr-only">原始文件行号与日志原文，浅蓝色为选中记录。</caption>
                <colgroup>
                  <col style={{ width: 64 }} />
                  <col />
                </colgroup>
                <tbody>
                  {context.items.map(row => (
                    <tr
                      key={row.id}
                      ref={row.id === selected.id ? anchorRef : undefined}
                      data-log-id={row.id}
                      aria-selected={row.id === selected.id}
                      className={row.id === selected.id ? 'logs-context-anchor' : undefined}
                    >
                      <td
                        className="logs-context-line"
                        title={`${row.fileName} · 第${row.lineNumber}行 · 第${row.partIndex + 1}段`}
                      >
                        {row.lineNumber}
                      </td>
                      <td>
                        <pre>{highlighted(row.message.replace(/\r?\n$/, '') || '（空行）')}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                className="logs-context-edge"
                disabled={Boolean(loading) || !context.hasMoreAfter}
                onClick={() => loadMore('after')}
              >
                {loading === 'after'
                  ? '正在加载…'
                  : context.hasMoreAfter
                    ? '向下滑动加载更新上下文'
                    : '已到当前范围末尾'}
              </button>
            </>
          )}
          {error && (
            <div className="logs-context-error" role="alert">
              {error}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={Boolean(loading)}
                onClick={() =>
                  failedDirectionRef.current
                    ? loadMore(failedDirectionRef.current)
                    : setRetry(value => value + 1)
                }
              >
                重试上下文
              </button>
            </div>
          )}
          {context && !context.items.length && (
            <p className="logs-context-placeholder">当前范围没有上下文。</p>
          )}
        </div>
      </section>
    </div>
  );
}
