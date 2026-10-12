// The box a message is edited in, under the message it replaces.

export function MessageEditBox({
  value, onChange, onSave, onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
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
          // Enter saves; Shift+Enter starts a new line, so a message keeps its line breaks.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSave(); }
          else if (e.key === "Escape") onCancel();
        }}
        className="kc-field kc-edit-input w-full px-2.5 py-1.5 text-sm outline-none"
      />
      <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        escape to{" "}
        <button type="button" onClick={onCancel} className="kc-interactive" style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>cancel</button>
        {" · "}enter to{" "}
        <button type="button" onClick={onSave} className="kc-interactive" style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>save</button>
        {" · "}shift+enter for a new line
      </div>
    </div>
  );
}
