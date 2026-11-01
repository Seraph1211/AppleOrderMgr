import { useLayoutEffect, useState } from 'react';

/** 将日志专属浮层限制在可视视口内，滚动和软键盘变化时重新定位。 */
export default function usePopupPosition(open, anchorRef, desiredWidth = 320) {
  const [position, setPosition] = useState(null);
  useLayoutEffect(() => {
    if (!open) return undefined;
    function measure() {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft || 0;
      const y = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const below = y + height - rect.bottom - 12;
      const above = rect.top - y - 12;
      const upwards = below < 440 && above > below;
      const popupWidth = Math.min(desiredWidth, width - 32);
      setPosition({
        position: 'fixed',
        width: popupWidth,
        left: Math.max(x + 16, Math.min(rect.right - popupWidth, x + width - popupWidth - 16)),
        maxHeight: Math.max(80, upwards ? above : below),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [open, anchorRef, desiredWidth]);
  return position;
}
