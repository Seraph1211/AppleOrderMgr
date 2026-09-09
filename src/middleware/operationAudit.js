const { OperationLog } = require('../models');
const logger = require('../utils/logger');

const MODULE_LABELS = {
  auth: '账号',
  users: '系统账号',
  orders: '订单',
  'apple-ids': 'Apple ID',
  recipients: '取机人',
  channels: '渠道',
  dashboard: '仪表板',
  stats: '统计',
  'email-processing': '邮件处理',
  'payment-tasks': '本人付款任务',
  'payment-dispatch': '付款调度',
  'order-refresh': '订单刷新任务',
  system: '系统',
  import: '导入',
};
const ACTION_LABELS = {
  login: '登录账号',
  logout: '退出登录',
  'change-password': '修改本人密码',
  profile: '修改本人昵称',
  'reset-password': '重置账号密码',
  unlock: '解锁账号',
  permissions: '账号权限',
  'permission-catalog': '权限目录',
  export: '导出',
  template: '下载模板',
  preview: '预览导入',
  execute: '执行导入',
  confirm: '确认导入',
  refresh: '刷新',
  'batch-refresh': '批量刷新',
  'refresh-batch': '批量刷新',
  'batch-update': '批量更新',
  'batch-delete': '批量删除',
  'generate-contacts': '生成联系方式',
  'generate-addresses': '生成地址',
  'bind-apple-ids': '绑定 Apple ID',
  reparse: '重新解析邮件',
  draft: '编辑邮件草稿',
  ingest: '邮件入库',
  close: '关闭邮件',
  'batch-reparse': '批量重新解析邮件',
  'batch-ingest': '批量邮件入库',
  'payment-link': '获取付款链接',
  link: '获取付款链接',
  payer: '登记付款人',
  status: '任务状态',
  notes: '备注',
  settings: '设置',
  staff: '接单人员',
  assign: '分配任务',
  reassign: '转派任务',
  'auto-assign': '自动分配任务',
  'manual-assign': '手动分配任务',
  events: '历史记录',
  logs: '运行日志',
  'operation-logs': '账号操作记录',
  'proxy-provider': '代理服务',
  'auto-refresh': '自动刷新',
  resume: '恢复自动刷新',
  metrics: '运行指标',
  assignee: '分配／转派任务',
  reopen: '重新打开任务',
  scan: '扫描并分配任务',
  resolve: '人工关闭邮件',
  'batch-generate-contact': '批量生成联系方式',
  'batch-generate-address': '批量生成地址',
  'refresh-all': '刷新全部订单',
  'page-open-refresh': '打开页面刷新订单',
  'filter-options': '筛选选项',
};
const VERBS = { GET: '查看', POST: '执行', PUT: '修改', PATCH: '修改', DELETE: '删除' };

/**
 * 根据可信路由模板生成中文动作和脱敏目标；不采集正文或 URL 查询值。
 * @param {Object} req - 请求
 * @returns {Object} 操作说明
 */
function describeOperation(req) {
  const moduleKey = req.originalUrl.split('?')[0].split('/')[2];
  const moduleLabel = MODULE_LABELS[moduleKey] || '未知模块';
  const route = typeof req.route?.path === 'string' ? req.route.path : '';
  const parts = route.split('/').filter(part => part && !part.startsWith(':'));
  const special = parts
    .map(part => ACTION_LABELS[part])
    .filter(Boolean)
    .join('／');
  const verb = req.method === 'POST' && !parts.length ? '创建' : VERBS[req.method] || '访问';
  const direct = [
    'login',
    'logout',
    'change-password',
    'profile',
    'reset-password',
    'unlock',
  ].includes(parts.at(-1));
  const action = direct
    ? special
    : special
      ? `${verb}${moduleLabel}：${special}`
      : `${verb}${moduleLabel}`;
  const ids = Object.entries(req.params || {}).filter(
    ([key, value]) => /id$/i.test(key) && /^\d{1,12}$/.test(String(value))
  );
  return {
    action,
    target:
      `${moduleLabel}${ids.length ? `；目标编号 ${ids.map(([, value]) => value).join('，')}` : special ? `；${special}` : ''}`.slice(
        0,
        500
      ),
  };
}

/**
 * 记录业务响应，等待数据库追加后结束响应；数据库故障时保留脱敏应急日志。
 * @param {Object} req - 请求
 * @param {Object} res - 响应
 * @param {Function} next - 后续中间件
 */
function operationAudit(req, res, next) {
  const path = req.originalUrl.split('?')[0].replace(/\/$/, '');
  if (
    !path.startsWith('/api/') ||
    path.startsWith('/api/health') ||
    path === '/api/auth/me' ||
    req.method === 'OPTIONS'
  )
    return next();
  const createdAt = new Date();
  const end = res.end;
  let recorded = false;
  res.end = function (...args) {
    if (recorded) return this;
    recorded = true;
    const actor = req.user || req.auditActor;
    const attemptedUsername =
      path === '/api/auth/login' &&
      typeof req.body?.username === 'string' &&
      /^[a-zA-Z0-9_]{1,50}$/.test(req.body.username)
        ? req.body.username
        : null;
    const payload = {
      actorUserId: actor?.id || null,
      username: actor?.username || attemptedUsername,
      nickname: actor?.nickname || actor?.username || null,
      ...describeOperation(req),
      ...(req.auditTarget ? { target: req.auditTarget } : {}),
      method: req.method,
      ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 64),
      statusCode: res.statusCode,
      result:
        res.statusCode < 400
          ? 'success'
          : path === '/api/auth/login' && res.statusCode === 409
            ? 'cancelled'
            : 'failed',
      requestId: req.requestId,
      createdAt,
    };
    OperationLog.create(payload)
      .catch(error =>
        logger.error('操作审计写入失败，保留应急记录', { ...payload, error: error.message })
      )
      .finally(() => end.apply(this, args));
    return this;
  };
  next();
}

module.exports = { operationAudit, describeOperation };
