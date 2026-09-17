import ProfileFormModal from './ProfileFormModal';

export default function EditAppleIdModal({ onClose, onSave, appleId }) {
  return (
    <ProfileFormModal
      kind="account"
      item={appleId}
      onClose={onClose}
      onSave={payload => onSave(appleId.id, payload)}
    />
  );
}
