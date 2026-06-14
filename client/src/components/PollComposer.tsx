import { useState } from "react";
import { api } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  channelId: string;
  onClose: () => void;
  onError: (msg: string) => void;
};

const MAX_OPTIONS = 10;

/** Compose a poll: a question, 2–10 options, optional multi-select. */
export function PollComposer({ token, channelId, onClose, onError }: Props) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);

  const setOption = (i: number, v: string) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? v : o)));
  const addOption = () => setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ""] : prev));
  const removeOption = (i: number) => setOptions((prev) => prev.filter((_, idx) => idx !== i));

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const canCreate = question.trim().length > 0 && filled.length >= 2 && !busy;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    try {
      await api.createPoll(token, channelId, question.trim(), filled, { multi });
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't create the poll.");
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-poll-title">
      <h2
        id="kc-poll-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        📊 New poll
      </h2>

      <form onSubmit={handleCreate} className="mt-4 flex flex-col gap-3">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask something… (e.g. Where do we eat?)"
          aria-label="Poll question"
          maxLength={200}
          className="kc-field w-full px-3.5 py-2.5 text-sm outline-none"
        />

        <div className="flex flex-col gap-2">
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={o}
                onChange={(e) => setOption(i, e.target.value)}
                placeholder={`Option ${i + 1}`}
                aria-label={`Poll option ${i + 1}`}
                maxLength={100}
                className="kc-field flex-1 px-3 py-2 text-sm outline-none"
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  aria-label={`Remove option ${i + 1}`}
                  className="kc-interactive flex-shrink-0 px-2"
                  style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button
              type="button"
              onClick={addOption}
              className="kc-interactive self-start text-sm font-semibold"
              style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
            >
              + Add option
            </button>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
          Allow voting for multiple options
        </label>

        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="kc-interactive px-4 py-2.5 text-sm font-semibold"
            style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="kc-cta flex-1 py-2.5 text-sm"
            style={{ opacity: canCreate ? 1 : 0.65 }}
          >
            {busy ? "Creating…" : "Launch poll"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
