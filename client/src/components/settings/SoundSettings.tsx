// Settings → Notifications → Sounds: on or off, which sound, how loud, and what makes one.
// Kept on this device, like Discord's sound settings.
import { useState } from "react";
import {
  loadSoundPrefs,
  playSound,
  saveSoundPrefs,
  SOUNDS,
  type SoundId,
  type SoundMode,
  type SoundPrefs,
} from "../../lib/notificationSounds";

export function SoundSettings() {
  const [prefs, setPrefs] = useState<SoundPrefs>(() => loadSoundPrefs());

  function update(next: SoundPrefs) {
    setPrefs(next);
    saveSoundPrefs(next);
  }

  return (
    <section
      className="mb-6 rounded-lg p-4"
      style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}
      aria-labelledby="kc-sounds-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div id="kc-sounds-title" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Sounds
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            Never for your own messages, muted chats, or the chat you&apos;re looking at.
          </p>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(e) => update({ ...prefs, enabled: e.target.checked })}
          />
          Play sounds
        </label>
      </div>

      {prefs.enabled && (
        <div className="mt-4 grid gap-4">
          <fieldset>
            <legend className="mb-2 text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
              Play a sound for
            </legend>
            {([
              ["dms-mentions", "DMs and @mentions"],
              ["all", "Everything I'd be notified about"],
            ] as [SoundMode, string][]).map(([mode, label]) => (
              <label key={mode} className="flex min-h-11 items-center gap-2 text-sm" style={{ color: "var(--text-primary)" }}>
                <input type="radio" name="kc-sound-mode" checked={prefs.mode === mode} onChange={() => update({ ...prefs, mode })} />
                {label}
              </label>
            ))}
          </fieldset>

          <div>
            <div className="mb-2 text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
              Sound
            </div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Sound">
              {SOUNDS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={prefs.sound === s.id}
                  onClick={() => {
                    update({ ...prefs, sound: s.id as SoundId });
                    playSound(s.id, prefs.volume);
                  }}
                  className="kc-interactive min-h-11 rounded-full px-4 text-sm font-semibold"
                  style={{
                    background: prefs.sound === s.id ? "var(--accent)" : "var(--bg-input)",
                    color: prefs.sound === s.id ? "white" : "var(--text-secondary)",
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <label className="grid gap-2 text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
            Volume
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(prefs.volume * 100)}
              aria-label="Sound volume"
              onChange={(e) => update({ ...prefs, volume: Number(e.target.value) / 100 })}
              onPointerUp={() => playSound(prefs.sound, prefs.volume)}
              onKeyUp={() => playSound(prefs.sound, prefs.volume)}
              style={{ maxWidth: 320 }}
            />
          </label>
        </div>
      )}
    </section>
  );
}
