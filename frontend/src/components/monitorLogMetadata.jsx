import { useEffect, useId, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';

/** 在标题旁按需展示来源信息；支持鼠标、键盘和触屏。 */
export default function MonitorLogMetadata({ selected, displayTime, parseDescription }) {
  const id = useId();
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const closingRef = useRef(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    function dismiss(event) {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    }
    function dismissOnEscape(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closingRef.current = true;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        closingRef.current = false;
      });
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape, true);
    };
  }, [open]);

  function close() {
    closingRef.current = true;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      closingRef.current = false;
    });
  }

  return (
    <div
      ref={containerRef}
      className="static"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!containerRef.current.contains(document.activeElement)) setOpen(false);
      }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="查看日志元信息"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        className="btn inline-flex min-h-11 min-w-11 items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-primary sm:min-h-8 sm:min-w-8"
        onFocus={() => {
          if (!closingRef.current) setOpen(true);
        }}
        onClick={() => setOpen(true)}
      >
        <Info className="h-4 w-4" />
      </button>
      {open && (
        <div className="monitor-log-metadata" id={id} role="dialog" aria-label="日志元信息">
          <div className="monitor-log-metadata-content">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-gray-900">日志元信息</h4>
              <button
                type="button"
                className="btn btn-secondary"
                aria-label="关闭日志元信息"
                onClick={close}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="text-gray-500">日志时间</dt>
              <dd>{displayTime}</dd>
              <dt className="text-gray-500">账号</dt>
              <dd>{selected.accountNumber ?? '未识别'}</dd>
              <dt className="text-gray-500">来源文件</dt>
              <dd className="break-all">{selected.fileName}</dd>
              <dt className="text-gray-500">原始位置</dt>
              <dd>
                第 {selected.lineNumber} 行 · 第 {selected.partIndex + 1} 段
              </dd>
              <dt className="text-gray-500">文件版本</dt>
              <dd className="break-all font-mono text-xs">{selected.fileId}</dd>
              {parseDescription && (
                <>
                  <dt className="text-gray-500">格式说明</dt>
                  <dd className="text-amber-700">{parseDescription}</dd>
                </>
              )}
            </dl>
            {selected.rawBase64 && (
              <details className="mt-3 border-t border-gray-100 pt-3 text-xs">
                <summary className="cursor-pointer text-amber-700">查看原始字节（Base64）</summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
                  {selected.rawBase64}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
