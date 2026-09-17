import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getAppleIdDetail } from '../api/appleIdsApi';
import { STATUS_OPTIONS } from '../constants/status';

const clean = value => (value === '-' ? '' : value || '');

/** 基础档案表单，保留姓与名，绑定与使用状态分别维护。 */
export default function ProfileFormModal({ kind, item, onClose, onSave }) {
  const account = kind === 'account';
  const { can } = useAuth();
  const canQa = can('apple_ids.secrets.read');
  const canBind = can('recipients.bind_apple_ids') && can('apple_ids.read');
  const [form, setForm] = useState(() => ({
    appleId: clean(account ? item?.appleId : item?.boundAppleId),
    password: clean(item?.password),
    notes: clean(item?.notes),
    country: clean(item?.country) || '中国',
    status: item?.status || '未使用',
    lastName: clean(item?.lastName),
    firstName: clean(item?.firstName),
    idCardNumber: clean(item?.idCard),
    realPhone: clean(item?.realPhone),
    phone: clean(item?.phone),
    email: clean(item?.email),
    province: clean(item?.province),
    city: clean(item?.city),
    district: clean(item?.district),
    streetAddress: clean(item?.streetAddress),
    tag: clean(item?.tag),
    question1: '',
    answer1: '',
    question2: '',
    answer2: '',
    question3: '',
    answer3: '',
  }));
  const [busy, setBusy] = useState(false);
  const [loadingQa, setLoadingQa] = useState(Boolean(account && item && canQa));
  const [qaReady, setQaReady] = useState(!item);
  const [qaDirty, setQaDirty] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (account && item && canQa) {
      getAppleIdDetail(item.id, { includeSecrets: true })
        .then(response => {
          if (active) {
            setForm(previous => ({ ...previous, ...response.data.security_qa }));
            setQaReady(true);
          }
        })
        .catch(failure => {
          if (active) setError(failure.message);
        })
        .finally(() => {
          if (active) setLoadingQa(false);
        });
    }
    return () => {
      active = false;
    };
  }, [account, item, canQa]);
  const change = (key, value) => {
    setForm(previous => ({ ...previous, [key]: value }));
    if (/^(question|answer)/.test(key)) setQaDirty(true);
  };
  const field = (key, label, required = false, type = 'text', disabled = false) => (
    <label key={key} className="block text-sm text-gray-700">
      {label}
      {required ? ' *' : ''}
      <input
        aria-label={`${label}${required ? ' *' : ''}`}
        className="input w-full mt-1"
        value={form[key] ?? ''}
        onChange={event => change(key, event.target.value)}
        type={type}
        required={required}
        disabled={disabled}
        autoComplete="off"
        maxLength={key === 'idCardNumber' ? 18 : 1000}
      />
    </label>
  );
  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let payload;
      if (account) {
        payload = {
          appleId: form.appleId.trim(),
          password: form.password,
          notes: form.notes,
          country: form.country,
          status: form.status,
        };
        if ((!item || qaDirty) && canQa && qaReady) {
          const qa = Object.fromEntries(
            [1, 2, 3].flatMap(i => [
              [`question${i}`, form[`question${i}`]],
              [`answer${i}`, form[`answer${i}`]],
            ])
          );
          payload.securityQa = Object.values(qa).some(Boolean) ? qa : null;
        }
      } else {
        payload = Object.fromEntries(
          [
            'lastName',
            'firstName',
            'idCardNumber',
            'realPhone',
            'phone',
            'email',
            'province',
            'city',
            'district',
            'streetAddress',
            'tag',
            'status',
            'notes',
          ].map(key => [key, form[key]])
        );
        if (canBind && form.appleId.trim() !== clean(item?.boundAppleId)) {
          payload.appleId = form.appleId.trim();
          if (item) payload.expectedAppleIdRef = item.appleIdRef ?? null;
        }
      }
      await onSave(payload);
      onClose();
    } catch (failure) {
      setError(failure.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="!m-0 fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={`${item ? '编辑' : '添加'}${account ? 'Apple ID' : '取机人'}`}
        onSubmit={submit}
        className="bg-white rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-xl"
      >
        <div className="p-5 border-b flex justify-between items-center">
          <h2 className="text-xl font-semibold">
            {item ? '编辑' : '添加'}
            {account ? ' Apple ID' : '取机人'}
          </h2>
          <button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          {error && (
            <p role="alert" className="text-red-700 bg-red-50 p-3 rounded">
              {error}
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {account ? (
              <>
                {field('appleId', 'Apple ID', true, 'email', Boolean(item))}
                {field('password', '密码', true, 'password')}
                {field('country', '国家', true)}
              </>
            ) : (
              <>
                {field('lastName', '姓', true)}
                {field('firstName', '名', true)}
                {field('idCardNumber', '身份证号', true)}
                {field('realPhone', '真实联系电话')}
                {field('phone', '下单手机号')}
                {field('email', '下单邮箱（@vvv8.net）', false, 'email')}
                {field('province', '省')}
                {field('city', '市')}
                {field('district', '区')}
                {field('streetAddress', '街道地址')}
                {field('tag', 'TAG')}
                {canBind && field('appleId', '绑定 Apple ID（留空解除绑定）', false, 'email')}
              </>
            )}
            <label className="block text-sm text-gray-700">
              使用状态
              <select
                aria-label="使用状态"
                className="input w-full mt-1"
                value={form.status}
                onChange={e => change('status', e.target.value)}
              >
                {STATUS_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm text-gray-700">
            备注
            <textarea
              aria-label="备注"
              className="input w-full mt-1"
              rows={3}
              maxLength={10000}
              value={form.notes}
              onChange={e => change('notes', e.target.value)}
            />
          </label>
          {account && canQa && (
            <div className="border-t pt-4 space-y-3">
              <p className="text-sm text-gray-600">
                密保问答：填写完整三组；全部清空表示删除已有密保。
              </p>
              {loadingQa ? (
                <p>正在读取密保…</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[1, 2, 3].flatMap(i => [
                    field(`question${i}`, `问题 ${i}`, false, 'text', !qaReady),
                    field(`answer${i}`, `答案 ${i}`, false, 'text', !qaReady),
                  ])}
                </div>
              )}
            </div>
          )}
          {!account && (
            <p className="text-sm text-gray-500">
              只能绑定未被其他取机人占用的账号；换绑和解绑不改变使用状态及历史订单。
            </p>
          )}
        </div>
        <div className="p-4 border-t flex justify-end gap-3">
          <button
            type="button"
            className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy || loadingQa}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
