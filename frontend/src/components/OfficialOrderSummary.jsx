import {
  ORDER_STATUS_LABELS,
  PICKUP_STATUS_LABELS,
  formatOrderConflict,
} from '../constants/orderStatus';

/** 展示最新官网观测，不将观测时间写作实际支付或取货时间。 */
export default function OfficialOrderSummary({ order }) {
  const issues = order.validationIssues || order.validation_issues || [];
  const rawStatus = order.officialRawStatus ?? order.official_raw_status;
  const observedAt = order.officialStatusObservedAt ?? order.official_status_observed_at;
  const expiresAt = order.officialPaymentExpiresAt ?? order.official_payment_expires_at;
  const products = order.officialProducts || order.official_products || [];
  const pickupStatus = order.pickupStatus ?? order.pickup_status;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <h3 className="font-semibold text-gray-900">官网状态与来源核对</h3>
      <p className="text-sm text-gray-600">已付款订单仅手动刷新。观测时间表示系统读取时间。</p>
      <dl className="text-sm space-y-2">
        <div>
          <dt className="inline text-gray-500">原始状态：</dt>
          <dd className="inline break-all">{rawStatus || '待核对（见商品阶段）'}</dd>
        </div>
        <div>
          <dt className="inline text-gray-500">取货状态：</dt>
          <dd className="inline">{PICKUP_STATUS_LABELS[pickupStatus] || '-'}</dd>
        </div>
        <div>
          <dt className="inline text-gray-500">最近观测：</dt>
          <dd className="inline">
            {observedAt ? new Date(observedAt).toLocaleString('zh-CN') : '-'}
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-500">官网付款截止：</dt>
          <dd className="inline">
            {expiresAt ? new Date(expiresAt).toLocaleString('zh-CN') : '未提供准确截止时间'}
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-500">履约提示：</dt>
          <dd className="inline">
            {order.officialFulfillmentMessage || order.official_fulfillment_message || '-'}
          </dd>
        </div>
      </dl>
      {products.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="p-2">商品</th>
                <th className="p-2">数量</th>
                <th className="p-2">官网阶段</th>
                <th className="p-2">履约提示</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product, index) => (
                <tr key={index} className="border-t border-gray-200">
                  <td className="p-2">{product.name}</td>
                  <td className="p-2">{product.quantity ?? '-'}</td>
                  <td className="p-2">
                    {ORDER_STATUS_LABELS[product.status] || product.status || '-'}
                    {product.statusDescription && (
                      <p className="text-xs text-gray-500">{product.statusDescription}</p>
                    )}
                  </td>
                  <td className="p-2">{product.fulfillmentMessage || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {issues.length > 0 && (
        <ul className="text-sm text-amber-700 space-y-2">
          {issues.map((issue, index) => (
            <li key={index}>{formatOrderConflict(issue)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
