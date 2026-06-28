import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type HostedInstance, type SelfHostGuide } from "../api";
import { ModalShell } from "./ModalShell";
import { Icon } from "./Icon";

type Props = {
  token: string;
  onAddHome: (url: string) => void;
  onToast: (message: string, tone?: "success" | "error" | "info") => void;
  onClose: () => void;
};

const STATUS_COPY: Record<HostedInstance["status"], string> = {
  requested: "Queued",
  provisioning: "Building",
  healthy: "Awake",
  sleeping: "Sleeping",
  waking: "Waking",
  failed: "Failed",
  suspended: "Suspended",
};

function statusTone(status: HostedInstance["status"]) {
  if (status === "healthy") return "var(--green)";
  if (status === "sleeping" || status === "waking" || status === "provisioning") return "var(--warning)";
  if (status === "failed" || status === "suspended") return "var(--danger)";
  return "var(--text-muted)";
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function InstantServersModal({ token, onAddHome, onToast, onClose }: Props) {
  const [instances, setInstances] = useState<HostedInstance[]>([]);
  const [name, setName] = useState("My private community");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guide, setGuide] = useState<{ name: string; guide: SelfHostGuide } | null>(null);

  const freeCount = useMemo(() => instances.filter((i) => i.tier === "free" && i.status !== "failed").length, [instances]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInstances(await api.listInstances(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Instant Servers.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run<T>(key: string, fn: () => Promise<T>, after?: (value: T) => void) {
    setBusy(key);
    setError(null);
    try {
      const value = await fn();
      after?.(value);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Action failed.";
      setError(message);
      onToast(message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await run("create", () => api.createInstance(trimmed, token), (inst) => {
      onToast(`${inst.name} is being provisioned.`, "success");
      setName("");
    });
  }

  async function exportPack(inst: HostedInstance) {
    await run(`export:${inst.id}`, () => api.getInstanceExport(inst.id, token), (pack) => {
      downloadJson(`ohiyo-${inst.subdomain}-ownership-pack.json`, pack);
      onToast("Ownership pack downloaded.", "success");
    });
  }

  async function showGraduate(inst: HostedInstance) {
    await run(`graduate:${inst.id}`, () => api.getGraduateGuide(inst.id, token), (g) => setGuide({ name: inst.name, guide: g }));
  }

  async function billing(inst: HostedInstance) {
    await run(`billing:${inst.id}`, () => api.getBillingCheckout(inst.id, token), (checkout) => {
      window.open(checkout.checkout_url, "_blank", "noopener,noreferrer");
      onToast(checkout.mode === "operator" ? "Opened paid-tier request email." : "Opened checkout.", "info");
    });
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-instant-title" maxWidthClass="max-w-4xl">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: "var(--accent)" }}>Instant Servers</p>
            <h2 id="kc-instant-title" style={{ fontFamily: "var(--font-display)", fontWeight: 850, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}>
              Managed encrypted homes you can leave anytime
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--text-muted)" }}>
              Create a hosted Ohiyo server, sleep/wake it, download an ownership pack, graduate to self-host, or start the always-on paid tier. Control-plane data is infra metadata only — not message plaintext or E2E keys.
            </p>
          </div>
          <button type="button" onClick={refresh} className="kc-interactive rounded-full px-3 py-2 text-sm font-semibold" style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}>
            Refresh
          </button>
        </div>

        <form onSubmit={create} className="grid gap-3 rounded-3xl p-4 sm:grid-cols-[1fr_auto]" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)" }}>
          <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Create managed server
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="Community name"
              className="kc-field px-3.5 py-3 text-sm outline-none"
            />
          </label>
          <div className="flex flex-col justify-end gap-1">
            <button type="submit" disabled={!name.trim() || busy === "create"} className="kc-cta rounded-full px-5 py-3 text-sm" style={{ opacity: name.trim() && busy !== "create" ? 1 : 0.6 }}>
              {busy === "create" ? "Creating…" : "Create free server"}
            </button>
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{freeCount}/3 free managed servers used</span>
          </div>
        </form>

        {error && <div role="alert" className="rounded-2xl px-3 py-2 text-sm" style={{ background: "color-mix(in oklch, var(--danger) 12%, var(--bg-elevated))", color: "var(--danger)" }}>{error}</div>}

        {loading ? (
          <div className="rounded-3xl p-5 text-sm" style={{ background: "var(--bg-elevated)", color: "var(--text-muted)" }}>Loading Instant Servers…</div>
        ) : instances.length === 0 ? (
          <div className="rounded-3xl p-5 text-sm leading-6" style={{ background: "var(--bg-elevated)", color: "var(--text-muted)" }}>
            No managed homes yet. Create one above; it gets a <code className="rounded px-1" style={{ background: "var(--bg-input)" }}>*.ohiyo.gg</code> URL and remains exportable even on the free tier.
          </div>
        ) : (
          <div className="grid gap-3">
            {instances.map((inst) => (
              <div key={inst.id} className="rounded-3xl p-4" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)" }}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-bold" style={{ color: "var(--text-primary)" }}>{inst.name}</h3>
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: "color-mix(in oklch, var(--bg-input) 76%, transparent)", color: statusTone(inst.status) }}>{STATUS_COPY[inst.status]}</span>
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-bold uppercase" style={{ background: inst.tier === "paid" ? "color-mix(in oklch, var(--accent) 18%, var(--bg-input))" : "var(--bg-input)", color: inst.tier === "paid" ? "var(--accent)" : "var(--text-muted)" }}>{inst.tier === "paid" ? "Always-on" : "Free / sleeps"}</span>
                    </div>
                    <p className="mt-1 truncate text-sm" style={{ color: "var(--text-muted)" }}>{inst.public_url ?? `${inst.subdomain}.ohiyo.gg`}</p>
                    {inst.error && <p className="mt-1 text-xs" style={{ color: "var(--danger)" }}>{inst.error}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    {inst.public_url && (
                      <button type="button" onClick={() => onAddHome(inst.public_url!)} className="kc-cta rounded-full px-3 py-2 text-xs">Use in app</button>
                    )}
                    {inst.status === "sleeping" ? (
                      <button type="button" onClick={() => run(`wake:${inst.id}`, () => api.wakeInstance(inst.id, token), () => onToast("Server is awake.", "success"))} className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}>Wake</button>
                    ) : (
                      <button type="button" onClick={() => run(`sleep:${inst.id}`, () => api.sleepInstance(inst.id, token), () => onToast("Server is sleeping.", "success"))} className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}>Sleep</button>
                    )}
                    <button type="button" onClick={() => exportPack(inst)} className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}>Export</button>
                    <button type="button" onClick={() => showGraduate(inst)} className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}>Self-host</button>
                    <button type="button" onClick={() => billing(inst)} className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-input)", color: "var(--accent)", border: "none" }}>Billing</button>
                    {inst.tier !== "paid" && (
                      <button type="button" onClick={() => run(`paid:${inst.id}`, () => api.setInstanceTier(inst.id, "paid", token), () => onToast("Marked always-on for MVP/manual billing.", "success"))} className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "color-mix(in oklch, var(--accent) 16%, var(--bg-input))", color: "var(--accent)", border: "none" }}>Activate paid</button>
                    )}
                    <button type="button" onClick={() => { if (confirm(`Delete ${inst.name}? Export first if you need it.`)) void run(`delete:${inst.id}`, () => api.deleteInstance(inst.id, token), () => onToast("Instant Server deleted.", "success")); }} className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-input)", color: "var(--danger)", border: "none" }}><Icon name="trash" size={13} /> Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {guide && (
          <div className="rounded-3xl p-4" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)" }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-bold" style={{ color: "var(--text-primary)" }}>Graduate {guide.name} to self-host</h3>
                <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{guide.guide.docker_image}</p>
              </div>
              <button type="button" onClick={() => setGuide(null)} className="kc-interactive rounded-full px-3 py-1 text-xs" style={{ background: "var(--bg-input)", color: "var(--text-muted)", border: "none" }}>Close</button>
            </div>
            <pre className="mt-3 overflow-x-auto rounded-2xl p-3 text-xs" style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}>{guide.guide.one_liner}</pre>
            <ol className="mt-3 grid gap-1 pl-5 text-sm" style={{ color: "var(--text-muted)", listStyle: "decimal" }}>
              {guide.guide.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
