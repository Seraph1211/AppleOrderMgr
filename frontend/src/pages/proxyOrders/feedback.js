/** 将接口账号数量归一化；未知值保留为空，避免误启用分配。 */
export function normalizeAvailableCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/** 返回自动分配不可执行的原因，手选账号仍以服务端事务校验为准。 */
export function assignmentBlockReason(availableCount, count, manualAccount) {
  if (availableCount === null) return '可用账号数量未获取，请关闭后重新打开分配窗口。';
  if (availableCount === 0) return '暂无可用账号，请前往账号池导入账号或核对占用、下架及异常状态。';
  if (manualAccount) return '';
  if (!Number.isInteger(count) || count < 1 || count > 20) return '分配数量须为 1–20 的整数。';
  if (count > availableCount) return `可用账号不足，当前最多可分配 ${availableCount} 个。`;
  return '';
}

/** 剪贴板权限被拒、API 不可用或长时间无响应时，让页面进入手动复制。 */
export async function tryClipboard(value, clipboard, timeoutMs = 1500) {
  let timer;
  try {
    if (!clipboard?.writeText) return false;
    await Promise.race([
      clipboard.writeText(value),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('clipboard timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
