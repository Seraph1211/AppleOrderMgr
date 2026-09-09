import { useState } from 'react';
import { X } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../contexts/AuthContext';

/** 管理员当次设置新密码，不读取或回显原密码。 */
export default function ResetPasswordModal({ user, onClose, onSuccess }) {
  const { user: currentUser, logout } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await client.post(`/users/${user.id}/reset-password`, { newPassword, confirmPassword });
      setNewPassword('');
      setConfirmPassword('');
      if (currentUser.id === user.id) {
        await logout(false);
        sessionStorage.setItem('authNotice', '密码已重置，请使用新密码重新登录');
        window.location.assign('/login');
        return;
      }
      onSuccess();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-title"
    >
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 id="reset-title" className="text-xl font-bold text-gray-900">
            重置密码
          </h2>
          <button aria-label="关闭" onClick={onClose} disabled={saving}>
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <p className="text-sm text-gray-700">
          {user.nickname}（{user.username}） · {user.accountId}
        </p>
        <p className="text-sm text-gray-500 my-4">
          确认后，该账号当前登录会退出。请将新密码告知本人。
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label
              htmlFor="reset-password"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              新密码
            </label>
            <input
              id="reset-password"
              type={visible ? 'text' : 'password'}
              autoComplete="new-password"
              className="input"
              minLength={8}
              required
              disabled={saving}
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="reset-confirm" className="block text-sm font-medium text-gray-700 mb-2">
              确认新密码
            </label>
            <input
              id="reset-confirm"
              type={visible ? 'text' : 'password'}
              autoComplete="new-password"
              className="input"
              minLength={8}
              required
              disabled={saving}
              value={confirmPassword}
              onChange={event => setConfirmPassword(event.target.value)}
            />
          </div>
          <label className="text-sm text-gray-600 flex gap-2">
            <input
              type="checkbox"
              checked={visible}
              onChange={event => setVisible(event.target.checked)}
            />
            显示本次填写的新密码
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? '重置中...' : '确认重置'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
