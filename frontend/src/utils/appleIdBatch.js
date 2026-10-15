/** 合并或移除当前页 ID，保留其他页选择。 */
export function togglePageSelection(selected, pageIds, checked) {
  const next = new Set(selected);
  pageIds.forEach(id => (checked ? next.add(id) : next.delete(id)));
  return next;
}

/** 仅提交选定的新状态或编辑过的备注；备注空白表示清空。 */
export function buildAppleIdBatchPayload(ids, changes) {
  if (!changes.status && !changes.notesEdited) throw new Error('请修改状态或备注');
  return {
    ids: [...ids],
    ...(changes.status ? { status: changes.status } : {}),
    ...(changes.notesEdited ? { notes: changes.notes.trim() === '' ? null : changes.notes } : {}),
  };
}

/** 加载当前筛选下的 ID 快照；筛选、取消或新请求后禁止恢复旧选集。 */
export async function loadAppleIdSelection({
  fetchIds,
  generation,
  onSelected,
  onLoading,
  onError,
}) {
  const requestId = ++generation.current;
  onLoading(true);
  onError('');
  try {
    const response = await fetchIds();
    if (requestId !== generation.current) return;
    if (!response.success) throw new Error('加载筛选结果失败');
    const { ids, total } = response.data;
    if (
      !Array.isArray(ids) ||
      ids.length !== total ||
      new Set(ids).size !== ids.length ||
      ids.some(id => !Number.isInteger(id) || id <= 0)
    )
      throw new Error('筛选结果不完整，请重试');
    if (total > 5000) throw new Error('最多选择 5000 个 Apple ID，请缩小筛选范围');
    onSelected(new Set(ids));
  } catch (error) {
    if (requestId === generation.current) onError(error.message || '加载筛选结果失败，请重试');
  } finally {
    if (requestId === generation.current) onLoading(false);
  }
}
