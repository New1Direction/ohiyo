import { useEffect, useState } from "react";
import { getDesktopPrefs, getOpenAtLogin, setKeepRunning, setOpenAtLogin } from "../../lib/desktopShell";

type Props = {
  onToast: (text: string, type?: "info" | "success" | "error") => void;
};

type RowProps = {
  name: string;
  hint: string;
  /** Null until the shell has answered. */
  isOn: boolean | null;
  onToggle: () => void;
};

function SwitchRow({ name, hint, isOn, onToggle }: RowProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{name}</div>
        <div className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>{hint}</div>
      </div>
      <button type="button" role="switch" aria-checked={isOn === true} aria-label={name} disabled={isOn === null} onClick={onToggle} className="kc-switch">
        <span className="kc-switch__knob" />
      </button>
    </div>
  );
}

/** The two switches only the desktop app has. Shown inside Settings → Notifications. */
export function DesktopAppCard({ onToast }: Props) {
  const [keepRunning, setKeepRunningState] = useState<boolean | null>(null);
  const [openAtLogin, setOpenAtLoginState] = useState<boolean | null>(null);

  useEffect(() => {
    let isCurrent = true;
    void getDesktopPrefs().then((prefs) => {
      if (isCurrent && prefs) setKeepRunningState(prefs.keep_running);
    });
    void getOpenAtLogin().then((on) => {
      if (isCurrent) setOpenAtLoginState(on);
    });
    return () => {
      isCurrent = false;
    };
  }, []);

  async function toggleKeepRunning() {
    const prefs = await setKeepRunning(!keepRunning);
    if (!prefs) {
      onToast("Couldn't save that setting.", "error");
      return;
    }
    setKeepRunningState(prefs.keep_running);
  }

  async function toggleOpenAtLogin() {
    const wanted = !openAtLogin;
    const now = await setOpenAtLogin(wanted);
    setOpenAtLoginState(now);
    if (now !== wanted) onToast("Your system didn't allow that change.", "error");
  }

  return (
    <div className="mb-6 grid gap-4 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
      <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Desktop app</div>
      <SwitchRow
        name="Keep running when I close the window"
        hint="Ohiyo stays in the tray, so notifications keep arriving. Opening Ohiyo again brings the window back; quit from the tray menu."
        isOn={keepRunning}
        onToggle={() => void toggleKeepRunning()}
      />
      <SwitchRow
        name="Open Ohiyo when I log in"
        hint="Starts Ohiyo with your computer."
        isOn={openAtLogin}
        onToggle={() => void toggleOpenAtLogin()}
      />
    </div>
  );
}
