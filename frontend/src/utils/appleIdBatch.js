/** 合并或移除当前页 ID，保留其他页选择。 */
export function togglePageSelection(selected, pageIds, checked) {
  const next = new Set(selected);
  pageIds.forEach(id => (checked ? next.add(id) : next.delete(id)));
  return next;
}

/** 仅构造明确勾选的字段；备注空字符串表示清空。 */
export function buildAppleIdBatchPayload(ids, changes) {
  if (!changes.changeStatus && !changes.changeNotes) throw new Error('请勾选要修改的字段');
  return {
    ids: [...ids],
    ...(changes.changeStatus ? { status: changes.status } : {}),
    ...(changes.changeNotes ? { notes: changes.notes.trim() === '' ? null : changes.notes } : {}),
  };
}
