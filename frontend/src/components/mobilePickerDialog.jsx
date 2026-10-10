import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import useModalScrollLock from './useModalScrollLock';
import { X } from 'lucide-react';

/** 手机选项弹层：原生 dialog 约束焦点，支持嵌套表单、软键盘和安全区。 */
export default function MobilePickerDialog({
  title,
  onClose,
  returnFocusRef,
  children,
  footer,
  id,
}) {
  useModalScrollLock();
  const dialogRef = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = returnFocusRef?.current || document.activeElement;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const height = viewport?.height || window.innerHeight;
      dialog.style.maxHeight = `${Math.max(160, height - 24)}px`;
      dialog.style.bottom = `${Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0))}px`;
    };
    updateViewport();
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    return () => {
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [returnFocusRef]);
  return createPortal(
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      id={id}
      className="mobile-picker-dialog"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key !== 'Tab') return;
        const controls = [
          ...dialogRef.current.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), [href], [tabindex="0"]'
          ),
        ].filter(node => node.getClientRects().length);
        if (!controls.length) return;
        event.preventDefault();
        const current = controls.indexOf(document.activeElement);
        const next = event.shiftKey
          ? current <= 0
            ? controls.length - 1
            : current - 1
          : (current + 1) % controls.length;
        controls[next].focus({ preventScroll: true });
      }}
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        if (event.target === dialogRef.current) closeRef.current();
      }}
    >
      <header className="mobile-picker-heading">
        <h2 id={titleId} className="min-w-0 flex-1 font-semibold text-gray-900">
          {title}
        </h2>
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`关闭${title}`}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="mobile-picker-content">{children}</div>
      {footer && <footer className="mobile-picker-footer">{footer}</footer>}
    </dialog>,
    document.body
  );
}
