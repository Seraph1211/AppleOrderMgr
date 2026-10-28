import { useEffect, useRef } from 'react';

/** 切换任务配置面板时保留可见位置，避免旧滚动把新标题留在固定页头后方。 */
export default function useTaskConfigPanel(active = true) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    const frame = requestAnimationFrame(() => {
      const panel = ref.current;
      if (!panel) return;
      const top = panel.getBoundingClientRect().top;
      if (top < 64 || top > window.innerHeight * 0.6) {
        panel.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
      panel.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return ref;
}
