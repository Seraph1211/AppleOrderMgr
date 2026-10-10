import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  const dialogRef = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = returnFocusRef?.current || document.activeElement;
    const overflow = document.body.style.overflow;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const height = viewport?.height || window.innerHeight;
      dialog.style.maxHeight = `${Math.max(160, height - 24)}px`;
      dialog.style.bottom = `${Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0))}px`;
    };
    updateViewport();
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    return () => {
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      dialog.close();
      document.body.style.overflow = overflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [returnFocusRef]);
  return createPortal(
    <dialog
      ref={dialogRef}
      id={id}
      className="mobile-picker-dialog"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }}
      onKeyDown={event => event.stopPropagation()}
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
          autoFocus
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
