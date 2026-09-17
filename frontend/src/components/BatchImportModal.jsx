import { useState } from 'react';
import { X, Upload, Download } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { downloadTemplate, previewImport, reviewImport, executeImport } from '../api/importApi';

/** 上传、预览、裁定、确认执行四步导入，密码及密保不进入预览。 */
export default function BatchImportModal({ type, onClose, onImport }) {
  const apiType = type === 'appleIds' ? 'apple_ids' : 'recipients';
  const { can } = useAuth();
  const [files, setFiles] = useState([]);
  const [plan, setPlan] = useState(null);
  const [token, setToken] = useState('');
  const [decisions, setDecisions] = useState({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const run = async action => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const preview = () =>
    run(async () => {
      const response = await previewImport(files, apiType);
      setPlan(response.data);
      setToken(response.data.sessionToken);
      setDecisions({});
      setDirty(false);
      setResult(null);
      setPage(1);
    });
  const review = () =>
    run(async () => {
      const response = await reviewImport(token, apiType, decisions);
      setPlan(response.data);
      setDirty(false);
    });
  const execute = () =>
    run(async () => {
      const response = await executeImport(token, apiType, decisions);
      setResult(response.data);
      setToken('');
      await onImport();
    });
  const choose = (key, value) => {
    setDecisions(previous => ({ ...previous, [key]: value }));
    setDirty(true);
  };
  const visibleRecords = plan?.records.slice((page - 1) * 30, page * 30) || [];
  return (
    <div className="!m-0 fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="批量导入预览"
        className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b flex justify-between items-center">
          <h2 className="text-xl font-semibold">
            批量导入{type === 'appleIds' ? ' Apple ID' : '取机人'}
          </h2>
          <button aria-label="关闭" disabled={busy} onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          <p className="text-sm text-gray-600">
            支持同时上传汇总表和渠道表的 .xlsx
            文件。自动去重；差异必须选择来源后确认。首次导入后由系统维护。空值不覆盖已有资料。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {can(`${apiType}.template.read`) && (
              <button
                className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={busy}
                onClick={() => run(() => downloadTemplate(apiType))}
              >
                <Download className="w-4 h-4 inline mr-2" />
                下载模板
              </button>
            )}
            <input
              aria-label="选择导入文件"
              type="file"
              accept=".xlsx"
              multiple
              disabled={busy}
              onChange={e => {
                setFiles([...e.target.files]);
                setPlan(null);
                setToken('');
                setResult(null);
              }}
            />
            <button
              className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={busy || !files.length}
              onClick={preview}
            >
              <Upload className="w-4 h-4 inline mr-2" />
              生成预览
            </button>
          </div>
          {files.length > 0 && (
            <p className="text-sm text-gray-500">{files.map(file => file.name).join('、')}</p>
          )}
          {error && (
            <p role="alert" className="bg-red-50 text-red-700 p-3 rounded">
              {error}
            </p>
          )}
          {result && (
            <p role="status" className="bg-green-50 text-green-800 p-3 rounded">
              导入完成：新增 {result.imported}，更新 {result.updated}，重复或跳过 {result.skipped}
              ，无效源行 {result.errors?.length || 0}。
            </p>
          )}
          {plan && (
            <>
              <p className="text-sm bg-blue-50 p-3 rounded">
                源行 {plan.summary.total} · 档案 {plan.summary.records} · 无效行{' '}
                {plan.summary.invalid} · 未裁定差异 {plan.summary.conflicts} · 有问题档案{' '}
                {plan.summary.blocked}
                {dirty && ' · 选择已改变，请更新预览'}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-2 text-left">跳过</th>
                      <th className="p-2 text-left">档案／来源</th>
                      <th className="p-2 text-left">操作</th>
                      <th className="p-2 text-left">差异与问题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRecords.map(record => (
                      <tr key={record.id} className="border-b align-top">
                        <td className="p-2">
                          <input
                            aria-label={`跳过 ${record.label}`}
                            type="checkbox"
                            disabled={busy || !token}
                            checked={Boolean(decisions[`${record.id}:skip`])}
                            onChange={e => choose(`${record.id}:skip`, e.target.checked)}
                          />
                        </td>
                        <td className="p-2">
                          <p>
                            {record.kind === 'account' ? '账号' : '取机人'}：{record.label}
                          </p>
                          <details className="text-gray-600 mt-1">
                            <summary>查看待保留字段</summary>
                            {Object.entries(record.fields || {}).map(([key, value]) => (
                              <p key={key}>
                                {key}：{String(value)}
                              </p>
                            ))}
                          </details>
                          <details className="text-gray-500 mt-1">
                            <summary>{record.sources.length} 条来源</summary>
                            {record.sources.map((source, i) => (
                              <p key={i}>{source}</p>
                            ))}
                          </details>
                        </td>
                        <td className="p-2">{record.action}</td>
                        <td className="p-2 space-y-2">
                          {record.problems.map((message, i) => (
                            <p key={i} className="text-red-700">
                              {message}
                            </p>
                          ))}
                          {plan.conflicts
                            .filter(conflict => conflict.groupId === record.id)
                            .map(conflict => (
                              <label key={conflict.id} className="block">
                                {conflict.field}
                                <select
                                  className="input w-full mt-1"
                                  aria-label={`${record.label} ${conflict.field} 来源`}
                                  value={decisions[conflict.id] || ''}
                                  disabled={busy || !token || decisions[`${record.id}:skip`]}
                                  onChange={e => choose(conflict.id, e.target.value)}
                                >
                                  <option value="">请选择保留来源</option>
                                  {conflict.options.map(option => (
                                    <option key={option.key} value={option.key}>
                                      {String(option.value)} — {option.source}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!plan.records.length && <p className="p-4 text-gray-500">没有有效档案</p>}
              </div>
              <div className="flex justify-end gap-3 items-center">
                <button
                  className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <span>
                  {page} / {Math.max(1, Math.ceil(plan.records.length / 30))}
                </span>
                <button
                  className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={page * 30 >= plan.records.length}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
              {plan.errors.length > 0 && (
                <details className="text-sm text-red-700">
                  <summary>以下 {plan.errors.length} 行不会导入，请修正后重传</summary>
                  {plan.errors.map((entry, i) => (
                    <p key={i}>
                      {entry.fileName} / {entry.sheetName} / 第{entry.rowNumber}行：{entry.error}
                    </p>
                  ))}
                </details>
              )}
            </>
          )}
        </div>
        <div className="p-4 border-t flex flex-wrap justify-end gap-3">
          <button
            className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </button>
          {token && (
            <>
              <button
                className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={busy}
                onClick={review}
              >
                更新预览
              </button>
              <button
                className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={
                  busy ||
                  dirty ||
                  plan.summary.conflicts > 0 ||
                  plan.summary.blocked > 0 ||
                  !plan.records.length
                }
                onClick={execute}
              >
                {busy ? '处理中…' : '确认导入有效档案'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
