import ProfileFormModal from './ProfileFormModal';

export default function EditRecipientModal({ onClose, onSave, recipient }) {
  return (
    <ProfileFormModal
      kind="recipient"
      item={recipient}
      onClose={onClose}
      onSave={payload => onSave(recipient.id, payload)}
    />
  );
}
