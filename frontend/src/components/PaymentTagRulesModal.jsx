import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Save, Tags, X } from 'lucide-react';
import TagMultiSelect from './TagMultiSelect';
import {
  deletePaymentTagRule,
  getPaymentDispatchOverview,
  getPaymentTagRules,
  savePaymentTagRule,
} from '../api/paymentDispatchApi';

const BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50';
const emptyRule = () => ({ name: '', enabled: true, recipientTags: [], assigneeUserIds: [] });
const accountLabel = person =>
  person ? `${person.nickname || person.username}（${person.username}）` : '';

/** 管理 AOS TAG 自动分配规则，所有修改均显式保存。 */
export default function PaymentTagRulesModal({ onClose, onSaved }) {
  const [rules, setRules] = useState([]);
  const [tagOptions, setTagOptions] = useState([]);
  const [staff, setStaff] = useState([]);
  const [draft, setDraft] = useState(null);
  const [newTag, setNewTag] = useState('');
  const [staffSearch, setStaffSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(null);
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [response, overview] = await Promise.all([
        getPaymentTagRules(),
        getPaymentDispatchOverview(),
      ]);
      setRules(response.data.items);
      setTagOptions(response.data.tagOptions);
      setStaff(overview.data.staff);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    // 加载或切换编辑视图会移除当前焦点元素，将焦点保留在弹窗中。
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
  }, [loading, draft]);

  const runMutation = async (action, message) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setDraft(null);
      setDeleting(null);
      setNotice(message);
      await load();
      onSaved();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  };
  const edit = rule => {
    setError('');
    setNotice('');
    setNewTag('');
    setStaffSearch('');
    setDeleting(null);
    setDraft(
      rule
        ? {
            ...rule,
            recipientTags: [...rule.recipientTags],
            assigneeUserIds: [...rule.assigneeUserIds],
          }
        : emptyRule()
    );
  };
  const addTag = () => {
    const tag = newTag.trim();
    if (!tag || tag.length > 500) {
      setError('请输入 1–500 个字符的完整 TAG');
      return;
    }
    if (draft.recipientTags.length >= 100 && !draft.recipientTags.includes(tag)) {
      setError('每条规则最多 100 个 TAG');
      return;
    }
    setDraft(previous => ({
      ...previous,
      recipientTags: [...new Set([...previous.recipientTags, tag])],
    }));
    setNewTag('');
    setError('');
  };
  const save = async event => {
    event.preventDefault();
    if (newTag.trim()) {
      setError('尚有未添加的 TAG，请先点击「添加 TAG」');
      return;
    }
    if (!draft.recipientTags.length || !draft.assigneeUserIds.length) {
      setError('请至少选择一个 TAG 和一个目标账号');
      return;
    }
    await runMutation(
      () => savePaymentTagRule(draft.id, { ...draft, expectedVersion: draft.version }),
      '规则已保存，将在下一次自动调度时生效'
    );
  };
  const selectedMissing =
    draft?.assigneeUserIds.filter(id => !staff.some(person => person.id === id)) || [];
  const visibleStaff = staff.filter(person =>
    `${accountLabel(person)} U${String(person.id).padStart(4, '0')}`
      .toLowerCase()
      .includes(staffSearch.trim().toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3 sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-rules-title"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            if (draft) setDraft(null);
            else closeRef.current();
          }
          if (event.key === 'Tab') {
            const elements = [
              ...dialogRef.current.querySelectorAll(
                'button, input, select, textarea, [tabindex="0"]'
              ),
            ].filter(element => !element.matches(':disabled') && element.getClientRects().length);
            const first = elements[0];
            const last = elements[elements.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialogRef.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3 shrink-0">
          <div>
            <h2
              id="tag-rules-title"
              className="text-lg font-semibold text-gray-900 flex items-center gap-2"
            >
              <Tags className="w-5 h-5 text-primary" />
              TAG 分配规则
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              AOS TAG 完整匹配；在指定账号中按负载分配，无人可接单时等待。
            </p>
          </div>
          <button
            type="button"
            className={`btn btn-secondary p-2 ${BUTTON_CLASS}`}
            aria-label="关闭 TAG 分配规则"
            disabled={busy}
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-auto min-h-0 p-4 sm:p-5 space-y-4">
          {error && (
            <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 break-words">
              {error}
              <button
                type="button"
                className="ml-3 underline"
                disabled={busy || loading}
                onClick={() => {
                  setDraft(null);
                  setDeleting(null);
                  load();
                }}
              >
                重新加载规则
              </button>
            </div>
          )}
          {notice && (
            <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
              {notice}
            </p>
          )}
          {loading ? (
            <p role="status" className="py-10 text-center text-gray-500">
              正在加载规则...
            </p>
          ) : draft ? (
            <form onSubmit={save} className="space-y-4">
              <fieldset disabled={busy} className="space-y-4 min-w-0">
                <div className="flex flex-wrap gap-4 items-end">
                  <label className="block flex-1 min-w-0 text-sm text-gray-700">
                    规则名称
                    <input
                      autoFocus
                      required
                      maxLength={100}
                      className="input w-full mt-1"
                      value={draft.name}
                      onChange={event => setDraft({ ...draft, name: event.target.value })}
                    />
                  </label>
                  <label className="flex items-center gap-2 py-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-primary"
                      checked={draft.enabled}
                      onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
                    />
                    启用规则
                  </label>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-700">
                    匹配 TAG（已选 {draft.recipientTags.length} 个）
                  </p>
                  <TagMultiSelect
                    ariaLabel="选择规则 TAG"
                    placeholder="选择 AOS TAG"
                    options={tagOptions}
                    value={draft.recipientTags}
                    onChange={recipientTags => setDraft({ ...draft, recipientTags })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <input
                      aria-label="手工输入 TAG"
                      className="input flex-1 min-w-0"
                      placeholder="输入完整 TAG，可提前配置尚未入库的 TAG"
                      maxLength={500}
                      value={newTag}
                      onChange={event => setNewTag(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addTag();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className={`btn btn-secondary ${BUTTON_CLASS}`}
                      onClick={addTag}
                    >
                      添加 TAG
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {draft.recipientTags.map(tag => (
                      <span
                        key={tag}
                        className="inline-flex max-w-full items-center gap-1 rounded bg-blue-50 px-2 py-1 text-sm text-primary"
                      >
                        <span className="break-all">{tag}</span>
                        <button
                          type="button"
                          aria-label={`移除 TAG ${tag}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              recipientTags: draft.recipientTags.filter(value => value !== tag),
                            })
                          }
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500">
                    区分大小写，去除首尾空格。同一 TAG 只能存在于一条启用规则中。
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-700">
                    目标账号（已选 {draft.assigneeUserIds.length} 个）
                  </p>
                  <input
                    aria-label="搜索目标账号"
                    className="input w-full"
                    placeholder="搜索昵称、登录账号或账号 ID"
                    value={staffSearch}
                    onChange={event => setStaffSearch(event.target.value)}
                  />
                  <div className="max-h-56 overflow-auto rounded-lg border border-gray-200">
                    <table className="w-full min-w-[460px] text-sm text-left">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="p-3">选择</th>
                          <th className="p-3">用户账号</th>
                          <th className="p-3">接单情况</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleStaff.map(person => {
                          const selected = draft.assigneeUserIds.includes(person.id);
                          const available =
                            person.status === 'active' && person.hasExecutionPermissions;
                          return (
                            <tr key={person.id} className="border-t border-gray-100">
                              <td className="p-3">
                                <input
                                  type="checkbox"
                                  aria-label={`选择账号 ${person.username}`}
                                  className="w-4 h-4 accent-primary"
                                  checked={selected}
                                  disabled={!selected && !available}
                                  onChange={() =>
                                    setDraft({
                                      ...draft,
                                      assigneeUserIds: selected
                                        ? draft.assigneeUserIds.filter(id => id !== person.id)
                                        : [...draft.assigneeUserIds, person.id],
                                    })
                                  }
                                />
                              </td>
                              <td className="p-3">
                                {accountLabel(person)}
                                <p className="text-xs text-gray-500">
                                  U{String(person.id).padStart(4, '0')}
                                </p>
                              </td>
                              <td className="p-3 text-gray-600">
                                {!available
                                  ? '账号停用或权限不完整'
                                  : !person.autoAssignEnabled
                                    ? '未开启自动接单'
                                    : person.remainingCapacity <= 0
                                      ? '容量不足'
                                      : `剩余容量 ${person.remainingCapacity}`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!visibleStaff.length && (
                      <p className="p-5 text-center text-gray-500">暂无匹配账号</p>
                    )}
                  </div>
                  {selectedMissing.map(id => (
                    <p key={id} className="text-sm text-amber-700">
                      账号 U{String(id).padStart(4, '0')} 已不可用，仍保留在规则内。
                      <button
                        type="button"
                        className="ml-2 underline"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            assigneeUserIds: draft.assigneeUserIds.filter(value => value !== id),
                          })
                        }
                      >
                        移除
                      </button>
                    </p>
                  ))}
                  <p className="text-xs text-gray-500">
                    暂未接单或容量不足的账号可以预先配置；恢复接单后自动参与。规则不会绕过权限和容量限制。
                  </p>
                </div>
                <p className="text-sm text-amber-700">
                  停用规则后，尚未分配的订单会重新按其他启用规则或默认方式分配。
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={`btn btn-secondary ${BUTTON_CLASS}`}
                    onClick={() => {
                      setDraft(null);
                      setError('');
                    }}
                  >
                    取消编辑
                  </button>
                  <button type="submit" className={`btn btn-primary ${BUTTON_CLASS}`}>
                    <Save className="w-4 h-4" />
                    {busy ? '保存中...' : '保存规则'}
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-gray-500">
                  共 {rules.length} 条规则 · 未命中的订单沿用默认负载分配
                </p>
                <button
                  type="button"
                  className={`btn btn-primary ${BUTTON_CLASS}`}
                  disabled={busy}
                  onClick={() => edit(null)}
                >
                  <Plus className="w-4 h-4" />
                  新增规则
                </button>
              </div>
              {deleting && (
                <div
                  role="alert"
                  className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800 space-y-3"
                >
                  <p>
                    删除「{deleting.name}
                    」后，未分配订单会重新按其他启用规则或默认方式分配。已分配任务保持原负责人。
                  </p>
                  <div className="flex gap-2">
                    <button
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setDeleting(null)}
                    >
                      取消删除
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        runMutation(
                          () => deletePaymentTagRule(deleting.id, deleting.version),
                          '规则已删除'
                        )
                      }
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full min-w-[650px] text-left text-sm">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      {['规则', '完整 TAG', '指定账号', '状态', '操作'].map(label => (
                        <th key={label} className="px-3 py-3 font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map(rule => (
                      <tr key={rule.id} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-3 max-w-40 break-words font-medium">{rule.name}</td>
                        <td className="px-3 py-3 max-w-56 break-all">
                          {rule.recipientTags.map(tag => (
                            <div key={tag}>{tag}</div>
                          ))}
                        </td>
                        <td className="px-3 py-3 max-w-56 break-words">
                          {rule.assigneeUserIds.map(id => (
                            <div key={id}>
                              {accountLabel(staff.find(person => person.id === id)) ||
                                `账号 U${String(id).padStart(4, '0')}（不可用）`}
                            </div>
                          ))}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`badge ${rule.enabled ? 'badge-success' : 'bg-gray-100 text-gray-600'}`}
                          >
                            {rule.enabled ? '启用' : '停用'}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex gap-2">
                            <button
                              className="text-primary hover:underline"
                              disabled={busy}
                              onClick={() => edit(rule)}
                            >
                              编辑
                            </button>
                            <button
                              className="text-gray-600 hover:underline"
                              disabled={busy}
                              onClick={() => {
                                setDeleting(rule);
                                setError('');
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rules.length && (
                  <p className="py-12 text-center text-gray-500">
                    暂无 TAG 分配规则，当前沿用默认分配方式
                  </p>
                )}
              </div>
              <p className="text-xs text-gray-500">
                每 10
                秒自动调度，也可关闭此窗口后点击「立即扫描」。仅影响新任务及已有未分配任务；已分配负责人保持，管理员可手动转派。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
