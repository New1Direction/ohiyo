import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { SearchModal, type SearchHit } from "../../src/components/SearchModal";
import type { Channel, Message, PublicUser, SearchPage } from "../../src/api";
export { act };

const user = (id: string, username: string, display_name: string): PublicUser => ({ id, username, display_name, avatar_url: null });
const ALICE = user("u1", "alice", "Alice Doe");
const BOB = user("u2", "bob", "Bobby");
const channel = (id: string, name: string): Channel => ({
  id,
  server_id: "s1",
  name,
  channel_type: "text",
  position: 0,
  topic: null,
  created_at: 0,
});
const CHANNELS = [channel("c1", "general"), channel("c2", "random")];
const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime() / 1000;

const msg = (id: string, channel_id: string, author: PublicUser, content: string, ago: number): Message => ({
  id,
  channel_id,
  author,
  content,
  created_at: NOW - ago,
  edited_at: null,
});

/** The answers the fake server gives, by query text. */
const PAGES: Record<string, SearchPage> = {
  deploy: {
    messages: [
      msg("m1", "c1", ALICE, "Deploy failed on staging", 60),
      msg("m2", "t1", BOB, "deploy fixed in the thread", 120),
      msg("m3", "c2", BOB, "another deploy", 3600),
    ],
    total: 3,
    total_capped: false,
    offset: 0,
    limit: 25,
    channels: [
      { id: "c1", name: "general", parent_id: null, parent_name: null },
      { id: "t1", name: "Rollout", parent_id: "c1", parent_name: "general" },
      { id: "c2", name: "random", parent_id: null, parent_name: null },
    ],
  },
  many: {
    messages: [msg("m9", "c1", ALICE, "many things", 10)],
    total: 100,
    total_capped: true,
    offset: 0,
    limit: 25,
    channels: [{ id: "c1", name: "general", parent_id: null, parent_name: null }],
  },
  nothing: { messages: [], total: 0, total_capped: false, offset: 0, limit: 25, channels: [] },
};

/** The search sheet for one space, answered by a fake server, with every call recorded. */
export function mountSearchModal(element: HTMLElement) {
  const queries: string[] = [];
  const jumps: SearchHit[] = [];
  let closed = 0;
  const search = async (q: string): Promise<SearchPage> => {
    queries.push(q);
    if (q === "broken") throw new Error("offline");
    return PAGES[q] ?? PAGES.nothing;
  };
  const root = createRoot(element);
  act(() =>
    root.render(
      <SearchModal
        channels={CHANNELS}
        members={[ALICE, BOB]}
        search={search}
        now={() => NOW * 1000}
        onJumpToMessage={(hit) => jumps.push(hit)}
        onClose={() => {
          closed += 1;
        }}
      />,
    ),
  );
  return {
    queries,
    jumps,
    closed: () => closed,
    unmount: () => act(() => root.unmount()),
  };
}
