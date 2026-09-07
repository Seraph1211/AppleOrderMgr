import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle,
  Eye,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";

import {
  batchReparseEmailRecords,
  getEmailProcessingMetrics,
  getEmailProcessingRecord,
  getEmailProcessingRecords,
  ingestEmailRecord,
  reparseEmailRecord,
  resolveEmailRecord,
  saveEmailDraft,
} from "../api";

const STATUS_OPTIONS = [
  ["manual_review", "待人工处理"],
  ["retry_wait", "待重试"],
  ["received", "已接收"],
  ["parsing", "解析中"],
  ["processing", "入库中"],
  ["succeeded", "已入库"],
  ["superseded", "重复/已有订单"],
  ["ignored", "已忽略"],
];

const ORDER_STATUS_OPTIONS = [
  "pending",
  "processing",
  "shipped",
  "ready_for_pickup",
  "completed",
  "delivered",
  "cancelled",
  "pickup_cancelled",
  "unknown",
];

const BADGE_CLASSES = {
  manual_review: "badge-error",
  retry_wait: "badge-warning",
  received: "badge-info",
  parsing: "badge-info",
  processing: "badge-info",
  succeeded: "badge-success",
  superseded: "badge-warning",
  ignored: "badge-gray",
};

function statusLabel(status) {
  return STATUS_OPTIONS.find(([value]) => value === status)?.[1] || status;
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function emptyDraft() {
  return {
    appleId: "",
    applePassword: "",
    orderNumber: "",
    orderUrl: "",
    orderDate: "",
    orderStatus: "pending",
    paymentMethod: "",
    products: [{ model: "", name: "", quantity: 1, image: null }],
    recipient: {
      name: "",
      idLast4: "",
      idCard: "",
      email: "",
      phone: "",
      address: "",
      tag: "",
    },
  };
}

function normalizeDraft(data) {
  const base = emptyDraft();
  if (!data) return base;
  return {
    ...base,
    ...data,
    applePassword: data.applePassword || "",
    orderDate: toDateTimeLocal(data.orderDate),
    orderStatus: data.orderStatus || "pending",
    products:
      Array.isArray(data.products) && data.products.length > 0
        ? data.products.map((product) => ({ ...product }))
        : base.products,
    recipient: { ...base.recipient, ...(data.recipient || {}) },
  };
}

export default function EmailProcessing() {
  const [records, setRecords] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [filters, setFilters] = useState({
    status: "manual_review",
    error_code: "",
    order_number: "",
  });
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [lastOutcome, setLastOutcome] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [working, setWorking] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await getEmailProcessingRecords({
        ...filters,
        page,
        limit: 20,
      });
      setRecords(response.data.items || []);
      setTotal(response.data.total || 0);
      setSelectedIds([]);
    } catch (requestError) {
      setError(requestError.message || "加载邮件处理记录失败");
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  const loadMetrics = useCallback(async () => {
    try {
      const response = await getEmailProcessingMetrics();
      setMetrics(response.data);
    } catch (_error) {
      setMetrics(null);
    }
  }, []);

  useEffect(() => {
    loadRecords();
    loadMetrics();
  }, [loadRecords, loadMetrics]);

  const openRecord = async (id) => {
    setWorking(true);
    setError("");
    try {
      const response = await getEmailProcessingRecord(id);
      setDetail(response.data);
      setDraft(
        normalizeDraft(response.data.manual_draft || response.data.parsed_data),
      );
    } catch (requestError) {
      setError(requestError.message || "加载邮件详情失败");
    } finally {
      setWorking(false);
    }
  };

  const handleReparse = async (id) => {
    setWorking(true);
    setError("");
    try {
      await reparseEmailRecord(id);
      await openRecord(id);
      setMessage("已使用当前解析器生成新预览，请核对后入库。");
      await loadRecords();
    } catch (requestError) {
      setError(requestError.message || "重新解析失败");
      await openRecord(id);
    } finally {
      setWorking(false);
    }
  };

  const updateDraft = (field, value) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };

  const updateRecipient = (field, value) => {
    setDraft((previous) => ({
      ...previous,
      recipient: { ...previous.recipient, [field]: value },
    }));
  };

  const updateProduct = (index, field, value) => {
    setDraft((previous) => ({
      ...previous,
      products: previous.products.map((product, productIndex) =>
        productIndex === index
          ? {
              ...product,
              [field]: field === "quantity" ? Number(value) : value,
            }
          : product,
      ),
    }));
  };

  const addProduct = () => {
    setDraft((previous) => ({
      ...previous,
      products: [
        ...previous.products,
        { model: "", name: "", quantity: 1, image: null },
      ],
    }));
  };

  const removeProduct = (index) => {
    setDraft((previous) => ({
      ...previous,
      products: previous.products.filter(
        (_product, productIndex) => productIndex !== index,
      ),
    }));
  };

  const handleSaveDraft = async () => {
    setWorking(true);
    setError("");
    try {
      const response = await saveEmailDraft(detail.id, draft, detail.version);
      setDetail((previous) => ({
        ...previous,
        version: response.data.version,
        manual_draft: draft,
      }));
      setMessage("人工修正草稿已加密保存。");
    } catch (requestError) {
      setError(requestError.message || "保存草稿失败");
    } finally {
      setWorking(false);
    }
  };

  const handleIngest = async () => {
    if (!window.confirm("确认按当前预览创建订单？相同订单号不会覆盖已有订单。"))
      return;
    setWorking(true);
    setError("");
    try {
      const response = await ingestEmailRecord(
        detail.id,
        draft,
        detail.version,
      );
      setMessage(`处理完成，订单 ${response.data.order.order_number} 已关联。`);
      setLastOutcome(response.data.order);
      setDetail(null);
      await Promise.all([loadRecords(), loadMetrics()]);
    } catch (requestError) {
      setError(requestError.message || "确认入库失败");
    } finally {
      setWorking(false);
    }
  };

  const handleResolve = async (resolutionType) => {
    const reason = window.prompt(
      resolutionType === "ignored"
        ? "请输入忽略原因："
        : "请输入关联已有订单的原因：",
    );
    if (!reason) return;
    let orderNumber;
    if (resolutionType === "existing_order") {
      orderNumber = window.prompt(
        "请输入已有订单号：",
        draft.orderNumber || "",
      );
      if (!orderNumber) return;
    }
    setWorking(true);
    try {
      await resolveEmailRecord(detail.id, {
        resolutionType,
        reason,
        orderNumber,
        version: detail.version,
      });
      setDetail(null);
      setMessage(
        resolutionType === "ignored"
          ? "邮件已标记忽略。"
          : "邮件已关联已有订单。",
      );
      await Promise.all([loadRecords(), loadMetrics()]);
    } catch (requestError) {
      setError(requestError.message || "人工关闭失败");
    } finally {
      setWorking(false);
    }
  };

  const handleBatchReparse = async () => {
    if (selectedIds.length === 0) return;
    setWorking(true);
    try {
      const response = await batchReparseEmailRecords(selectedIds);
      const succeeded = response.data.results.filter(
        (result) => result.success,
      ).length;
      setMessage(
        `批量重新解析完成：${succeeded}/${response.data.results.length} 成功。`,
      );
      await Promise.all([loadRecords(), loadMetrics()]);
    } catch (requestError) {
      setError(requestError.message || "批量重新解析失败");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">邮件处理</h1>
          <p className="mt-1 text-gray-500">
            检查失败邮件，快速重新解析、修正并确认入库
          </p>
        </div>
        <button
          className="btn btn-primary flex items-center space-x-2"
          disabled={working || selectedIds.length === 0}
          onClick={handleBatchReparse}
        >
          <RefreshCw className={`h-4 w-4 ${working ? "animate-spin" : ""}`} />
          <span>批量重新解析（{selectedIds.length}）</span>
        </button>
      </div>

      {metrics && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 text-sm text-gray-600">
          Worker{" "}
          {metrics.worker?.isRunning
            ? metrics.worker.isConnected
              ? "已连接"
              : "连接中断"
            : "未运行"}
          ；待人工处理 {metrics.counts?.manual_review || 0}，待重试{" "}
          {metrics.counts?.retry_wait || 0}，已入库{" "}
          {metrics.counts?.succeeded || 0}，最近 24 小时失败{" "}
          {metrics.recentFailureCount || 0}，连续失败{" "}
          {metrics.worker?.consecutiveFailures || 0}
        </div>
      )}

      {message && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-700">
          <CheckCircle className="h-4 w-4" />
          <span className="flex-1">{message}</span>
          {lastOutcome && (
            <Link
              className="font-medium text-primary hover:text-primary-700"
              to={`/orders/${lastOutcome.id}`}
            >
              查看订单
            </Link>
          )}
          {records[0] && (
            <button
              className="font-medium text-primary hover:text-primary-700"
              onClick={() => openRecord(records[0].id)}
            >
              处理下一封
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">
          <AlertCircle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 md:flex-row">
        <select
          className="input"
          value={filters.status}
          onChange={(event) => {
            setFilters((previous) => ({
              ...previous,
              status: event.target.value,
            }));
            setPage(1);
          }}
        >
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="错误码"
          value={filters.error_code}
          onChange={(event) =>
            setFilters((previous) => ({
              ...previous,
              error_code: event.target.value,
            }))
          }
        />
        <input
          className="input"
          placeholder="订单号"
          value={filters.order_number}
          onChange={(event) =>
            setFilters((previous) => ({
              ...previous,
              order_number: event.target.value,
            }))
          }
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                选择
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                接收时间
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                邮件
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                订单 / 错误
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                推荐动作
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                状态
              </th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  className="px-4 py-12 text-center text-gray-500"
                  colSpan="7"
                >
                  加载中...
                </td>
              </tr>
            ) : records.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-12 text-center text-gray-500"
                  colSpan="7"
                >
                  暂无邮件处理记录
                </td>
              </tr>
            ) : (
              records.map((record) => (
                <tr
                  key={record.id}
                  className="border-b border-gray-200 hover:bg-gray-50"
                >
                  <td className="px-4 py-4">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(record.id)}
                      disabled={
                        !["manual_review", "retry_wait"].includes(record.status)
                      }
                      onChange={(event) =>
                        setSelectedIds((previous) =>
                          event.target.checked
                            ? [...previous, record.id]
                            : previous.filter((id) => id !== record.id),
                        )
                      }
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-sm text-gray-600">
                    {record.received_at
                      ? new Date(record.received_at).toLocaleString()
                      : "-"}
                  </td>
                  <td className="max-w-sm px-4 py-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50">
                        <Mail className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">
                          {record.email_subject || "无主题"}
                        </p>
                        <p className="truncate text-sm text-gray-500">
                          {record.email_from || "未知发件人"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm">
                    <p className="font-mono text-primary">
                      {record.order_number || "-"}
                    </p>
                    <p className="mt-1 text-red-600">
                      {record.error_code || record.error_message || "-"}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      尝试 {record.retry_count} 次
                    </p>
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-600">
                    {{
                      retry_wait: "等待自动重试",
                      review_and_ingest: "核对并入库",
                      reparse: "重新解析",
                      view_order: "查看订单",
                      none: "-",
                    }[record.recommended_action] || "-"}
                  </td>
                  <td className="px-4 py-4">
                    <span
                      className={`badge ${BADGE_CLASSES[record.status] || "badge-info"}`}
                    >
                      {statusLabel(record.status)}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      {["manual_review", "retry_wait"].includes(
                        record.status,
                      ) && (
                        <button
                          className="btn btn-secondary"
                          disabled={working}
                          onClick={() => handleReparse(record.id)}
                        >
                          <RefreshCw className="h-4 w-4" />
                          <span>重新解析</span>
                        </button>
                      )}
                      <button
                        className="btn btn-secondary"
                        disabled={working}
                        onClick={() => openRecord(record.id)}
                      >
                        <Eye className="h-4 w-4" />
                        <span>详情</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>共 {total} 条</span>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            上一页
          </button>
          <span className="px-3 py-2">第 {page} 页</span>
          <button
            className="btn btn-secondary"
            disabled={page * 20 >= total}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </button>
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
          <div className="h-full w-full max-w-4xl overflow-y-auto bg-gray-50 shadow-xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">
                  邮件处理详情 #{detail.id}
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  版本 {detail.version} · {statusLabel(detail.status)}
                </p>
              </div>
              <button
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                onClick={() => setDetail(null)}
                aria-label="关闭"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-6 p-6">
              <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="font-semibold text-gray-900">邮件与错误</h3>
                <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                  <div>
                    <dt className="text-gray-500">From</dt>
                    <dd className="break-all text-gray-900">
                      {detail.email_from || "-"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Subject</dt>
                    <dd className="text-gray-900">
                      {detail.email_subject || "-"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Message-ID</dt>
                    <dd className="break-all text-gray-900">
                      {detail.message_id || "-"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Authentication-Results</dt>
                    <dd className="break-all text-gray-900">
                      {detail.authentication_results || "-"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">错误码</dt>
                    <dd className="text-red-600">{detail.error_code || "-"}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">错误说明</dt>
                    <dd className="text-red-600">
                      {detail.error_message || "-"}
                    </dd>
                  </div>
                </dl>
              </section>

              {detail.duplicate_order && (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
                  相同订单号已经存在。确认入库时只会关联该订单，不会覆盖订单字段。{" "}
                  <Link
                    className="font-medium text-primary"
                    to={`/orders/${detail.duplicate_order.id}`}
                  >
                    查看已有订单
                  </Link>
                </div>
              )}

              <section className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="grid gap-4 md:grid-cols-2">
                  {[
                    ["Apple ID", "appleId", "text", "email"],
                    ["Apple 密码", "applePassword", "text"],
                    ["订单号", "orderNumber", "text"],
                    ["订单链接", "orderUrl", "url"],
                    ["订单时间", "orderDate", "datetime-local"],
                    ["付款方式", "paymentMethod", "text"],
                  ].map(([label, field, type, inputMode]) => (
                    <label
                      key={field}
                      className={field === "orderUrl" ? "md:col-span-2" : ""}
                    >
                      <span className="mb-2 block text-sm font-medium text-gray-700">
                        {label}
                      </span>
                      <input
                        className="input w-full"
                        type={type}
                        inputMode={inputMode}
                        autoComplete={field === "appleId" ? "off" : undefined}
                        value={draft[field] || ""}
                        onChange={(event) =>
                          updateDraft(field, event.target.value)
                        }
                      />
                    </label>
                  ))}
                  <label>
                    <span className="mb-2 block text-sm font-medium text-gray-700">
                      系统内部状态
                    </span>
                    <select
                      className="input w-full"
                      value={draft.orderStatus}
                      onChange={(event) =>
                        updateDraft("orderStatus", event.target.value)
                      }
                    >
                      {ORDER_STATUS_OPTIONS.map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="font-semibold text-gray-900">取机人与标签</h3>
                <p className="mt-1 text-sm text-gray-500">
                  标签必须来自订单信息行最后一个字段。
                </p>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {[
                    ["姓名", "name"],
                    ["身份证后四位", "idLast4"],
                    ["完整身份证号", "idCard"],
                    ["邮箱", "email"],
                    ["手机号", "phone"],
                    ["完整地址", "address"],
                    ["标签", "tag"],
                  ].map(([label, field]) => (
                    <label
                      key={field}
                      className={field === "address" ? "md:col-span-2" : ""}
                    >
                      <span className="mb-2 block text-sm font-medium text-gray-700">
                        {label}
                      </span>
                      <input
                        className="input w-full"
                        value={draft.recipient[field] || ""}
                        onChange={(event) =>
                          updateRecipient(field, event.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-900">商品</h3>
                  <button className="btn btn-secondary" onClick={addProduct}>
                    <Plus className="h-4 w-4" />
                    <span>增加商品</span>
                  </button>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50">
                        <th className="px-3 py-2 text-left text-sm text-gray-500">
                          型号
                        </th>
                        <th className="px-3 py-2 text-left text-sm text-gray-500">
                          名称
                        </th>
                        <th className="px-3 py-2 text-left text-sm text-gray-500">
                          数量
                        </th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {draft.products.map((product, index) => (
                        <tr
                          key={`${index}-${product.model}`}
                          className="border-b border-gray-200"
                        >
                          <td className="px-3 py-2">
                            <input
                              className="input"
                              value={product.model}
                              onChange={(event) =>
                                updateProduct(
                                  index,
                                  "model",
                                  event.target.value,
                                )
                              }
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              className="input min-w-64"
                              value={product.name}
                              onChange={(event) =>
                                updateProduct(index, "name", event.target.value)
                              }
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              className="input w-24"
                              type="number"
                              min="1"
                              max="999"
                              value={product.quantity}
                              onChange={(event) =>
                                updateProduct(
                                  index,
                                  "quantity",
                                  event.target.value,
                                )
                              }
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              className="rounded-lg p-2 text-red-600 hover:bg-red-50"
                              disabled={draft.products.length === 1}
                              onClick={() => removeProduct(index)}
                              aria-label="删除商品"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-xl border border-gray-200 bg-white p-5">
                <h3 className="font-semibold text-gray-900">
                  原始 MIME（管理员完整视图）
                </h3>
                <pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-100 p-4 text-xs text-gray-700">
                  {detail.raw_mime || "原始 MIME 已清理或未保存"}
                </pre>
              </section>

              <div className="flex flex-wrap justify-end gap-3">
                <button
                  className="btn btn-secondary"
                  disabled={working}
                  onClick={() => handleResolve("ignored")}
                >
                  标记忽略
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={working}
                  onClick={() => handleResolve("existing_order")}
                >
                  标记已有订单
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={working}
                  onClick={handleSaveDraft}
                >
                  <Save className="h-4 w-4" />
                  <span>保存草稿</span>
                </button>
                <button
                  className="btn btn-primary"
                  disabled={working}
                  onClick={handleIngest}
                >
                  <CheckCircle className="h-4 w-4" />
                  <span>确认入库</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
