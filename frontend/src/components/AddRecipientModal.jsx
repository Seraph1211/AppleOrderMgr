import ProfileFormModal from './ProfileFormModal';

export default function AddRecipientModal({ onClose, onSave }) {
  return <ProfileFormModal kind="recipient" onClose={onClose} onSave={onSave} />;
}
