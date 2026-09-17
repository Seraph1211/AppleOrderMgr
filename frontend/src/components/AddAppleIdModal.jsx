import ProfileFormModal from './ProfileFormModal';

export default function AddAppleIdModal({ onClose, onSave }) {
  return <ProfileFormModal kind="account" onClose={onClose} onSave={onSave} />;
}
