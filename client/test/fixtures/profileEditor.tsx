import { useState } from "react";
import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileSongsEditor, songError } from "../../src/components/settings/ProfileSongsEditor";
import { ProfileCardView, type ProfileCardData } from "../../src/components/ProfileCardView";
import type { ProfileSong } from "../../src/api";
export { act, songError };
export function mountSongs(element: HTMLElement, initial: ProfileSong[] = []) {
  const root = createRoot(element);
  function Fixture() {
    const [songs, setSongs] = useState(initial);
    return <><ProfileSongsEditor songs={songs} onChange={setSongs} /><output>{JSON.stringify(songs)}</output></>;
  }
  act(() => root.render(<Fixture />));
  return () => act(() => root.unmount());
}
export function renderCard(songs: ProfileSong[], preview = false) {
  const data: ProfileCardData = { display_name: "A very long name".repeat(8), username: "username", banner_color: "#ff7a45", banner_url: null, custom_status: "hello", bio: "bio", avatar_url: null, last_active_at: null, profile_theme: {}, top_songs: songs, social_github: null, social_twitter: null, social_youtube: null, social_twitch: null, social_steam: null, social_spotify: null };
  return renderToStaticMarkup(<ProfileCardView data={data} preview={preview} />);
}
