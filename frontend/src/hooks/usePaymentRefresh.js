import { useEffect, useRef, useState } from 'react';

const ACTIVE_STATUSES = ['submitting', 'pending', 'running'];

/** 跟踪付款列表的逐行刷新；轮询本站队列，完成后读取当前页。 */
export default function usePaymentRefresh({ submit, getJob, onComplete }) {
  const [progress, setProgress] = useState({});
  const [submittingBatch, setSubmittingBatch] = useState(false);
  const jobs = useRef({});
  const mounted = useRef(false);
  const callbacks = useRef({ submit, getJob, onComplete });
  callbacks.current = { submit, getJob, onComplete };

  const update = (taskId, value) => {
    jobs.current[taskId] = value;
    if (mounted.current) setProgress(previous => ({ ...previous, [taskId]: value }));
  };

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let querying = false;
    const timer = window.setInterval(async () => {
      if (querying) return;
      querying = true;
      try {
        const active = Object.entries(jobs.current).filter(([, job]) =>
          ['pending', 'running'].includes(job.status)
        );
        const results = await Promise.all(
          active.map(async ([taskId, current]) => {
            try {
              const response = await callbacks.current.getJob(Number(taskId), current.jobId);
              if (!response.success || !response.data?.status) throw new Error('刷新进度查询失败');
              return { taskId, current, job: response.data };
            } catch (error) {
              return { taskId, current, error: error.message };
            }
          })
        );
        if (cancelled) return;
        let completed = false;
        for (const { taskId, current, job, error } of results) {
          if (jobs.current[taskId] !== current) continue;
          if (error) {
            const queryFailures = (current.queryFailures || 0) + 1;
            update(taskId, {
              ...current,
              queryFailures,
              status: queryFailures >= 3 ? 'unknown' : current.status,
              refreshing: queryFailures < 3,
              message:
                queryFailures >= 3 ? `${error}，刷新结果未确认，可重试` : `${error}，正在重试查询`,
              type: 'error',
            });
            continue;
          }
          const terminal = !ACTIVE_STATUSES.includes(job.status);
          completed ||= terminal;
          update(taskId, {
            jobId: current.jobId,
            status: job.status,
            refreshing: !terminal,
            type: job.status === 'succeeded' ? 'success' : terminal ? 'error' : 'info',
            message:
              job.status === 'pending'
                ? '排队中，等待后台处理'
                : job.status === 'running'
                  ? '官网刷新中...'
                  : job.status === 'succeeded'
                    ? '官网状态已更新'
                    : job.lastErrorMessage ||
                      (job.status === 'skipped'
                        ? '刷新任务已跳过，可重试'
                        : '官网刷新失败，可重试'),
          });
        }
        if (completed) await callbacks.current.onComplete();
      } catch (error) {
        // 列表加载错误由页面呈现；保留行内已确认的官网任务结果。
        void error;
      } finally {
        querying = false;
      }
    }, 2000);
    return () => {
      cancelled = true;
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  const refreshTask = async task => {
    if (ACTIVE_STATUSES.includes(jobs.current[task.id]?.status)) return;
    update(task.id, {
      status: 'submitting',
      refreshing: true,
      type: 'info',
      message: '正在提交刷新...',
    });
    try {
      const response = await callbacks.current.submit(task.id);
      if (!response.success || !response.data?.jobId) throw new Error('刷新任务提交失败');
      if (!mounted.current) return;
      update(task.id, {
        jobId: response.data.jobId,
        status: 'pending',
        refreshing: true,
        type: 'info',
        message: '排队中，等待后台处理',
      });
    } catch (error) {
      if (mounted.current)
        update(task.id, {
          status: 'failed',
          refreshing: false,
          type: 'error',
          message: error.message,
        });
    }
  };

  const batchLock = useRef(false);
  const refreshSelected = async tasks => {
    if (batchLock.current) return;
    batchLock.current = true;
    setSubmittingBatch(true);
    try {
      // 每批至多五个入队请求；每项独立反馈，单项失败不阻断其他订单。
      for (let index = 0; index < tasks.length && mounted.current; index += 5) {
        await Promise.all(tasks.slice(index, index + 5).map(refreshTask));
      }
    } catch (error) {
      void error;
    } finally {
      batchLock.current = false;
      if (mounted.current) setSubmittingBatch(false);
    }
  };

  return { progress, refreshTask, refreshSelected, submittingBatch };
}
