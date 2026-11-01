import MonitorLogQuery from '../components/logQuery/monitorLogQuery';
import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';

const LegacyMonitorLogs = lazy(() => import('../components/MonitorLogs'));

/** 日志查询独立页面；view=legacy保留原筛选和原生范围导出入口。 */
export default function ServerLogs() {
  const [params] = useSearchParams();
  if (params.get('view') === 'legacy') {
    return (
      <Suspense
        fallback={
          <p role="status" className="p-4 text-gray-600">
            正在读取日志查询…
          </p>
        }
      >
        <LegacyMonitorLogs standalone />
      </Suspense>
    );
  }
  return <MonitorLogQuery />;
}
