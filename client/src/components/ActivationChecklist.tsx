import { activationCompletedCount, type ActivationState } from "../lib/activation";

const ITEMS: Array<{ key: keyof ActivationState; label: string; help: string }> = [
  { key: "account", label: "Create your account", help: "You’re signed in and ready." },
  { key: "server", label: "Create your first space", help: "A #general chat and voice room are seeded." },
  { key: "message", label: "Send the first message", help: "Make the room feel alive." },
  { key: "invite", label: "Invite one person", help: "Copy a share link for your crew." },
  { key: "call", label: "Try the voice room", help: "Join muted if you’re just testing." },
];

type Props = {
  state: ActivationState;
  serverName?: string | null;
  onInvite?: () => void;
  onJoinVoice?: () => void;
  onDismiss: () => void;
};

export function ActivationChecklist({ state, serverName, onInvite, onJoinVoice, onDismiss }: Props) {
  const done = activationCompletedCount(state);
  const total = ITEMS.length;
  const pct = Math.round((done / total) * 100);
  const allDone = done === total;

  return (
    <section className="kc-activation-card" aria-label="Owner launch checklist">
      <div className="kc-activation-card__head">
        <div>
          <div className="kc-activation-eyebrow">Owner launch checklist</div>
          <h3>{allDone ? "Your space is alive 🎉" : `Launch ${serverName || "your space"}`}</h3>
        </div>
        <button type="button" className="kc-activation-dismiss kc-interactive" onClick={onDismiss} aria-label="Hide owner launch checklist">×</button>
      </div>
      <p>{allDone ? "Nice — you’ve completed the first-user funnel." : "Five tiny steps to turn an empty room into a real community."}</p>
      <div className="kc-activation-progress" aria-label={`${done} of ${total} setup steps complete`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol className="kc-activation-list">
        {ITEMS.map((item) => {
          const complete = Boolean(state[item.key]);
          return (
            <li key={item.key} className={complete ? "is-complete" : undefined}>
              <span className="kc-activation-check" aria-hidden="true">{complete ? "✓" : ""}</span>
              <div>
                <strong>{item.label}</strong>
                <small>{item.help}</small>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="kc-activation-actions">
        {onInvite && !state.invite && (
          <button type="button" className="kc-interactive" onClick={onInvite}>Invite someone</button>
        )}
        {onJoinVoice && !state.call && (
          <button type="button" className="kc-interactive" onClick={onJoinVoice}>Try voice</button>
        )}
      </div>
      <div className="kc-activation-privacy">Stored locally on this device — not analytics.</div>
    </section>
  );
}
