import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import {
  getPermissionCatalog,
  getOrderTagOptions,
  getUserPermissions,
  replaceUserPermissions,
} from '../api/permissionsApi';
import { PAYMENT_EXECUTION_PERMISSIONS } from '../constants/permissions';

export default function PermissionConfigModal({ user, onClose, onSuccess }) {
  const [orderAccess, setOrderAccess] = useState({ mode: 'tags', tags: [] });
  const [initialAccess, setInitialAccess] = useState(null);
  const [tagOptions, setTagOptions] = useState([]);
  const [tagSearch, setTagSearch] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState([]);
  const [version, setVersion] = useState(0);
  const [editable, setEditable] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getPermissionCatalog(), getUserPermissions(user.id), getOrderTagOptions()])
      .then(([catalogResponse, permissionResponse, tagsResponse]) => {
        setOrderAccess(permissionResponse.data.orderAccess);
        setInitialAccess(permissionResponse.data.orderAccess);
        setTagOptions(tagsResponse.data.tags);
        setCatalog(catalogResponse.data.permissions);
        setSelected(permissionResponse.data.permissions);
        setVersion(permissionResponse.data.version);
        setEditable(permissionResponse.data.editable);
      })
      .catch(loadError => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [user.id]);

  const grouped = useMemo(
    () =>
      catalog.reduce((result, item) => {
        if (!result[item.module]) result[item.module] = { label: item.moduleLabel, items: [] };
        result[item.module].items.push(item);
        return result;
      }, {}),
    [catalog]
  );

  const togglePermission = (permission, checked) => {
    const next = new Set(selected);
    if (checked) {
      next.add(permission.code);
      permission.dependencies.forEach(code => next.add(code));
    } else {
      next.delete(permission.code);
      catalog
        .filter(item => item.dependencies.includes(permission.code))
        .forEach(item => next.delete(item.code));
    }
    setSelected([...next]);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await replaceUserPermissions(
        user.id,
        { permissions: selected, orderAccess, expectedVersion: version, reason },
        crypto.randomUUID()
      );
      onSuccess();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" />
              配置 {user.nickname || user.username}（{user.username}）的权限
            </h2>
            <p className="text-sm text-gray-500 mt-1">普通用户仅拥有此处明确勾选的权限</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-5">
          {error && <div className="rounded-lg bg-red-50 text-red-700 px-4 py-3">{error}</div>}
          {loading ? (
            <p className="text-center text-gray-500 py-12">加载中...</p>
          ) : (
            <>
              {!editable && (
                <div className="rounded-lg bg-blue-50 text-primary px-4 py-3">
                  管理员固定拥有全部权限，不接受逐项修改。
                </div>
              )}
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-secondary"
                    onClick={() => setSelected([...PAYMENT_EXECUTION_PERMISSIONS])}
                  >
                    仅保留本人付款任务权限
                  </button>
                  <button className="btn btn-secondary" onClick={() => setSelected([])}>
                    清空全部权限
                  </button>
                </div>
              )}
              <section className="border border-gray-200 rounded-lg p-4 space-y-3">
                <h3 className="font-semibold text-gray-900">订单数据范围</h3>
                <p className="text-sm text-gray-500">
                  按订单自身 TAG 精确匹配，限制订单查询及操作。本人付款任务的信息和操作保持不变。
                </p>
                <div className="flex flex-wrap gap-5">
                  {[
                    ['all', '全部订单'],
                    ['tags', '指定 TAG'],
                  ].map(([mode, label]) => (
                    <label key={mode} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="orderAccessMode"
                        value={mode}
                        checked={orderAccess.mode === mode}
                        disabled={!editable || saving}
                        onChange={() => setOrderAccess(current => ({ ...current, mode }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {orderAccess.mode === 'tags' && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {orderAccess.tags.map(tag => (
                        <button
                          key={tag}
                          type="button"
                          className="badge badge-info max-w-full break-all whitespace-pre-wrap"
                          disabled={!editable || saving}
                          title="点击移除授权 TAG"
                          onClick={() =>
                            setOrderAccess(current => ({
                              ...current,
                              tags: current.tags.filter(value => value !== tag),
                            }))
                          }
                        >
                          {tag} ×
                        </button>
                      ))}
                    </div>
                    <input
                      className="input"
                      placeholder="搜索订单 TAG"
                      aria-label="搜索订单 TAG"
                      value={tagSearch}
                      onChange={event => setTagSearch(event.target.value)}
                    />
                    <div className="max-h-40 overflow-y-auto divide-y divide-gray-100 border rounded-lg">
                      {[...new Set([...tagOptions, ...orderAccess.tags])]
                        .filter(tag => tag.toLowerCase().includes(tagSearch.toLowerCase()))
                        .map(tag => (
                          <label key={tag} className="flex items-center gap-3 px-3 py-2 text-sm">
                            <input
                              type="checkbox"
                              checked={orderAccess.tags.includes(tag)}
                              disabled={!editable || saving}
                              onChange={event =>
                                setOrderAccess(current => ({
                                  ...current,
                                  tags: event.target.checked
                                    ? [...current.tags, tag]
                                    : current.tags.filter(value => value !== tag),
                                }))
                              }
                            />
                            <span className="break-all whitespace-pre-wrap">{tag}</span>
                          </label>
                        ))}
                    </div>
                    {tagOptions.length === 0 && (
                      <p className="text-sm text-gray-500">暂无订单 TAG 候选</p>
                    )}
                    <p className="text-sm text-gray-600">
                      已选择 {orderAccess.tags.length} 个 TAG；不选择时无法查看任何订单，无 TAG
                      订单不可见。
                    </p>
                  </>
                )}
                {!selected.includes('orders.read') && editable && (
                  <p className="text-sm text-amber-700">
                    尚未授予订单读取权限，配置 TAG 不会自动开放订单管理。
                  </p>
                )}
                {editable && initialAccess && (
                  <p className="text-sm text-gray-600 break-all">
                    保存后范围：
                    {orderAccess.mode === 'all'
                      ? '全部订单'
                      : orderAccess.tags.length
                        ? orderAccess.tags.join('、')
                        : '无可访问订单'}
                    （原范围：
                    {initialAccess.mode === 'all'
                      ? '全部订单'
                      : initialAccess.tags.join('、') || '无可访问订单'}
                    ）
                  </p>
                )}
              </section>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.entries(grouped).map(([module, group]) => (
                  <section key={module} className="border border-gray-200 rounded-lg p-4">
                    <h3 className="font-semibold text-gray-900 mb-3">{group.label}</h3>
                    <div className="space-y-3">
                      {group.items.map(permission => (
                        <label key={permission.code} className="flex items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={selected.includes(permission.code)}
                            disabled={!editable || permission.adminReserved}
                            onChange={event => togglePermission(permission, event.target.checked)}
                          />
                          <span>
                            <span className="text-gray-800">{permission.label}</span>
                            <span className="block text-xs text-gray-400">{permission.code}</span>
                            {permission.adminReserved && (
                              <span className="text-xs text-red-500">管理员保留</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
              {editable && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">变更原因</label>
                  <input
                    className="input"
                    maxLength="500"
                    value={reason}
                    onChange={event => setReason(event.target.value)}
                    placeholder="可选，将记入权限审计"
                  />
                </div>
              )}
            </>
          )}
        </div>
        <div className="p-5 border-t border-gray-200 flex justify-end gap-3">
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          {editable && (
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || loading || (Boolean(error) && !initialAccess)}
            >
              {saving ? '保存中...' : '保存权限'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
