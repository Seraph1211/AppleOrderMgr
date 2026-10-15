/** 只统计当前占用，历史已释放账号不要求再次确认停抢。 */
export function activeAssignmentCount(order) {
  return (order?.assignments || []).filter(assignment => !assignment.endedAt).length;
}

/** 删除当前页唯一一项时回退一页，避免停留在空末页。 */
export function pageAfterDeletion(page, rows, deletedId) {
  return page > 1 && rows.length === 1 && rows[0].id === deletedId ? page - 1 : page;
}
