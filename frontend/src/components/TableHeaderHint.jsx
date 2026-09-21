import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle } from 'lucide-react';

/** 表头说明：立即显示，保持箭头鼠标，浮层不受表格滚动容器裁切。 */
export default function TableHeaderHint({ label, children }) {
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);
  const closeTimer = useRef(null);
  const tooltipId = useId();
  const isOpen = Boolean(position);
  const keepOpen = () => window.clearTimeout(closeTimer.current);
  const closeSoon = () => {
    keepOpen();
    closeTimer.current = window.setTimeout(() => setPosition(null), 100);
  };
  const show = () => {
    keepOpen();
    const box = triggerRef.current.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    setPosition({
      width,
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      ...(window.innerHeight - box.bottom < 140 && box.top > 140
        ? { bottom: window.innerHeight - box.top + 6 }
        : { top: box.bottom + 6 }),
    });
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!isOpen) return undefined;
    const close = () => setPosition(null);
    const closeOutside = event => {
      if (
        !triggerRef.current?.contains(event.target) &&
        !tooltipRef.current?.contains(event.target)
      ) {
        close();
      }
    };
    const closeOnEscape = event => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={isOpen ? tooltipId : undefined}
        className="inline-flex cursor-default rounded text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
        onMouseEnter={show}
        onMouseLeave={closeSoon}
        onFocus={show}
        onBlur={() => setPosition(null)}
        onClick={show}
      >
        <AlertCircle className="w-4 h-4" aria-hidden="true" />
      </button>
      {isOpen &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            style={position}
            className="fixed z-[100] cursor-default whitespace-normal rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm font-normal leading-6 text-gray-700 shadow-lg"
            onMouseEnter={keepOpen}
            onMouseLeave={closeSoon}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
