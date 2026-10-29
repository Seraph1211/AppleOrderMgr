import OrderOverlay from './orderOverlay';
import OfficialOrderRefreshPanel from './OfficialOrderRefreshPanel';

/** 官网更新进度弹窗；任务在服务端执行，关闭弹窗不取消任务。 */
export default function OfficialOrderRefreshModal({ onClose, ...props }) {
  return (
    <OrderOverlay
      title="官网更新进度"
      subtitle="查看批次执行情况与逐单结果"
      size="large"
      className="order-refresh-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="order-inline-note">关闭窗口后，已提交的任务继续执行</span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <OfficialOrderRefreshPanel {...props} />
    </OrderOverlay>
  );
}
