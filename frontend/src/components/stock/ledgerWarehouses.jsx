import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { StockFeedback, StockFields, StockModal, StockTable } from './StockCommon';
import { useStockCommand } from './stockHooks';
import LedgerPeopleSettings from './ledgerPeopleSettings';
import { LedgerActions } from './ledgerFields';

/** 仓库只需名称，不暴露代卖点和复杂基础资料。 */
export default function LedgerWarehouses({ catalog, onClose, onSaved }) {
  const { can } = useAuth();
  const command = useStockCommand();
  const [editing, setEditing] = useState(null);
  const [tab, setTab] = useState('warehouses');
  const [name, setName] = useState('');
  const submit = async event => {
    event.preventDefault();
    try {
      const result = await command.execute(
        editing ? 'PATCH' : 'POST',
        editing ? `/locations/${editing.id}` : '/locations',
        {
          name: name.trim(),
          kind: 'warehouse',
          isActive: true,
          ...(editing ? { expectedVersion: editing.version } : {}),
        }
      );
      if (result) {
        setEditing(null);
        setName('');
        onSaved(result);
      }
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  const changeEnabled = async () => {
    try {
      const result = await command.execute('PATCH', '/settings', {
        expectedVersion: catalog.settingsVersion,
        enabled: !catalog.enabled,
      });
      if (result) onSaved(result);
    } catch (failure) {
      command.setError(failure.message);
    }
  };
  return (
    <StockModal title="基础设置" onClose={onClose} busy={command.busy}>
      <div className="space-y-4">
        {can('stock.settings.manage') && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 p-3">
            <div>
              <p className="font-medium">库存管理：{catalog.enabled ? '已启用' : '未启用'}</p>
              <p className="mt-1 text-xs text-gray-500">关闭后保留查询，暂停业务录入。</p>
            </div>
            <button
              type="button"
              className={`btn ${catalog.enabled ? 'btn-secondary' : 'btn-primary'}`}
              disabled={command.busy || catalog.settingsVersion === undefined}
              onClick={changeEnabled}
            >
              {catalog.enabled ? '暂停录入' : '启用库存管理'}
            </button>
          </section>
        )}
        {can('stock.catalog.manage') && (
          <div role="tablist" aria-label="基础设置分类" className="flex flex-wrap gap-2">
            {[
              ['warehouses', '仓库'],
              ['salesperson', '销售人'],
              ['handler', '出货人'],
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                disabled={command.busy}
                className={`btn ${tab === key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {can('stock.catalog.manage') && tab !== 'warehouses' && (
          <LedgerPeopleSettings key={tab} catalog={catalog} role={tab} onSaved={onSaved} />
        )}
        {can('stock.catalog.manage') && tab === 'warehouses' && (
          <>
            <StockTable
              items={catalog.warehouses}
              columns={[
                { key: 'name', title: '仓库名称' },
                {
                  key: 'action',
                  title: '操作',
                  render: item => (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={command.busy}
                      onClick={() => {
                        setEditing(item);
                        setName(item.name);
                      }}
                    >
                      改名
                    </button>
                  ),
                },
              ]}
            />
            <form onSubmit={submit} className="space-y-3">
              <StockFields
                value={{ name }}
                onChange={next => setName(next.name)}
                disabled={command.busy}
                fields={[
                  {
                    key: 'name',
                    label: editing ? '修改仓库名称' : '新增仓库名称',
                    required: true,
                    maxLength: 100,
                  },
                ]}
              />
              {editing && (
                <button
                  type="button"
                  className="text-sm text-primary underline"
                  onClick={() => {
                    setEditing(null);
                    setName('');
                  }}
                >
                  取消改名，新增仓库
                </button>
              )}
              <StockFeedback error={command.error} />
              <LedgerActions
                busy={command.busy}
                onClose={onClose}
                submitLabel={editing ? '保存名称' : '添加仓库'}
              />
            </form>
          </>
        )}
        {!can('stock.catalog.manage') && <StockFeedback error={command.error} />}
      </div>
    </StockModal>
  );
}
