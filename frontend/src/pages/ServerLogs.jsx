import MonitorLogs from '../components/MonitorLogs';

/** 服务器完整运行日志独立页面，使用可分配的 monitor.logs.read 权限。 */
export default function ServerLogs() {
  return <MonitorLogs standalone />;
}
