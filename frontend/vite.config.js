import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

// 每次构建生成北京时间版本，避免侧栏长期显示固定的 v1.0.0。
const buildVersion = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
  .format(new Date())
  .replace(/\D/g, '');

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(buildVersion),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
