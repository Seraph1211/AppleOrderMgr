import { useEffect, useRef, useState } from 'react';
import { Monitor, Loader2 } from 'lucide-react';
import client from '../api/client';
import { collectBrowserOrder } from '../utils/browserOrderRefresh';

export default function BrowserRefreshButton({ order, disabled, onBusyChange, onUpdated }) {
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const controller = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const busy = phase !== 'idle';

  const refresh = async event => {
    event.stopPropagation();
    if (busy || disabled) return;
    const cancellation = new AbortController();
    controller.current = cancellation;
    setPhase('starting');
    setMessage('');
    onBusyChange(true);
    let ticket;
    try {
      const page = await collectBrowserOrder({
        runtime: window.chrome?.runtime,
        signal: cancellation.signal,
        task: async () => {
          const response = await client.post(
            `/orders/${order.id}/browser-refresh/start`,
            {},
            { signal: cancellation.signal }
          );
          ticket = response.data.ticket;
          return response.data;
        },
        permit: async () => {
          await client.post(
            `/orders/${order.id}/browser-refresh/permit`,
            { ticket },
            { signal: cancellation.signal, timeout: 15000 }
          );
        },
        onProgress: value => {
          if (mounted.current) setPhase(value);
        },
      });
      if (cancellation.signal.aborted) throw new Error('已取消，本次未更新');
      if (mounted.current) setPhase('saving');
      // 写入已开始后不提供“取消成功”承诺；等待服务端明确结果。
      await client.post(`/orders/${order.id}/browser-refresh/result`, {
        ticket,
        page,
      });
      if (mounted.current) setMessage('已更新订单');
      await onUpdated();
    } catch (error) {
      if (mounted.current)
        setMessage(error.response?.data?.error?.message || error.message || '浏览器刷新失败');
    } finally {
      controller.current = null;
      if (mounted.current) setPhase('idle');
      onBusyChange(false);
    }
  };

  return (
    <div className="text-right" onClick={event => event.stopPropagation()}>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn btn-secondary text-sm inline-flex items-center gap-1"
          disabled={disabled || busy}
          onClick={refresh}
          aria-label={`浏览器刷新 ${order.orderNumber}`}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Monitor className="w-4 h-4" />}
          {phase === 'saving' ? '正在更新' : busy ? '浏览器读取中' : '浏览器刷新'}
        </button>
        {busy && phase !== 'saving' && (
          <button
            type="button"
            className="btn btn-secondary text-sm"
            onClick={() => controller.current?.abort()}
          >
            取消
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="text-xs text-gray-600 mt-1 max-w-64 ml-auto">
          {message}
        </p>
      )}
      {!busy && message.includes('扩展') && (
        <a
          className="text-xs text-primary"
          href="/browser-collector/README.txt"
          target="_blank"
          rel="noreferrer"
        >
          查看安装说明
        </a>
      )}
    </div>
  );
}
