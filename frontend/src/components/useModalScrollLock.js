import { useEffect } from 'react';

let lockCount = 0;
let previous = null;

/** 嵌套弹层共用滚动锁；iOS 固定背景，最后一层关闭时还原页面位置。 */
export default function useModalScrollLock() {
  useEffect(() => {
    const body = document.body;
    if (lockCount === 0) {
      previous = {
        x: window.scrollX,
        y: window.scrollY,
        styles: Object.fromEntries(
          ['position', 'top', 'left', 'right', 'width', 'overflow'].map(key => [
            key,
            body.style[key],
          ])
        ),
      };
      Object.assign(body.style, {
        position: 'fixed',
        top: `-${previous.y}px`,
        left: `-${previous.x}px`,
        right: '0',
        width: '100%',
        overflow: 'hidden',
      });
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0 && previous) {
        const saved = previous;
        previous = null;
        Object.assign(body.style, saved.styles);
        window.scrollTo(saved.x, saved.y);
      }
    };
  }, []);
}
