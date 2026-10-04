import { useCallback, useEffect, useRef, useState } from 'react';
import { createStockRequestKey, stockCommand, stockGet } from '../../api/stockApi';

/** 查询可刷新资源；切换筛选后取消旧请求，避免旧响应覆盖。 */
export function useStockData(path, params = {}, enabled = true) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const query = JSON.stringify(params);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled || !path) {
      setData(null);
      setError('');
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError('');
    const load = async () => {
      try {
        const result = await stockGet(path, JSON.parse(query), controller.signal);
        if (!controller.signal.aborted) setData(result);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(failure.message || '加载失败');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [path, query, revision, enabled]);
  return { data, loading, error, reload };
}

/** 幂等表单命令：失败保留同一请求键，修改内容才生成新键。 */
export function useStockCommand() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState(null);
  const active = useRef(false);
  const pending = useRef(null);
  const execute = async (method, path, payload) => {
    if (active.current) return null;
    active.current = true;
    setBusy(true);
    setError('');
    setErrorDetails(null);
    try {
      const fingerprint = JSON.stringify([method, path, payload]);
      if (pending.current?.fingerprint !== fingerprint)
        pending.current = { fingerprint, key: createStockRequestKey() };
      const data = await stockCommand(method, path, payload, pending.current.key);
      pending.current = null;
      return data ?? {};
    } catch (failure) {
      setErrorDetails(failure.details || null);
      setError(
        failure.code === 'VERSION_CONFLICT'
          ? '记录已被其他人修改。请关闭表单后重新打开核对，当前填写内容仍保留，未自动覆盖。'
          : failure.message || '提交未确认，请保留当前内容重试'
      );
      return null;
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return { busy, error, errorDetails, setError, execute };
}
