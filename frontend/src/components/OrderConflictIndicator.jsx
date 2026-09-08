import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle } from 'lucide-react';
import { formatOrderConflict } from '../constants/orderStatus';

function locateTooltip(button) {
  const box = button.getBoundingClientRect();
  if (box.bottom < 0 || box.top > window.innerHeight) return null;
  const left = Math.max(8, Math.min(box.left, window.innerWidth - 352));
  if (window.innerHeight - box.bottom < 160 && box.top > 160) {
    return { left, bottom: window.innerHeight - box.top + 6, maxHeight: box.top - 18 };
  }
  return {
    left,
    top: box.bottom + 6,
    maxHeight: Math.max(80, window.innerHeight - box.bottom - 18),
  };
}

/** 行首冲突提示，支持鼠标、键盘和触摸；浮层不被横向表格裁切。 */
export default function OrderConflictIndicator({ issues = [] }) {
  const [position, setPosition] = useState(null);
  const buttonRef = useRef(null);
  const closeTimer = useRef(null);
  const tooltipId = useId();
  const keepOpen = () => window.clearTimeout(closeTimer.current);
  const closeSoon = () => {
    keepOpen();
    closeTimer.current = window.setTimeout(() => setPosition(null), 150);
  };
  useEffect(() => {
    const reposition = () =>
      setPosition(current =>
        current && buttonRef.current ? locateTooltip(buttonRef.current) : null
      );
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.clearTimeout(closeTimer.current);
    };
  }, []);
  if (!issues.length) return null;
  const show = event => {
    keepOpen();
    setPosition(locateTooltip(event.currentTarget));
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex text-amber-600 cursor-help rounded focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label={`查看 ${issues.length} 项订单冲突`}
        aria-describedby={position ? tooltipId : undefined}
        onMouseEnter={show}
        onFocus={show}
        onClick={show}
        onMouseLeave={closeSoon}
        onBlur={() => setPosition(null)}
        onKeyDown={event => {
          if (event.key === 'Escape') setPosition(null);
        }}
      >
        <AlertCircle className="w-5 h-5" />
      </button>
      {position &&
        createPortal(
          <div
            role="tooltip"
            id={tooltipId}
            style={position}
            onMouseEnter={keepOpen}
            onMouseLeave={closeSoon}
            className="fixed z-[100] w-[344px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-amber-200 bg-white p-3 text-sm text-gray-700 shadow-lg"
          >
            <p className="font-medium text-amber-700 mb-2">订单数据冲突</p>
            <ul className="space-y-2">
              {issues.map((issue, index) => (
                <li key={index}>{formatOrderConflict(issue)}</li>
              ))}
            </ul>
          </div>,
          document.body
        )}
    </>
  );
}
