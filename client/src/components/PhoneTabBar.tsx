import type { Channel } from "../api";
import { Icon, type IconName } from "./Icon";

// The tab bar at the foot of the drawer on a phone: spaces, messages, mentions and you, each
// one tap away. It lives in the drawer (the list screen), so an open chat keeps its full height.

export type PhoneTab = "home" | "messages" | "mentions" | "you";

type Props = {
  active: PhoneTab;
  /** Unread direct and group messages. */
  dmUnread: number;
  /** Chats with an unread @mention of you. */
  mentionCount: number;
  onSelect: (tab: PhoneTab) => void;
};

const TABS: { tab: PhoneTab; label: string; icon: IconName }[] = [
  { tab: "home", label: "Home", icon: "home" },
  { tab: "messages", label: "Messages", icon: "chat" },
  { tab: "mentions", label: "Mentions", icon: "at" },
  { tab: "you", label: "You", icon: "user" },
];

export function PhoneTabBar({ active, dmUnread, mentionCount, onSelect }: Props) {
  const count = (tab: PhoneTab) => (tab === "messages" ? dmUnread : tab === "mentions" ? mentionCount : 0);
  const name = (tab: PhoneTab, label: string) => {
    const n = count(tab);
    if (n <= 0) return label;
    return tab === "messages" ? `${label}, ${n} unread` : `${label}, ${n}`;
  };
  return (
    <nav aria-label="Main" className="kc-phone-tabs">
      {TABS.map(({ tab, label, icon }) => {
        const n = count(tab);
        return (
          <button
            key={tab}
            type="button"
            className="kc-phone-tab kc-interactive"
            aria-label={name(tab, label)}
            aria-current={active === tab ? "page" : undefined}
            onClick={() => onSelect(tab)}
          >
            <span className="kc-phone-tab-icon">
              <Icon name={icon} size={22} />
              {n > 0 && <span className="kc-phone-tab-badge" aria-hidden>{n > 9 ? "9+" : n}</span>}
            </span>
            <span className="kc-phone-tab-label" aria-hidden>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

type MentionItem = { channel: Channel; label: string; where: string; count: number };

/** The Mentions tab: chats with an unread @mention of you, newest first as the app knows them. */
export function MentionsInbox({ items, onOpen }: { items: MentionItem[]; onOpen: (channel: Channel) => void }) {
  return (
    <section className="kc-mentions-inbox" aria-labelledby="kc-mentions-title">
      <h2 id="kc-mentions-title" className="kc-mentions-title">Mentions</h2>
      {items.length === 0 ? (
        <p className="kc-mentions-empty">No mentions waiting. When someone @mentions you, the chat shows up here.</p>
      ) : (
        <ul className="kc-mentions-list">
          {items.map((item) => (
            <li key={item.channel.id}>
              <button type="button" className="kc-mentions-item kc-interactive" onClick={() => onOpen(item.channel)}>
                <span className="kc-mentions-item-name">{item.label}</span>
                <span className="kc-mentions-item-where">{item.where}</span>
                {item.count > 0 && <span className="kc-phone-tab-badge kc-mentions-item-count">{item.count > 99 ? "99+" : item.count}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
