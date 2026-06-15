import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { deviceId } from "../../lib/signal";

type Device = { device_id: number; updated_at: number };

function lastActive(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Linked-devices manager: lists this account's registered Signal devices and lets you
 *  revoke any but the one you're on. Verifying a contact's safety number now covers all
 *  of their devices, so seeing (and pruning) your own device set matters. */
export function LinkedDevices({
  token,
  onToast,
}: {
  token: string;
  onToast: (t: string, type?: "info" | "success" | "error") => void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const thisDevice = deviceId();

  const load = useCallback(() => {
    api
      .listDevices(token)
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [token]);
  useEffect(() => load(), [load]);

  async function revoke(id: number) {
    setBusy(id);
    try {
      await api.removeDevice(token, id);
      setDevices((d) => (d ?? []).filter((x) => x.device_id !== id));
      onToast("Device removed", "success");
    } catch {
      onToast("Couldn't remove that device — try again", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
      <div className="mb-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        📱 Linked devices
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Every device you&apos;ve signed in on has its own encryption key. Verifying a contact covers all of
        their devices. Remove a device you no longer use — new messages won&apos;t be encrypted to it.
      </p>

      {devices === null ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Loading…
        </div>
      ) : devices.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          No devices registered yet — encryption sets up the first time you open an encrypted chat.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {devices.map((d) => {
            const isThis = d.device_id === thisDevice;
            return (
              <li
                key={d.device_id}
                className="flex items-center gap-3 rounded-md px-3 py-2"
                style={{ background: "var(--bg-channel)" }}
              >
                <span className="text-base" aria-hidden>
                  💻
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                    Device #{d.device_id}
                    {isThis && (
                      <span className="ml-2 text-xs font-semibold" style={{ color: "var(--accent)" }}>
                        this device
                      </span>
                    )}
                  </span>
                  <span className="block text-xs" style={{ color: "var(--text-muted)" }}>
                    Active {lastActive(d.updated_at)}
                  </span>
                </span>
                {!isThis && (
                  <button
                    type="button"
                    disabled={busy === d.device_id}
                    onClick={() => revoke(d.device_id)}
                    className="rounded px-2.5 py-1 text-xs font-semibold"
                    style={{
                      color: "var(--danger)",
                      background: "color-mix(in oklch, var(--danger) 12%, transparent)",
                      border: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
