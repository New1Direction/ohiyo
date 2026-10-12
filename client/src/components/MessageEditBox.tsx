// The box a message is edited in, under the message it replaces.
import { enterAction, hasFinePointer } from "../lib/composerKeys";

const LINK = { color: "var(--accent)", background: "none", border: "none", cursor: "pointer" } as const;

export function MessageEditBox({
  value, onChange, onSave, onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // A phone has no Escape or Shift key: there the hint is just the two buttons.
  const keyboard = hasFinePointer();
  const cancel = <button type="button" onClick={onCancel} className="kc-interactive" style={LINK}>cancel</button>;
  const save = <button type="button" onClick={onSave} className="kc-interactive" style={LINK}>save</button>;
  return (
    <div className="mt-0.5">
      <textarea
        // eslint-disable-next-line jsx-a11y/no-autofocus -- inline message editor opens on user action; focusing immediately is expected
        autoFocus
        value={value}
        aria-label="Edit message"
        rows={Math.min(8, value.split("\n").length)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter saves with a keyboard (Shift+Enter starts a new line, so a message keeps its
          // line breaks); on a touch screen Enter starts a new line and "save" saves.
          if (e.key === "Enter") {
            const action = enterAction({ shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, hasFinePointer());
            if (action === "send") {
              e.preventDefault();
              onSave();
            }
          } else if (e.key === "Escape") onCancel();
        }}
        className="kc-field kc-edit-input w-full px-2.5 py-1.5 text-sm outline-none"
      />
      <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        {keyboard ? (
          <>
            escape to {cancel}
            {" · "}enter to {save}
            {" · "}shift+enter for a new line
          </>
        ) : (
          <>
            {cancel}
            {" · "}
            {save}
          </>
        )}
      </div>
    </div>
  );
}
