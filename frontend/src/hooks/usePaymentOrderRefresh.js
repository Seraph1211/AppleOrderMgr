import { useCallback, useEffect, useRef, useState } from 'react';
import client from '../api/client';

/** 付款专用单订单官网刷新；列表轮询读取跨页面和服务器自动刷新结果。 */
export default function usePaymentOrderRefresh({ dispatch = false, reload }) {
  const [actions, setActions] = useState({});
  const mounted = useRef(true);
  const locks = useRef(new Set());
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => reloadRef.current(true), 10000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);
  const start = useCallback(
    async task => {
      if (locks.current.has(task.id)) return;
      locks.current.add(task.id);
      const patch = value => {
        if (mounted.current) setActions(previous => ({ ...previous, [task.id]: value }));
      };
      const base = `${dispatch ? '/payment-dispatch/tasks' : '/payment-tasks'}/${task.id}/refresh`;
      patch({ busy: true, message: '正在提交官网查询…' });
      try {
        const response = await client.post(base, {
          requestKey: crypto.randomUUID(),
        });
        let job = response.data;
        let polls = 0;
        while (mounted.current && ['queued', 'running'].includes(job.state)) {
          if (job.workerOnline === false || polls >= 80) {
            patch({
              busy: false,
              pending: true,
              message:
                job.workerOnline === false
                  ? '官网查询已排队，等待 Worker 恢复；列表将自动加载结果'
                  : '官网查询仍在进行，列表将自动加载结果',
            });
            await reloadRef.current(true);
            return;
          }
          polls += 1;
          patch({
            busy: true,
            message:
              job.state === 'queued'
                ? job.workerOnline === false
                  ? '官网查询已排队，等待 Worker 恢复…'
                  : '等待官网查询…'
                : '正在查询官网…',
          });
          await new Promise(resolve => window.setTimeout(resolve, 1500));
          if (!mounted.current) return;
          job = (await client.get(`${base}/${job.jobId}`)).data;
        }
        if (!mounted.current) return;
        if (job.state !== 'succeeded') {
          patch({
            busy: false,
            error: true,
            message: '官网查询失败，保留上次官网状态，可重试',
          });
        } else {
          patch({ busy: false, message: '官网订单状态已更新' });
        }
        await reloadRef.current(true);
      } catch (error) {
        patch({
          busy: false,
          error: true,
          message: `查询结果未确认，保留上次官网状态：${error.message}`,
        });
      } finally {
        locks.current.delete(task.id);
      }
    },
    [dispatch]
  );
  return { actions, start };
}
