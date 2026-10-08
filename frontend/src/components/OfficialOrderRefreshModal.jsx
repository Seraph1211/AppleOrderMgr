import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import OfficialOrderRefreshPanel from './OfficialOrderRefreshPanel';

/** 官网更新进度弹窗；任务在服务端执行，关闭弹窗不取消任务。 */
export default function OfficialOrderRefreshModal({ onClose, ...props }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const keydown = event => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const items = [
        ...dialog.current.querySelectorAll(
          'button:not(:disabled), select, summary, [tabindex="0"]'
        ),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="official-progress-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-xl focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <h2 id="official-progress-title" className="text-lg font-semibold text-gray-900">
            官网更新进度
          </h2>
          <button
            type="button"
            className="btn btn-secondary p-2"
            aria-label="关闭官网更新进度"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">
          <OfficialOrderRefreshPanel {...props} />
        </div>
      </div>
    </div>
  );
}
