import { useEffect, useId, useState } from "react";
import { ModalShell } from "../ModalShell";
import type { BanEntry } from "../../api";
import { errorText } from "./errorText";
import "./moderation.css";

export type { BanEntry };

const bannedOn = (at: number) =>
  new Date(at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Who is banned from the space, by whom, when and why, with a way to lift each ban. */
export function BansDialog({
  api,
  onClose,
}: {
  api: { list: () => Promise<BanEntry[]>; unban: (userId: string) => Promise<void> };
  onClose: () => void;
}) {
  const [bans, setBans] = useState<BanEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    let alive = true;
    api
      .list()
      .then((rows) => alive && setBans(rows))
      .catch((err) => alive && setError(errorText(err, "Couldn't load the ban list.")));
    return () => {
      alive = false;
    };
    // The list loads once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function unban(entry: BanEntry) {
    if (busyId) return;
    setBusyId(entry.user.id);
    setError(null);
    try {
      await api.unban(entry.user.id);
      setBans((rows) => (rows ?? []).filter((row) => row.user.id !== entry.user.id));
    } catch (err) {
      setError(errorText(err, `Couldn't lift the ban on ${entry.user.display_name}.`));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId} maxWidthClass="max-w-lg">
      <h2 id={titleId} className="kc-mod-title">
        Bans
      </h2>
      <p className="kc-mod-lede">People banned here can&apos;t rejoin, even with an invite. Lifting a ban lets them join again with a link.</p>
      {error && (
        <p role="alert" className="kc-mod-error">
          {error}
        </p>
      )}
      {bans === null ? (
        !error && <div className="kc-skeleton mt-4" style={{ height: 64 }} aria-hidden="true" />
      ) : bans.length === 0 ? (
        <p className="kc-mod-empty">Nobody is banned.</p>
      ) : (
        <ul className="kc-mod-list" aria-label="Banned people">
          {bans.map((entry) => (
            <li key={entry.user.id} className="kc-mod-row">
              <span className="kc-mod-initial" aria-hidden="true">
                {(entry.user.display_name[0] ?? "?").toUpperCase()}
              </span>
              <div className="kc-mod-row__body">
                <div className="kc-mod-row__name">
                  {entry.user.display_name}{" "}
                  <span className="kc-mod-row__meta" style={{ fontWeight: 500 }}>
                    @{entry.user.username}
                  </span>
                </div>
                <div className="kc-mod-row__meta">
                  Banned by {entry.banned_by_name ?? "a deleted account"} · {bannedOn(entry.banned_at)}
                </div>
                {entry.reason && <p className="kc-mod-row__reason">{entry.reason}</p>}
              </div>
              <button
                type="button"
                aria-label={`Unban ${entry.user.display_name}`}
                disabled={busyId === entry.user.id}
                onClick={() => void unban(entry)}
                className="kc-interactive kc-polish-button kc-mod-button kc-mod-button--small"
              >
                Unban
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="kc-mod-actions">
        <button type="button" onClick={onClose} className="kc-interactive kc-polish-button kc-mod-button">
          Done
        </button>
      </div>
    </ModalShell>
  );
}
