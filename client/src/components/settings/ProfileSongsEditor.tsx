import { useEffect, useId, useRef, useState } from "react";
import type { ProfileSong } from "../../api";
import { safeHttpUrl } from "../../lib/url";

export function songError(song: ProfileSong): string | null {
  if (!song.title.trim()) return "Add a song title, or remove this song.";
  if (song.url?.trim() && (!/^https?:\/\//i.test(song.url.trim()) || !safeHttpUrl(song.url.trim()))) return "Use a full http:// or https:// link, or leave it blank.";
  return null;
}

/** Edits the parent's unsaved draft; never fetches metadata or saves on its own. */
export function ProfileSongsEditor({ songs, onChange }: { songs: ProfileSong[]; onChange: (songs: ProfileSong[]) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const id = useId();
  const editorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (editing !== null) editorRef.current?.querySelector<HTMLInputElement>(".kc-song-fields:not([hidden]) input")?.focus();
  }, [editing]);
  function update(index: number, patch: Partial<ProfileSong>) {
    onChange(songs.map((song, i) => i === index ? { ...song, ...patch } : song));
  }
  return (
    <section ref={editorRef} className="kc-song-editor" aria-labelledby={`${id}-heading`}>
      <div className="kc-profile-section-heading">
        <div><h3 id={`${id}-heading`}>Top songs</h3><p>Up to three favorites. Add a link so friends can listen.</p></div>
        <span className="kc-profile-count">{songs.length}/3</span>
      </div>
      {songs.length === 0 && <p className="kc-song-empty"><span aria-hidden="true">♫</span> What’s on repeat? Add your first song.</p>}
      <div className="kc-song-list">
        {songs.map((song, i) => {
          const expanded = editing === i;
          const error = songError(song);
          return <div className="kc-song-entry" key={i}>
            <div className="kc-song-heading">
              <span className="kc-song-number" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              <button type="button" className="kc-song-toggle" aria-expanded={expanded} aria-controls={`${id}-song-${i}`} onClick={() => setEditing(expanded ? null : i)}>
                <span className="kc-song-summary"><strong>{song.title.trim() || "New song"}</strong><span>{song.artist?.trim() || "Add an artist"}</span></span>
                <span className="kc-song-edit-label">{expanded ? "Close" : "Edit"}</span>
              </button>
              <button type="button" className="kc-song-remove" aria-label={`Remove song ${i + 1}${song.title ? `: ${song.title}` : ""}`} onClick={() => {
                onChange(songs.filter((_, index) => index !== i));
                setEditing(editing === i ? null : editing !== null && editing > i ? editing - 1 : editing);
              }}>×</button>
            </div>
            <div id={`${id}-song-${i}`} hidden={!expanded} className="kc-song-fields">
              <div className="kc-song-field-pair">
                <label>Song title<input value={song.title} maxLength={80} onChange={(e) => update(i, { title: e.target.value })} placeholder="e.g. Pink + White" aria-invalid={!song.title.trim()} aria-describedby={error ? `${id}-error-${i}` : undefined} /></label>
                <label>Artist <span>(optional)</span><input value={song.artist ?? ""} maxLength={80} onChange={(e) => update(i, { artist: e.target.value })} placeholder="e.g. Frank Ocean" /></label>
              </div>
              <label>Listen link <span>(optional)</span><input type="url" inputMode="url" value={song.url ?? ""} maxLength={240} onChange={(e) => update(i, { url: e.target.value })} placeholder="https://open.spotify.com/track/…" aria-invalid={Boolean(song.url?.trim() && (!/^https?:\/\//i.test(song.url.trim()) || !safeHttpUrl(song.url.trim())))} aria-describedby={error ? `${id}-error-${i}` : `${id}-hint-${i}`} /></label>
              <p id={`${id}-hint-${i}`} className="kc-profile-hint">Spotify, YouTube, SoundCloud, or another music link.</p>
            </div>
            {error && <p id={`${id}-error-${i}`} className="kc-song-error">{error}</p>}
          </div>;
        })}
      </div>
      {songs.length < 3 && <button type="button" className="kc-song-add" onClick={() => { onChange([...songs, { title: "", artist: "", url: "" }]); setEditing(songs.length); }}>+ Add a song</button>}
      <p className="kc-profile-hint">Changes are saved with your profile.</p>
    </section>
  );
}
