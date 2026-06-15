import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../../api";
import { deviceId } from "../../lib/signal";

type Device = { device_id: number; updated_at: number };

const groupCode = (code: string) => (code.match(/.{1,4}/g) ?? [code]).join("-");

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

  // Device-link code (this device acts as the primary that authorizes a new one).
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [linkExpiry, setLinkExpiry] = useState<number>(0);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [linkBusy, setLinkBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listDevices(token)
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [token]);
  useEffect(() => load(), [load]);

  // Live countdown; clear the code when it expires.
  useEffect(() => {
    if (!linkCode) return;
    const tick = () => {
      const left = Math.max(0, linkExpiry - Math.floor(Date.now() / 1000));
      setSecondsLeft(left);
      if (left === 0) setLinkCode(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [linkCode, linkExpiry]);

  async function startLink() {
    setLinkBusy(true);
    try {
      const { code, expires_at } = await api.startDeviceLink(token);
      setLinkCode(code);
      setLinkExpiry(expires_at);
      load(); // a freshly-linked device will show up after it redeems
    } catch {
      onToast("Couldn't start device linking — try again", "error");
    } finally {
      setLinkBusy(false);
    }
  }

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

      {/* Link a new device with a QR / code — no password re-entry on the new device. */}
      {linkCode ? (
        <div
          className="mb-3 rounded-md p-3 text-center"
          style={{ background: "color-mix(in oklch, var(--accent) 8%, transparent)", border: "1px solid var(--accent)" }}
        >
          <div className="mb-2 text-xs font-bold uppercase" style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>
            Scan or enter on the new device
          </div>
          <div className="mb-2 inline-block rounded-md bg-white p-2">
            <QRCodeSVG value={`${location.origin}/?link=${linkCode}`} size={132} marginSize={0} />
          </div>
          <code
            className="block font-mono text-base font-bold tracking-widest"
            style={{ color: "var(--text-primary)" }}
          >
            {groupCode(linkCode)}
          </code>
          <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            On the new device, choose <strong>Link a device</strong> on the sign-in screen. Expires in{" "}
            <strong>{secondsLeft}s</strong>.
          </p>
          <button
            type="button"
            onClick={() => setLinkCode(null)}
            className="mt-2 rounded px-3 py-1 text-xs font-semibold"
            style={{ color: "var(--text-secondary)", background: "var(--bg-hover)" }}
          >
            Done
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={linkBusy}
          onClick={startLink}
          className="mb-3 rounded-md px-3 py-1.5 text-xs font-semibold"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          🔗 Link a device
        </button>
      )}

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
