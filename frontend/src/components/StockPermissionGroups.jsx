import { getPermissionSelectionState } from '../utils/permissionSelection';

/** 按实际台账业务展示授权组合，保留特殊分工的细分授权入口。 */
export default function StockPermissionGroups({ groups, catalog, selected, disabled, onChange }) {
  const renderOptions = group => (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {group.options.map(option => {
        const state = getPermissionSelectionState(selected, option.codes);
        return (
          <label key={option.id} className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label={option.label}
              ref={node => {
                if (node) node.indeterminate = state === 'partial';
              }}
              checked={state === 'all'}
              disabled={disabled}
              onChange={event => onChange(option.codes, event.target.checked)}
            />
            <span>{option.label}</span>
            {state === 'partial' && <span className="text-xs text-amber-700">部分授权</span>}
          </label>
        );
      })}
    </div>
  );
  return (
    <section
      className="border border-gray-200 rounded-lg overflow-hidden"
      aria-label="自有库存业务权限"
    >
      <div className="p-4 bg-primary-50">
        <h3 className="font-semibold text-gray-900">自有库存与销售</h3>
        <p className="text-sm text-gray-600 mt-1">
          按业务授权，必要查看权限自动勾选。原有部分授权保持不变。
        </p>
      </div>
      <div className="divide-y divide-gray-100">
        {groups
          .filter(group => group.id !== 'advanced')
          .map(group => (
            <div key={group.id} className="px-4 py-3 md:grid md:grid-cols-[10rem_1fr] md:gap-4">
              <h4 className="font-medium text-sm text-gray-900 pt-2">{group.label}</h4>
              <div className="min-w-0">
                {renderOptions(group)}
                <p className="text-xs text-gray-500 leading-relaxed">{group.description}</p>
              </div>
            </div>
          ))}
        <details className="px-4 py-3">
          <summary className="cursor-pointer min-h-10 flex items-center text-sm font-medium text-primary">
            高级管理与细分配置
          </summary>
          {groups
            .filter(group => group.id === 'advanced')
            .map(group => (
              <div key={group.id} className="mb-3">
                {renderOptions(group)}
                <p className="text-xs text-gray-500">{group.description}</p>
              </div>
            ))}
          <details className="border-t border-gray-100 pt-3">
            <summary className="cursor-pointer text-sm text-gray-600 min-h-10">
              特殊分工：展开细分权限
            </summary>
            <p className="text-xs text-gray-500 mb-3">
              用于仅看成本、只登记客户付款等分工；不会自动补齐整个业务组。
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {catalog
                .filter(item => item.module === 'stock')
                .map(item => (
                  <label key={item.code} className="flex items-center gap-2 text-sm min-h-10">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.code)}
                      disabled={disabled || item.adminReserved}
                      onChange={event => onChange([item.code], event.target.checked)}
                    />
                    <span>
                      {item.label}
                      {item.adminReserved && (
                        <span className="text-xs text-gray-500">（管理员保留）</span>
                      )}
                    </span>
                  </label>
                ))}
            </div>
          </details>
        </details>
      </div>
    </section>
  );
}
