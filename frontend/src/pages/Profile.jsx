import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, UserRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';

/** 所有账号均可访问的个人设置。 */
export default function Profile() {
  const { user, refreshCurrentUser } = useAuth();
  const [nickname, setNickname] = useState(user?.nickname || user?.username || '');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    setNickname(user?.nickname || user?.username || '');
  }, [user?.nickname, user?.username]);
  const save = async event => {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      await client.patch('/auth/profile', { nickname });
      await refreshCurrentUser();
      setNotice({ message: '昵称已保存', success: true });
    } catch (error) {
      setNotice({ message: error.message, success: false });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center">
          <UserRound className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">个人设置</h1>
          <p className="text-sm text-gray-500">管理自己的昵称和登录密码</p>
        </div>
      </div>
      {!user?.permissions?.length && (
        <p className="text-sm text-gray-600">当前还没有业务页面权限，请联系管理员配置。</p>
      )}
      <form onSubmit={save} className="card space-y-5">
        <div>
          <label htmlFor="accountId" className="block text-sm font-medium text-gray-700 mb-2">
            账号 ID
          </label>
          <input
            id="accountId"
            className="input bg-gray-50"
            value={user?.accountId || ''}
            readOnly
          />
        </div>
        <div>
          <label htmlFor="loginAccount" className="block text-sm font-medium text-gray-700 mb-2">
            登录账号
          </label>
          <input
            id="loginAccount"
            className="input bg-gray-50"
            value={user?.username || ''}
            readOnly
          />
          <p className="text-xs text-gray-500 mt-1">账号 ID 和登录账号固定，不随昵称变化。</p>
        </div>
        <div>
          <label htmlFor="nickname" className="block text-sm font-medium text-gray-700 mb-2">
            昵称
          </label>
          <input
            id="nickname"
            className="input"
            maxLength={50}
            required
            value={nickname}
            onChange={event => setNickname(event.target.value)}
            disabled={saving}
          />
        </div>
        {notice && (
          <p
            role="status"
            className={notice.success ? 'text-sm text-green-700' : 'text-sm text-red-600'}
          >
            {notice.message}
          </p>
        )}
        <div className="flex justify-end">
          <button className="btn btn-primary" disabled={saving}>
            {saving ? '保存中...' : '保存昵称'}
          </button>
        </div>
      </form>
      <div className="card flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-gray-900">登录密码</h2>
          <p className="text-sm text-gray-500 mt-1">修改后需要使用新密码重新登录。</p>
        </div>
        <Link to="/change-password" className="btn btn-secondary inline-flex items-center gap-2">
          <Lock className="w-4 h-4" />
          修改密码
        </Link>
      </div>
    </div>
  );
}
