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
