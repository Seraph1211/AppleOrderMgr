/**
 * 逐单提交处理状态，保留每单版本保护并汇总失败；不自动重试。
 * @param {Object[]} tasks - 提交时选中任务的快照
 * @param {string} status - 人工目标状态
 * @param {string} notes - 可选统一备注，空白时保留原备注
 * @param {Function} updateTask - 单项 API
 * @param {Function} createKey - 每单幂等键生成器
 * @returns {Promise<Object[]>} 每单处理结果
 */
export async function updateSelectedTaskStatuses(tasks, status, notes, updateTask, createKey) {
  const results = [];
  for (const task of tasks) {
    try {
      const payload = { processingStatus: status, expectedVersion: task.version };
      if (notes.trim()) payload.processingNotes = notes.trim();
      const response = await updateTask(task.id, payload, createKey());
      results.push({ id: task.id, orderId: task.orderId, success: true, task: response.data });
    } catch (error) {
      results.push({
        id: task.id,
        orderId: task.orderId,
        success: false,
        message: error.message || '提交失败，请核查后重试',
      });
    }
  }
  return results;
}
