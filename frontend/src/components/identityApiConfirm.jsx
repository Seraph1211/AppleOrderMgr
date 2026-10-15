import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import useModalScrollLock from './useModalScrollLock';

/** API 管理确认弹窗，支持键盘焦点约束、ESC 取消和移动端滚动锁。 */
export default function IdentityApiConfirm({
  title,
  children,
  busy,
  disabled,
  onCancel,
  onConfirm,
}) {
  const dialog = useRef(null);
  const cancel = useRef(null);
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };
  useModalScrollLock();
  useEffect(() => {
    const previousFocus = document.activeElement;
    cancel.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape' && !latest.current.busy) {
        event.preventDefault();
        latest.current.onCancel();
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...dialog.current.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
        ),
      ];
      if (!focusable.length) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-gray-900/40 flex items-center justify-center p-4"
      onClick={() => !busy && onCancel()}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="identity-api-confirm-title"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 space-y-4"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex justify-between gap-3 items-center">
          <h3 id="identity-api-confirm-title" className="text-lg font-semibold text-gray-900">
            {title}
          </h3>
          <button
            type="button"
            aria-label="关闭确认"
            className="text-gray-500 p-1"
            disabled={busy}
            onClick={onCancel}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
        <div className="flex flex-wrap justify-end gap-3">
          <button
            ref={cancel}
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? '正在处理…' : '确认'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
