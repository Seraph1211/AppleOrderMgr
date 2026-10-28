import { useRef, useState } from 'react';
import { ArrowLeft, FileUp } from 'lucide-react';
import { activateTaskConfig, previewTaskConfig } from '../api/taskConfigsApi';
import useTaskConfigPanel from './useTaskConfigPanel';
import { TaskConfigScopeTable, TaskConfigTable } from './taskConfigCommon';
import { taskConfigEffectiveAt, taskConfigError, taskConfigTime } from '../utils/taskConfigDisplay';

const MAX_BYTES = 8 * 1024 * 1024;
const FIELD_LABELS = { row: '配置行', stores: '门店', product: '商品规格', quantity: '购买数量' };

/** 按完整实例快照导入，只有服务器验证过的预览才可以确认生效。 */
export default function TaskConfigImport({ instance, onCancel, onSaved }) {
  const panelRef = useTaskConfigPanel();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [effectiveAt, setEffectiveAt] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const readSequence = useRef(0);
  const reviewRef = useRef(null);

  async function readFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const sequence = ++readSequence.current;
    setError('');
    setPreview(null);
    setConfirmed(false);
    setText('');
    setFileName('');
    setBusy(true);
    try {
      if (file.size > MAX_BYTES) throw new Error('文件不能超过 8 MiB，请导入单个实例的完整配置');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (sequence !== readSequence.current) return;
      setText(content);
      setFileName(file.name);
    } catch (readError) {
      if (sequence === readSequence.current)
        setError(
          readError.name === 'TypeError'
            ? '文件不是有效 UTF-8 文本，请另存为 UTF-8 后导入'
            : taskConfigError(readError)
        );
    } finally {
      if (sequence === readSequence.current) setBusy(false);
    }
  }

  async function parse(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      if (!text.trim()) throw new Error('请上传或粘贴该实例的完整任务配置');
      if (new TextEncoder().encode(text).length > MAX_BYTES)
        throw new Error('配置文本不能超过 8 MiB');
      const next = await previewTaskConfig(instance.instanceId, text);
      setPreview(next);
      setConfirmed(false);
      // 预览只保留脱敏统计；离开输入步骤后及时移除内存中的原始配置。
      setText('');
      requestAnimationFrame(() => reviewRef.current?.focus());
    } catch (parseError) {
      setError(taskConfigError(parseError));
    } finally {
      setBusy(false);
    }
  }

  async function activate(event) {
    event.preventDefault();
    if (!preview?.valid || !confirmed || conflict) return;
    setBusy(true);
    setError('');
    try {
      const result = await activateTaskConfig(instance.instanceId, {
        previewId: preview.previewId,
        expectedRevision: preview.expectedRevision,
        effectiveAt: taskConfigEffectiveAt(effectiveAt),
      });
      await onSaved(
        result,
        result.unchanged ? '配置内容未变，任务数没有累加。' : '完整任务配置已生效。'
      );
    } catch (activateError) {
      setConflict(activateError?.response?.status === 409);
      setError(taskConfigError(activateError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section ref={panelRef} tabIndex={-1} className="task-config-panel" aria-busy={busy}>
      <div className="task-config-title-row">
        <div>
          <button className="task-back" disabled={busy} onClick={onCancel}>
            <ArrowLeft className="w-4 h-4" />
            返回实例配置
          </button>
          <h2 className="text-xl font-semibold text-gray-900 mt-3">更新任务配置</h2>
          <p className="text-sm text-gray-600 mt-1">
            {instance.serverName} / {instance.instanceName}
          </p>
        </div>
        <span className="text-sm text-gray-600">
          {preview ? '2. 核对并确认生效' : '1. 导入完整配置'}
        </span>
      </div>
      <p className="task-config-note">
        每行代表一个任务，重复账号和重复行分别计数。一次导入完整替换本实例配置，不会追加任务，也不会修改采集器中的下单设置。
      </p>
      {error && (
        <p role="alert" className="task-config-error">
          {error}
        </p>
      )}
      {!preview ? (
        <form onSubmit={parse} className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label
              className={`btn btn-secondary inline-flex items-center gap-2 cursor-pointer ${busy ? 'opacity-60' : ''}`}
            >
              <FileUp className="w-4 h-4" />
              选择 TXT 文件
              <input
                aria-label="上传任务配置文件"
                type="file"
                accept=".txt,text/plain"
                className="sr-only"
                disabled={busy}
                onChange={readFile}
              />
            </label>
            <span className="text-sm text-gray-600 break-all">
              {fileName || 'UTF-8 文本，最多 8 MiB、10,000 个任务'}
            </span>
          </div>
          <label className="task-config-field">
            或粘贴完整配置
            <textarea
              className="input min-h-[200px] font-mono text-sm"
              value={text}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              placeholder="将当前实例的完整配置粘贴到这里"
              onChange={event => {
                setText(event.target.value);
                setFileName('');
              }}
            />
          </label>
          <p className="text-sm text-gray-600">
            仅提取行号、门店和商品规格；账号密码、证件、地址不进入统计记录。空文件不会清空现有配置。
          </p>
          <div className="task-config-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
              {busy ? '正在解析…' : '解析并预览'}
            </button>
          </div>
        </form>
      ) : (
        <div ref={reviewRef} tabIndex={-1} className="space-y-5 focus:outline-none">
          <dl className="task-config-summary">
            {[
              ['任务数', preview.taskCount],
              ['覆盖城市', preview.cityCount],
              ['商品规格', preview.specCount],
              ['空行', preview.blankLineCount],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{Number(value || 0).toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          {!!preview.errors?.length && (
            <div className="space-y-2">
              <p role="alert" className="task-config-error">
                存在以下解析错误（最多展示 100 项），本次配置不能生效。请按行号修正后重新导入。
              </p>
              <TaskConfigTable headers={['原始行号', '字段', '问题']}>
                {preview.errors.map((item, index) => (
                  <tr key={`${item.rowNumber}-${index}`}>
                    <td className="task-num">{item.rowNumber || '—'}</td>
                    <td>{FIELD_LABELS[item.field] || '配置字段'}</td>
                    <td className="task-cell-wrap">{item.message}</td>
                  </tr>
                ))}
              </TaskConfigTable>
            </div>
          )}
          <div>
            <h3 className="font-semibold text-gray-900 mb-3">城市与规格任务数变化</h3>
            <TaskConfigScopeTable rows={preview.diff || []} diff />
          </div>
          {preview.valid && (
            <form onSubmit={activate} className="space-y-4 border-t border-gray-200 pt-4">
              <label className="task-config-field max-w-sm">
                实际生效时间（北京时间，可选）
                <input
                  className="input"
                  type="datetime-local"
                  step="1"
                  value={effectiveAt}
                  disabled={busy}
                  onChange={event => setEffectiveAt(event.target.value)}
                />
              </label>
              <p className="text-sm text-gray-600">
                留空以确认时刻生效。仅在实例已经应用配置时填写过去时间，不能早于当前版本生效时间。历史已发送通知不会被改写。
              </p>
              <p className="text-sm text-gray-600">
                预览有效至 {taskConfigTime(preview.expiresAt)}；超时请重新导入。
              </p>
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={confirmed}
                  disabled={busy}
                  onChange={event => setConfirmed(event.target.checked)}
                />
                <span>我已核对实例、完整任务数及上述差异，确认以这份配置替换当前统计配置。</span>
              </label>
              <div className="task-config-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setConfirmed(false);
                    setError('');
                    setConflict(false);
                  }}
                >
                  重新导入
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || !confirmed || conflict}
                >
                  {busy ? '正在保存…' : '确认替换并生效'}
                </button>
              </div>
            </form>
          )}
          {!preview.valid && (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setError('');
              }}
            >
              修正后重新导入
            </button>
          )}
        </div>
      )}
    </section>
  );
}
