/** 按任务实际起止时间显示耗时；排队、缺失时间或无效时间不伪造结果。 */
export function formatOfficialRefreshDuration(job, now) {
  const started = Date.parse(job.startedAt);
  const finished = Date.parse(job.finishedAt);
  const end = job.state === 'running' ? now : finished;
  if (!Number.isFinite(started) || !Number.isFinite(end) || end < started) return '—';
  const seconds = Math.floor((end - started) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`;
}
