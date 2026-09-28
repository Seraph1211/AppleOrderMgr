import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Copy,
  RefreshCw,
  Search,
  X,
  Users,
  FileText,
  Loader2,
  AlertCircle,
} from "lucide-react";
import client from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { PERMISSIONS } from "../constants/permissions";

const STATUS = {
  pending: ["待处理", "badge-warning"],
  rushing: ["抢购中", "badge-info"],
  succeeded: ["抢购成功", "badge-success"],
  cancelled: ["已取消", "badge-error"],
};
const EMPTY = {
  lastName: "",
  firstName: "",
  phone: "",
  idLast4: "",
  email: "",
  productModel: "",
  color: "",
  storage: "",
  quantity: 1,
  storeCodes: [],
  storeMode: "selected",
  storeCity: "",
  billing: {},
  paymentMethod: "",
  notes: "",
  platformOrderNumber: "",
  rawText: "",
};
const CUSTOMER_TEMPLATE =
  "平台订单号：\n姓名：\n手机号：\n身份证后四位：\n邮箱：\n机型：\n颜色：\n容量：\n数量：1\n取机城市：\n苹果直营店：\n支付方式：\n备注：";
const DATE = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const ACTIONS = {
  create: "登记委托",
  edit: "修改资料",
  status: "调整状态",
  assign: "分配账号",
  accounts: "追加账号",
  release: "确认停抢并释放",
  copy: "复制模板",
  link: "人工关联/纠错",
  auto_link: "自动匹配成功",
};

function Dialog({ title, children, close, busy }) {
  const dialogRef = useRef(null);
  const callbacks = useRef({ close, busy });
  callbacks.current = { close, busy };
  useEffect(() => {
    const previous = document.activeElement;
    const key = (event) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialogRef.current) return;
      if (event.key === "Escape" && !callbacks.current.busy)
        callbacks.current.close();
      if (event.key === "Tab") {
        const controls = Array.from(
          dialogRef.current.querySelectorAll(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
          ),
        ).filter((node) => node.getClientRects().length);
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    dialogRef.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus?.();
    };
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-2 sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[94dvh] flex flex-col"
      >
        <header className="flex items-center justify-between p-4 border-b">
          <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
          <button
            className="btn btn-secondary"
            aria-label="关闭"
            disabled={busy}
            onClick={close}
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="p-4 overflow-y-auto min-h-0">{children}</div>
      </section>
    </div>
  );
}
function Field({ label, value, onChange, type = "text", disabled = false }) {
  return (
    <label className="block text-sm text-gray-600">
      {label}
      <input
        className="input w-full mt-1"
        type={type}
        value={value ?? ""}
        onChange={(event) =>
          onChange(
            type === "number" ? Number(event.target.value) : event.target.value,
          )
        }
        disabled={disabled}
      />
    </label>
  );
}
function Badge({ status }) {
  const item = STATUS[status] || [status, "badge-info"];
  return (
    <span className={`badge whitespace-nowrap ${item[1]}`}>{item[0]}</span>
  );
}

/** 独立代抢委托、软件模板及专用账号池。 */
export default function ProxyOrders() {
  const { can } = useAuth();
  const [tab, setTab] = useState("orders");
  const [scope, setScope] = useState("pool");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], count: 0 });
  const [stores, setStores] = useState([]);
  const [selected, setSelected] = useState([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(null);
  const [draft, setDraft] = useState(null);
  const [text, setText] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [current, setCurrent] = useState(null);
  const [available, setAvailable] = useState([]);
  const [manualAccount, setManualAccount] = useState("");
  const [count, setCount] = useState(1);
  const [orderNumber, setOrderNumber] = useState("");
  const [reason, setReason] = useState("");
  const [copyFallback, setCopyFallback] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [modalError, setModalError] = useState("");
  const ended = ["succeeded", "cancelled"].includes(draft?.status);
  const cities = [...new Set(stores.map((s) => s.city))];
  const refresh = () => {
    setSelected([]);
    setRevision((value) => value + 1);
  };
  const close = () => {
    setModal(null);
    setModalError("");
    setCopyFallback("");
    setText("");
    setDraft(null);
    setCurrent(null);
  };
  useEffect(() => {
    let active = true;
    client
      .get("/proxy-orders/stores")
      .then((response) => {
        if (active) setStores(response.data);
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await client.get(
          tab === "orders" ? "/proxy-orders" : "/proxy-orders/accounts",
          {
            params: {
              keyword,
              status: tab === "orders" ? status : undefined,
              page,
              limit: 30,
              scope,
            },
          },
        );
        if (active) {
          setData(response.data);
          setError("");
          setSelected([]);
        }
      } catch (failure) {
        if (active) setError(failure.message);
      } finally {
        if (active) setLoading(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [tab, scope, keyword, status, page, revision]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!modal && !busy) setRevision((value) => value + 1);
    }, 20000);
    return () => clearInterval(timer);
  }, [modal, busy]);

  async function run(work, success) {
    if (busy) return;
    setBusy(true);
    setModalError("");
    setError("");
    setNotice("");
    try {
      await work();
      if (success) setNotice(success);
    } catch (failure) {
      if (modal) setModalError(failure.message);
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function clipboard(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setCopyFallback(value);
    }
  }
  async function copyOrders(orderIds) {
    await run(async () => {
      const response = await client.post("/proxy-orders/copy", {
        ids: orderIds,
      });
      await clipboard(response.data.text);
    }, "模板已生成，请在抢购软件中核对支付、商品和门店设置");
  }
  async function loadDetail(row) {
    await run(async () => {
      const response = await client.get(`/proxy-orders/${row.id}`);
      setCurrent(response.data);
      setDraft(response.data);
      setModal("detail");
    });
  }
  async function parse() {
    await run(async () => {
      const response = await client.post("/proxy-orders/parse", { text });
      const next = { ...EMPTY, ...response.data.draft };
      if (next.storeCodes.length) {
        const generated = await client.post("/proxy-orders/address", {
          storeCode: next.storeCodes[0],
        });
        next.billing = generated.data;
      }
      setDraft(next);
      setWarnings(response.data.warnings);
    });
  }
  const setField = (key, value) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  async function changeStoreScope(updates) {
    await run(async () => {
      const next = { ...draft, ...updates };
      if (next.storeMode === "city_any")
        next.storeCodes = stores
          .filter((store) => store.city === next.storeCity)
          .map((store) => store.code);
      if (!next.storeCodes.includes(next.billing?.referenceStoreCode)) {
        next.billing = next.storeCodes.length
          ? (
              await client.post("/proxy-orders/address", {
                storeCode: next.storeCodes[0],
              })
            ).data
          : {};
      }
      setDraft(next);
    });
  }
  async function address(code) {
    await run(async () => {
      const response = await client.post("/proxy-orders/address", {
        storeCode: code,
      });
      setField("billing", response.data);
    });
  }
  async function save() {
    await run(async () => {
      const payload = ended
        ? { notes: draft.notes, expectedVersion: draft.version }
        : { ...draft, expectedVersion: draft.version };
      const response = draft.id
        ? await client.put(`/proxy-orders/${draft.id}`, payload)
        : await client.post("/proxy-orders", payload);
      setNotice(
        !draft.id && !response.data.assigned
          ? "已登记；账号池暂无可用账号，请导入后分配"
          : "已保存",
      );
      close();
      setData({ rows: [], count: 0 });
      setLoading(true);
      setTab("orders");
      setPage(1);
      refresh();
    });
  }
  async function change(action, body) {
    await run(async () => {
      await client.post(`/proxy-orders/${current.id}/${action}`, {
        ...body,
        expectedVersion: current.version,
      });
      const response = await client.get(`/proxy-orders/${current.id}`);
      setCurrent(response.data);
      setDraft(response.data);
      setModal("detail");
      refresh();
    }, "操作已保存");
  }
  async function openAssignments() {
    await run(async () => {
      const response = await client.get("/proxy-orders/accounts", {
        params: { limit: 100 },
      });
      setAvailable(
        response.data.rows.filter(
          (a) => !a.assignment && a.status === "未使用",
        ),
      );
      setManualAccount("");
      setCount(1);
      setModal("assign");
    });
  }
  const toggle = (id) =>
    setSelected((values) =>
      values.includes(id)
        ? values.filter((value) => value !== id)
        : [...values, id],
    );
  const switchTab = (value) => {
    setData({ rows: [], count: 0 });
    setLoading(true);
    setTab(value);
    setPage(1);
    setKeyword("");
    setSelected([]);
  };
  const storeNames = (codes) =>
    (codes || [])
      .map((code) => stores.find((s) => s.code === code)?.name || code)
      .join("、");
  const modalMessage = (
    <>
      {modalError && (
        <div
          role="alert"
          className="bg-red-50 text-red-700 rounded-lg p-3 mb-3"
        >
          {modalError}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="bg-blue-50 text-blue-900 rounded-lg p-3 mb-3"
        >
          {notice}
        </div>
      )}
    </>
  );
  const form = draft && (
    <div className="space-y-4">
      {!!warnings.length && (
        <div className="rounded-lg bg-amber-50 text-amber-800 p-3 text-sm">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      <fieldset disabled={ended || busy} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            ["platformOrderNumber", "平台订单号（选填）"],
            ["lastName", "姓"],
            ["firstName", "名"],
            ["phone", "手机号"],
            ["idLast4", "身份证后四位"],
            ["email", "邮箱"],
            ["productModel", "机型"],
            ["color", "颜色"],
            ["storage", "容量"],
            ["quantity", "数量"],
            ["paymentMethod", "客户支付要求"],
          ].map(([key, label]) => (
            <Field
              key={key}
              label={label}
              type={key === "quantity" ? "number" : "text"}
              value={draft[key]}
              onChange={(value) => setField(key, value)}
            />
          ))}
        </div>
        <div className="rounded-lg bg-blue-50 p-3 space-y-3">
          <p className="font-medium text-gray-900">可接受的直营店范围</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-sm">
              选择方式
              <select
                aria-label="选择方式"
                className="input w-full mt-1"
                value={draft.storeMode}
                onChange={(event) =>
                  changeStoreScope({
                    storeMode: event.target.value,
                    storeCodes: [],
                  })
                }
              >
                <option value="selected">指定一家或多家任选</option>
                <option value="city_any">城市内任意一家</option>
              </select>
            </label>
            <label className="text-sm">
              城市
              <select
                aria-label="城市"
                className="input w-full mt-1"
                value={draft.storeCity}
                onChange={(event) =>
                  changeStoreScope({ storeCity: event.target.value })
                }
              >
                <option value="">请选择城市</option>
                {cities.map((city) => (
                  <option key={city}>{city}</option>
                ))}
              </select>
            </label>
          </div>
          {draft.storeMode === "selected" && (
            <div className="max-h-40 overflow-auto space-y-2">
              {stores
                .filter((s) => !draft.storeCity || s.city === draft.storeCity)
                .map((store) => (
                  <label
                    key={store.code}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={draft.storeCodes.includes(store.code)}
                      onChange={() =>
                        changeStoreScope({
                          storeCodes: draft.storeCodes.includes(store.code)
                            ? draft.storeCodes.filter(
                                (code) => code !== store.code,
                              )
                            : [...draft.storeCodes, store.code],
                        })
                      }
                    />
                    {store.name} · {store.city}
                  </label>
                ))}
            </div>
          )}
          <p className="text-sm text-gray-600">
            已选：{storeNames(draft.storeCodes) || "尚未确认"}。任一家符合即可。
          </p>
        </div>
        <div className="space-y-3">
          <label className="block text-sm">
            账单参考门店
            <select
              aria-label="账单参考门店"
              className="input w-full mt-1"
              value={draft.billing?.referenceStoreCode || ""}
              onChange={(event) => {
                if (event.target.value) address(event.target.value);
              }}
            >
              <option value="">选择门店并生成地址</option>
              {draft.storeCodes.map((code) => (
                <option value={code} key={code}>
                  {storeNames([code])}
                </option>
              ))}
            </select>
          </label>
          <div className="grid sm:grid-cols-3 gap-3">
            {[
              ["province", "省"],
              ["city", "市"],
              ["district", "区"],
            ].map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={draft.billing?.[key]}
                onChange={(value) =>
                  setField("billing", { ...draft.billing, [key]: value })
                }
              />
            ))}
          </div>
          <Field
            label="街道地址（可修改）"
            value={draft.billing?.streetAddress}
            onChange={(value) =>
              setField("billing", { ...draft.billing, streetAddress: value })
            }
          />
        </div>
      </fieldset>
      <label className="block text-sm">
        备注 / 其他可接受的颜色、门店
        <textarea
          aria-label="备注"
          className="input w-full mt-1"
          rows={3}
          value={draft.notes || ""}
          onChange={(event) => setField("notes", event.target.value)}
          disabled={busy}
        />
      </label>
      <p className="text-xs text-gray-500">
        模板 TAG 固定为“代抢 网店”，支付配置暂用
        WECHAT；复制后需在软件中调整，复制不改变处理状态。
      </p>
      <div className="flex justify-end gap-2">
        <button className="btn btn-secondary" onClick={close} disabled={busy}>
          取消
        </button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "保存中…" : "确认保存"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">代抢管理</h1>
          <p className="text-gray-500 mt-1">
            登记客户委托，分配专用账号并跟踪抢购结果
          </p>
        </div>
        <div className="flex gap-2">
          {can(PERMISSIONS.PROXY_EDIT) && (
            <button
              className="btn btn-primary flex gap-2 items-center"
              onClick={() => {
                setText("");
                setDraft(null);
                setWarnings([]);
                setModal("new");
              }}
            >
              <Plus className="w-4 h-4" />
              登记代抢
            </button>
          )}
          <button
            aria-label="刷新列表"
            className="btn btn-secondary"
            onClick={refresh}
            disabled={busy || loading}
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex gap-2 border-b pb-3">
        <button
          className={`btn ${tab === "orders" ? "btn-primary" : "btn-secondary"} flex items-center gap-2`}
          onClick={() => switchTab("orders")}
        >
          <FileText className="w-4 h-4" />
          代抢订单
        </button>
        {can(PERMISSIONS.PROXY_ACCOUNTS) && (
          <button
            className={`btn ${tab === "accounts" ? "btn-primary" : "btn-secondary"} flex items-center gap-2`}
            onClick={() => switchTab("accounts")}
          >
            <Users className="w-4 h-4" />
            专用 AppleID 池
          </button>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="p-3 rounded-lg bg-red-50 text-red-700 flex gap-2"
        >
          <AlertCircle className="w-5 h-5 shrink-0" />
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="p-3 rounded-lg bg-blue-50 text-blue-800">
          {notice}
        </div>
      )}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
          <input
            aria-label="搜索"
            className="input w-full pl-9"
            placeholder={
              tab === "orders" ? "姓名、平台单号、代抢编号" : "搜索 AppleID"
            }
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setPage(1);
            }}
          />
        </div>
        {tab === "orders" ? (
          <>
            <select
              aria-label="状态筛选"
              className="input w-auto"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              {Object.entries(STATUS).map(([key, [label]]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
            {can(PERMISSIONS.PROXY_COPY) && (
              <button
                className="btn btn-secondary flex gap-2 items-center"
                disabled={!selected.length || busy}
                onClick={() => copyOrders(selected)}
              >
                <Copy className="w-4 h-4" />
                复制选中（{selected.length}）
              </button>
            )}
          </>
        ) : (
          <>
            <select
              aria-label="账号范围"
              className="input w-auto"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setPage(1);
              }}
            >
              <option value="pool">专用池</option>
              <option value="candidates">历史代抢候选</option>
            </select>
            <button
              className="btn btn-primary"
              onClick={() => {
                setText("");
                setModal("import");
              }}
            >
              粘贴导入
            </button>
            {scope === "candidates" && (
              <button
                className="btn btn-secondary"
                disabled={!selected.length || busy}
                onClick={() => {
                  setConfirmation({
                    message: `将选中 ${selected.length} 个账号纳入代抢池？保留原状态和备注，有普通绑定的账号会拒绝。`,
                    execute: () =>
                      run(async () => {
                        await client.post("/proxy-orders/accounts/adopt", {
                          ids: selected,
                        });
                        refresh();
                      }, "已纳入专用池"),
                  });
                }}
              >
                核对后纳入（{selected.length}）
              </button>
            )}
          </>
        )}
      </div>
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex gap-2 justify-center py-16 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            加载中…
          </div>
        ) : !data.rows.length ? (
          <div className="text-center py-16 text-gray-500">
            {keyword || status
              ? "没有符合条件的记录"
              : tab === "orders"
                ? "暂无代抢订单，粘贴客户信息开始登记"
                : "暂无账号，可粘贴导入或核对历史候选"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="p-3">
                    <input
                      aria-label="全选当前页"
                      type="checkbox"
                      checked={data.rows.every((r) => selected.includes(r.id))}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? data.rows.map((r) => r.id)
                            : [],
                        )
                      }
                    />
                  </th>
                  {(tab === "orders"
                    ? [
                        "代抢单 / 客户",
                        "抢购需求",
                        "门店 / 备注",
                        "状态",
                        "账号 / 官方订单",
                        "登记时间",
                        "操作",
                      ]
                    : ["AppleID", "账号状态", "占用委托", "备注", "操作"]
                  ).map((label) => (
                    <th key={label} className="text-left p-3 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className="border-t hover:bg-gray-50">
                    <td className="p-3">
                      <input
                        aria-label={`选择 ${row.id}`}
                        type="checkbox"
                        checked={selected.includes(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                    </td>
                    {tab === "orders" ? (
                      <>
                        <td className="p-3">
                          <button
                            className="text-primary font-medium"
                            onClick={() => loadDetail(row)}
                          >
                            #{row.id} · {row.lastName}
                            {row.firstName}
                          </button>
                          <p className="text-gray-500 mt-1">{row.phone}</p>
                          {row.platformOrderNumber && (
                            <p className="text-xs text-gray-400">
                              平台：{row.platformOrderNumber}
                            </p>
                          )}
                        </td>
                        <td className="p-3">
                          <p>{row.productModel}</p>
                          <p className="text-gray-500 mt-1">
                            {row.color} / {row.storage} × {row.quantity}
                          </p>
                          <p className="text-xs text-gray-400">
                            {row.paymentMethod || "支付要求未填"}
                          </p>
                        </td>
                        <td className="p-3 min-w-48 max-w-72 whitespace-normal">
                          <p>{storeNames(row.storeCodes)}</p>
                          {row.notes && (
                            <p className="mt-1 text-amber-800">{row.notes}</p>
                          )}
                        </td>
                        <td className="p-3">
                          <Badge status={row.status} />
                          {row.anomaly && (
                            <p className="text-xs text-red-600 whitespace-normal max-w-48 mt-2">
                              {row.anomaly}
                            </p>
                          )}
                        </td>
                        <td className="p-3">
                          <p>
                            {row.assignments.length
                              ? `${row.assignments.length} 个账号占用中`
                              : "待分配账号"}
                          </p>
                          {row.officialOrder && (
                            <p className="font-mono text-primary mt-1">
                              {row.officialOrder.orderNumber}
                            </p>
                          )}
                        </td>
                        <td className="p-3 text-gray-500">
                          {DATE(row.createdAt)}
                        </td>
                        <td className="p-3">
                          <div className="flex gap-2">
                            <button
                              className="btn btn-secondary"
                              onClick={() => loadDetail(row)}
                              disabled={busy}
                            >
                              详情
                            </button>
                            {can(PERMISSIONS.PROXY_COPY) &&
                              ["pending", "rushing"].includes(row.status) && (
                                <button
                                  className="btn btn-secondary"
                                  disabled={busy}
                                  onClick={() => copyOrders([row.id])}
                                >
                                  复制模板
                                </button>
                              )}
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="p-3 font-mono">{row.appleId}</td>
                        <td className="p-3">{row.status}</td>
                        <td className="p-3">
                          {row.assignment
                            ? `代抢 #${row.assignment.proxyOrderId}`
                            : row.boundRecipient
                              ? "已绑定普通取机人"
                              : "未占用"}
                        </td>
                        <td className="p-3 max-w-80 whitespace-normal">
                          {row.notes || "—"}
                        </td>
                        <td className="p-3">
                          {row.isProxyPool && (
                            <button
                              className="btn btn-secondary"
                              onClick={() => {
                                setDraft(row);
                                setModal("account");
                              }}
                            >
                              编辑
                            </button>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-t text-sm text-gray-500">
          <span>
            共 {data.count} 条 · 第 {page} 页
          </span>
          <div className="flex gap-2">
            <button
              className="btn btn-secondary"
              disabled={page === 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <button
              className="btn btn-secondary"
              disabled={page * 30 >= data.count || loading}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </div>
      {(modal === "new" || modal === "edit") && (
        <Dialog
          title={modal === "new" ? "登记代抢订单" : `编辑代抢 #${draft.id}`}
          close={close}
          busy={busy}
        >
          {modalMessage}
          {modal === "new" && (
            <div className="mb-4 space-y-3">
              <div className="flex justify-between items-center">
                <label
                  htmlFor="proxy-source"
                  className="font-medium text-gray-900"
                >
                  客户抢购信息
                </label>
                <button
                  className="text-primary text-sm"
                  onClick={() =>
                    run(
                      () => clipboard(CUSTOMER_TEMPLATE),
                      "客户填写格式已生成",
                    )
                  }
                >
                  复制客户填写格式
                </button>
              </div>
              <textarea
                id="proxy-source"
                className="input w-full font-mono"
                rows={8}
                placeholder={CUSTOMER_TEMPLATE}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="flex gap-2">
                <button
                  className="btn btn-primary"
                  disabled={busy || !text.trim()}
                  onClick={parse}
                >
                  识别并预览
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setDraft({ ...EMPTY, billing: {} });
                    setWarnings([]);
                  }}
                >
                  手工填写
                </button>
              </div>
            </div>
          )}
          {form}
        </Dialog>
      )}
      {modal === "detail" && current && (
        <Dialog
          title={`代抢 #${current.id} · ${current.lastName}${current.firstName}`}
          close={close}
          busy={busy}
        >
          {modalMessage}
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center">
              <Badge status={current.status} />
              {can(PERMISSIONS.PROXY_EDIT) && (
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setWarnings([]);
                    setModal("edit");
                  }}
                >
                  编辑
                  {["succeeded", "cancelled"].includes(current.status)
                    ? "备注"
                    : "资料"}
                </button>
              )}
              {can(PERMISSIONS.PROXY_COPY) &&
                ["pending", "rushing"].includes(current.status) && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => copyOrders([current.id])}
                    disabled={busy}
                  >
                    复制模板
                  </button>
                )}
              {can(PERMISSIONS.PROXY_STATUS) &&
                ["pending", "rushing"].includes(current.status) && (
                  <>
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() =>
                        change("status", {
                          status:
                            current.status === "pending"
                              ? "rushing"
                              : "pending",
                        })
                      }
                    >
                      {current.status === "pending"
                        ? "标记抢购中"
                        : "退回待处理"}
                    </button>
                    <button
                      className="btn btn-secondary text-red-600"
                      disabled={busy}
                      onClick={() => {
                        setConfirmation({
                          message:
                            "取消此代抢单？请另行停止抢购软件任务，账号需人工释放。",
                          execute: () =>
                            change("status", { status: "cancelled" }),
                        });
                      }}
                    >
                      取消代抢
                    </button>
                  </>
                )}
            </div>
            {current.anomaly && (
              <p className="bg-red-50 text-red-700 p-3 rounded-lg">
                {current.anomaly}
              </p>
            )}
            <dl className="grid sm:grid-cols-2 gap-3 text-sm">
              {[
                [
                  "抢购需求",
                  `${current.productModel} / ${current.color} / ${current.storage} × ${current.quantity}`,
                ],
                ["支付要求", current.paymentMethod],
                ["手机号", current.phone],
                ["邮箱", current.email],
                ["身份证后四位", current.idLast4],
                ["平台订单号", current.platformOrderNumber],
                ["门店范围", storeNames(current.storeCodes)],
                [
                  "账单地址",
                  [
                    current.billing.province,
                    current.billing.city,
                    current.billing.district,
                    current.billing.streetAddress,
                  ].join(" "),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-gray-500">{label}</dt>
                  <dd className="mt-1 break-words text-gray-900">
                    {value || "—"}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="bg-amber-50 p-3 rounded-lg text-amber-900 whitespace-pre-wrap">
              备注：{current.notes || "无"}
            </div>
            <div className="border rounded-lg p-3 space-y-3">
              <div className="flex justify-between gap-2 items-center">
                <h3 className="font-semibold">账号分配历史</h3>
                {can(PERMISSIONS.PROXY_ACCOUNTS) &&
                  ["pending", "rushing"].includes(current.status) && (
                    <button
                      className="btn btn-secondary"
                      onClick={openAssignments}
                      disabled={busy}
                    >
                      追加账号
                    </button>
                  )}
              </div>
              {current.assignments.length ? (
                current.assignments.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap gap-2 justify-between border-t pt-2 text-sm"
                  >
                    <div>
                      <p className="break-all">{a.accountEmail}</p>
                      <p className="text-gray-500">
                        {DATE(a.startedAt)} →{" "}
                        {a.endedAt ? DATE(a.endedAt) : "占用中"}
                      </p>
                    </div>
                    {!a.endedAt && can(PERMISSIONS.PROXY_ACCOUNTS) && (
                      <button
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() => {
                          setConfirmation({
                            message:
                              "确认此账号在抢购软件中的对应任务已经停止？释放后可分配给其他客户。",
                            execute: () =>
                              change("release", {
                                assignmentIds: [a.id],
                                confirmedStopped: true,
                              }),
                          });
                        }}
                      >
                        确认停抢并释放
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-sm">未分配账号</p>
              )}
            </div>
            <div className="border rounded-lg p-3 space-y-2">
              <div className="flex justify-between">
                <h3 className="font-semibold">关联官方订单</h3>
                {can(PERMISSIONS.PROXY_LINK) && (
                  <button
                    className="text-primary text-sm"
                    onClick={() => {
                      setReason("");
                      setOrderNumber("");
                      setModal("link");
                    }}
                  >
                    {current.orderId ? "纠正误关联" : "人工核对关联"}
                  </button>
                )}
              </div>
              {current.officialOrder ? (
                <div className="text-sm">
                  <p className="font-mono text-primary">
                    {current.officialOrder.orderNumber}
                  </p>
                  <p>
                    {current.officialOrder.products
                      .map((p) => `${p.name} × ${p.quantity}`)
                      .join("；")}
                  </p>
                  <p>
                    {current.officialOrder.pickupStore} ·{" "}
                    {current.officialOrder.status}
                  </p>
                  {can(PERMISSIONS.ORDERS_READ) && (
                    <a
                      className="text-primary"
                      href={`/orders/${current.orderId}`}
                    >
                      打开订单管理详情
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-gray-500 text-sm">
                  等待系统自动匹配；资料不足或特殊需求可人工核对。
                </p>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-gray-600">
                客户原始信息
              </summary>
              <pre className="text-sm whitespace-pre-wrap break-words bg-gray-50 p-3 mt-2">
                {current.rawText || "手工录入"}
              </pre>
            </details>
            <details>
              <summary className="cursor-pointer text-gray-600">
                操作记录（最近 100 条）
              </summary>
              <ul className="mt-2 space-y-2 text-sm text-gray-600">
                {current.events.map((e) => (
                  <li key={e.id}>
                    {DATE(e.createdAt)} · {ACTIONS[e.action] || e.action} ·{" "}
                    {e.actorId ? `员工 #${e.actorId}` : "系统"}
                    {e.detail?.from &&
                      `：${STATUS[e.detail.from]?.[0]} → ${STATUS[e.detail.to]?.[0]}`}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </Dialog>
      )}
      {modal === "assign" && (
        <Dialog title="追加抢购账号" close={close} busy={busy}>
          {modalMessage}
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              每个账号生成一行导入模板；同时只能由一笔代抢单占用。
            </p>
            <label className="block text-sm">
              账号选择
              <select
                className="input w-full mt-1"
                value={manualAccount}
                onChange={(event) => setManualAccount(event.target.value)}
              >
                <option value="">自动分配可用账号</option>
                {available.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.appleId}
                  </option>
                ))}
              </select>
            </label>
            {!manualAccount && (
              <Field
                label="追加数量（1–20）"
                type="number"
                value={count}
                onChange={setCount}
              />
            )}
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                change(
                  "accounts",
                  manualAccount
                    ? { accountIds: [Number(manualAccount)] }
                    : { count },
                )
              }
            >
              确认分配
            </button>
          </div>
        </Dialog>
      )}
      {modal === "link" && (
        <Dialog
          title={current.orderId ? "解除误关联" : "人工核对官方订单"}
          close={close}
          busy={busy}
        >
          {modalMessage}
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {current.orderId
                ? "解除后保留历史，该官方订单不再自动关联回来。成功状态恢复待处理，已取消保持。"
                : "请核对客户、账号、下单时间、商品数量及可接受门店。关联后即视为抢购成功，已取消单保留取消并提示异常。"}
            </p>
            {!current.orderId && (
              <Field
                label="Apple 订单号"
                value={orderNumber}
                onChange={setOrderNumber}
              />
            )}
            <Field
              label="核对 / 纠错原因"
              value={reason}
              onChange={setReason}
            />
            <button
              className="btn btn-primary"
              disabled={busy || !reason.trim()}
              onClick={() =>
                change("link", {
                  orderNumber: current.orderId ? null : orderNumber.trim(),
                  reason,
                })
              }
            >
              确认{current.orderId ? "解除" : "关联"}
            </button>
          </div>
        </Dialog>
      )}
      {modal === "import" && (
        <Dialog title="导入代抢 AppleID" close={close} busy={busy}>
          {modalMessage}
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              每行“账号 空格 密码”，也支持 Tab 或 ---- 分隔，最多 500
              行。重复账号不覆盖密码；已有非专用账号需先核对纳入。
            </p>
            <textarea
              aria-label="账号密码文本"
              className="input w-full font-mono"
              rows={10}
              autoComplete="off"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="account@example.com password"
            />
            <button
              className="btn btn-primary"
              disabled={busy || !text.trim()}
              onClick={() =>
                run(async () => {
                  await client.post("/proxy-orders/accounts/import", { text });
                  close();
                  setScope("pool");
                  refresh();
                }, "账号导入完成")
              }
            >
              校验并导入
            </button>
          </div>
        </Dialog>
      )}
      {modal === "account" && (
        <Dialog title="编辑代抢账号" close={close} busy={busy}>
          {modalMessage}
          <div className="space-y-3">
            <p className="font-mono break-all">{draft.appleId}</p>
            <label className="block text-sm">
              状态
              <select
                className="input w-full"
                value={draft.status}
                onChange={(event) => setField("status", event.target.value)}
              >
                {["未使用", "使用中", "已下架", "异常"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <Field
              label="备注"
              value={draft.notes}
              onChange={(value) => setField("notes", value)}
            />
            <p className="text-xs text-gray-500">
              修改状态不会解除占用，释放账号请进入对应代抢单。
            </p>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await client.put(`/proxy-orders/accounts/${draft.id}`, {
                    status: draft.status,
                    notes: draft.notes || "",
                    expectedUpdatedAt: draft.updatedAt,
                  });
                  close();
                  refresh();
                }, "账号已更新")
              }
            >
              保存
            </button>
          </div>
        </Dialog>
      )}
      {confirmation && (
        <Dialog
          title="确认操作"
          close={() => setConfirmation(null)}
          busy={busy}
        >
          <p className="text-gray-700 mb-4">{confirmation.message}</p>
          <div className="flex justify-end gap-2">
            <button
              className="btn btn-secondary"
              onClick={() => setConfirmation(null)}
            >
              返回
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                const execute = confirmation.execute;
                setConfirmation(null);
                execute();
              }}
            >
              确认执行
            </button>
          </div>
        </Dialog>
      )}
      {copyFallback && (
        <Dialog
          title="请手动复制"
          close={() => setCopyFallback("")}
          busy={false}
        >
          <p className="text-sm text-gray-600 mb-3">
            浏览器未允许自动写入剪贴板，请全选下方内容复制。
          </p>
          <textarea
            className="input w-full font-mono"
            aria-label="待复制内容"
            rows={8}
            readOnly
            value={copyFallback}
            onFocus={(event) => event.target.select()}
          />
          <p className="text-xs text-gray-500 mt-2">关闭后清除本页临时模板。</p>
        </Dialog>
      )}
    </div>
  );
}
