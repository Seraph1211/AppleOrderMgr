import MonitorLogs from '../components/MonitorLogs';

/** 服务器完整运行日志独立页面，沿用 monitor.manage 权限与日志查询组件。 */
export default function ServerLogs() {
  return <MonitorLogs standalone />;
}
