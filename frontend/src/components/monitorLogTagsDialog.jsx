import { useEffect, useRef } from 'react';
import MonitorLogTags from './monitorLogTags';

/** 独立标签管理弹窗；原生 dialog 提供焦点隔离，关闭后保留本次草稿。 */
export default function MonitorLogTagsDialog({ open, onClose, catalog, onSaved, onCatalog }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open) {
      if (dialog.open) dialog.close();
      return undefined;
    }
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    dialog.querySelector('input')?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);
  const devices = [...(catalog?.devices || [])].sort((a, b) => {
    const priority = name => {
      const match = /^US(?:\s+Server\s+(?:No\.)?)?0*(\d+)$/i.exec(name);
      const number = match ? Number(match[1]) : 0;
      return number >= 1 && number <= 10 ? number : 11;
    };
    return (
      priority(a.name) - priority(b.name) ||
      a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    );
  });
  return (
    <dialog
      ref={dialogRef}
      id="log-tag-management"
      aria-labelledby="log-tag-dialog-title"
      className="monitor-log-tags-dialog"
      onClose={onClose}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [
          ...event.currentTarget.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
          ),
        ].filter(element => element.getClientRects().length);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header className="monitor-log-tags-dialog-header">
        <h2 id="log-tag-dialog-title">标签管理</h2>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          aria-label="关闭标签管理"
        >
          关闭
        </button>
      </header>
      <div className="monitor-log-tags-dialog-body">
        <MonitorLogTags catalog={{ ...catalog, devices }} onSaved={onSaved} onCatalog={onCatalog} />
      </div>
      <footer className="monitor-log-tags-dialog-footer">
        标签按行保存，修改后请点击对应行的“保存”。
      </footer>
    </dialog>
  );
}
