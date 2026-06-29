import type { Message } from "../api";
import { Icon, type IconName } from "./Icon";

/**
 * Touch action sheet for a single message. On coarse pointers the hover toolbar is
 * unreachable, so a per-message ⋯ opens this explicit bottom sheet instead — no
 * overlapping hover targets, so a tap can never trigger the wrong action.
 */
type Props = {
  msg: Message;
  isMine: boolean;
  onReply: () => void;
  onPin?: () => void;
  onForward?: () => void;
  onSave: () => void;
  onHide?: () => void;
  onReport?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onClose: () => void;
};

export function MessageActionSheet({
  msg,
  isMine,
  onReply,
  onPin,
  onForward,
  onSave,
  onHide,
  onReport,
  onEdit,
  onDelete,
  onClose,
}: Props) {
  return (
    <div className="kc-sheet-backdrop" role="presentation" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- event-containment wrapper (keeps taps inside the sheet), not a control; rows below are real buttons */}
      <div className="kc-sheet" aria-label="Message actions" onClick={(e) => e.stopPropagation()}>
        <div className="kc-sheet-grip" aria-hidden />
        <Row icon="reply" label="Reply" onClick={onReply} />
        {onPin && <Row icon="pin" label={msg.pinned ? "Unpin" : "Pin"} onClick={onPin} />}
        {onForward && <Row icon="forward" label="Forward" onClick={onForward} />}
        <Row icon="bookmark" label="Save" onClick={onSave} />
        {onHide && <Row icon="trash" label="Hide for me" onClick={onHide} />}
        {onReport && !isMine && <Row icon="flag" label="Report" onClick={onReport} danger />}
        {isMine && onEdit && <Row icon="edit" label="Edit" onClick={onEdit} />}
        {isMine && onDelete && <Row icon="trash" label="Delete" onClick={onDelete} danger />}
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className="kc-sheet-row"
      onClick={onClick}
      style={danger ? { color: "var(--danger)" } : undefined}
    >
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}
