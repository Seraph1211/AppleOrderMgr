import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { useEffect } from 'react';

const TYPE_STYLES = {
  success: 'border-green-200 bg-green-50 text-green-800',
  error: 'border-red-200 bg-red-50 text-red-800',
  info: 'border-blue-200 bg-blue-50 text-blue-800',
};

const TYPE_ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

/**
 * 在视口中心展示无需用户确认的自动关闭提示。
 * @param {{toast: {id: number, type: string, message: string}|null, onDismiss: Function, duration?: number}} props - 提示配置
 * @returns {JSX.Element|null} Toast
 */
export default function AutoDismissToast({ toast, onDismiss, duration = 2600 }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [duration, onDismiss, toast]);

  if (!toast) return null;
  const Icon = TYPE_ICONS[toast.type] || Info;

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-1/2 z-[80] w-[min(90vw,32rem)] -translate-x-1/2 -translate-y-1/2"
      data-testid="center-toast"
      role={toast.type === 'error' ? 'alert' : 'status'}
    >
      <div
        className={`flex items-start gap-3 rounded-xl border px-5 py-4 text-sm font-medium shadow-xl ${TYPE_STYLES[toast.type] || TYPE_STYLES.info}`}
      >
        <Icon className="mt-0.5 h-5 w-5 shrink-0" />
        <span className="min-w-0 break-words">{toast.message}</span>
      </div>
    </div>
  );
}
