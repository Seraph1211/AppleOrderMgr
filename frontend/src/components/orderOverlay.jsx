import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import useModalScrollLock from './useModalScrollLock';
import './orderOverlay.css';

const overlayStack = [];

/** 订单弹层统一外壳：固定标题与操作区、嵌套焦点管理及可滚动正文。 */
export default function OrderOverlay({
  title,
  subtitle,
  onClose,
  closeLabel = `关闭${title}`,
  busy = false,
  size = 'medium',
  className = '',
  children,
  footer,
  navigation,
  sectionKey,
}) {
  const titleId = useId();
  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  // 在 React 提交 autoFocus 之前记录触发器，避免嵌套表单抢走返回焦点。
  const previousFocusRef = useRef(document.activeElement);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useModalScrollLock();

  useEffect(() => {
    const previous = previousFocusRef.current;
    const panel = panelRef.current;
    overlayStack.push(panel);
    const focused = panel.querySelector('[data-order-autofocus], [autofocus]') || panel;
    focused.focus({ preventScroll: true });
    const keydown = event => {
      if (overlayStack.at(-1) !== panel || event.defaultPrevented) return;
      // 原生下拉面板和嵌套照片弹层负责自己的键盘交互。
      if (event.target.closest('[role="dialog"], dialog') !== panel) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...panel.querySelectorAll(
          'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]'
        ),
      ].filter(element => element.getClientRects().length && !element.closest('[hidden]'));
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        panel.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === panel)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', keydown);
    return () => {
      panel.removeEventListener('keydown', keydown);
      const index = overlayStack.indexOf(panel);
      if (index !== -1) overlayStack.splice(index, 1);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [sectionKey]);

  return createPortal(
    <div
      data-orders-ui="true"
      className={`order-overlay ${className}`}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={panelRef}
        className={`order-overlay-panel order-overlay-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="order-overlay-heading">
          <div className="min-w-0">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="order-overlay-subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="btn btn-secondary order-overlay-close"
            aria-label={closeLabel}
            disabled={busy}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {navigation}
        <div ref={bodyRef} className="order-overlay-body">
          {children}
        </div>
        {footer && <footer className="order-overlay-footer">{footer}</footer>}
      </section>
    </div>,
    document.body
  );
}
