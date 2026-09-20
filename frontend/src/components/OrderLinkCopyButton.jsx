import { useRef, useState } from 'react';
import { copyDeferredText } from '../utils/copyDeferredText';

/** 点击 Apple 订单号按需读取并复制原订单链接，不在页面中保存链接。 */
export default function OrderLinkCopyButton({ task, getLink, onResult }) {
  const [copying, setCopying] = useState(false);
  const lock = useRef(false);
  const copy = async () => {
    if (lock.current) return;
    lock.current = true;
    setCopying(true);
    try {
      await copyDeferredText(async () => {
        try {
          const response = await getLink(task.id);
          if (!response.success || !response.data?.paymentUrl) throw new Error('订单链接不存在');
          return response.data.paymentUrl;
        } catch (error) {
          throw new Error(error.message || '订单链接读取失败');
        }
      });
      onResult('success', '订单链接已复制');
    } catch (error) {
      onResult('error', `复制失败：${error.message}`);
    } finally {
      lock.current = false;
      setCopying(false);
    }
  };
  return (
    <button
      type="button"
      title="点击复制订单链接"
      aria-label={`复制订单链接 ${task.orderNumber}`}
      aria-busy={copying}
      disabled={copying}
      onClick={copy}
      className="min-h-11 sm:min-h-0 text-left font-mono text-sm font-medium text-primary hover:text-primary-700 hover:underline cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
    >
      {task.orderNumber}
    </button>
  );
}
