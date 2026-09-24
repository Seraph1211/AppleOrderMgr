import { Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { copyDeferredText } from '../utils/copyDeferredText';

/** 按当前调度读取权限复制 AOS 支付宝付款链接。 */
export default function AlipayPaymentLinkButton({ task, getLink, onResult }) {
  const [copying, setCopying] = useState(false);
  const lock = useRef(false);
  const copy = async () => {
    if (lock.current) return;
    lock.current = true;
    setCopying(true);
    try {
      await copyDeferredText(async () => {
        const response = await getLink(task.id);
        if (!response.success || !response.data?.paymentUrl) {
          throw new Error('支付宝付款链接不存在');
        }
        return response.data.paymentUrl;
      });
      onResult('success', '支付宝付款链接已复制');
    } catch (error) {
      onResult('error', `复制失败：${error.message || '支付宝付款链接读取失败'}`);
    } finally {
      lock.current = false;
      setCopying(false);
    }
  };
  return (
    <button
      type="button"
      className="btn btn-secondary px-2 inline-flex items-center justify-center gap-1"
      disabled={copying}
      aria-busy={copying}
      aria-label={`复制支付宝付款链接 ${task.orderNumber}`}
      onClick={copy}
    >
      <Copy aria-hidden="true" className="w-4 h-4 shrink-0" />
      <span>{copying ? '复制中...' : '复制付款链接'}</span>
    </button>
  );
}
