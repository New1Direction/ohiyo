import type { ServerWithChannels } from "../api";
import { Icon } from "./Icon";

type Props = {
  servers: ServerWithChannels[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateServer: () => void;
  onOpenSettings: () => void;
  onOpenSaved?: () => void;
  unreadServerIds?: Set<string>;
};

function ServerIcon({
  server,
  isSelected,
  hasUnread,
  onClick,
}: {
  server: ServerWithChannels;
  isSelected: boolean;
  hasUnread: boolean;
  onClick: () => void;
}) {
  const initials = server.name
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={server.name}
      className="relative flex w-full justify-center"
      style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
    >
      {/* Active / unread indicator pill */}
      <div
        className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full transition-all duration-150"
        style={{
          background: "var(--text-primary)",
          width: 4,
          height: isSelected ? 36 : hasUnread ? 20 : 8,
          opacity: isSelected || hasUnread ? 1 : 0.55,
        }}
      />
      {hasUnread && !isSelected && (
        <span
          className="absolute"
          style={{
            right: 4, top: 4, width: 12, height: 12, borderRadius: "var(--radius-full)",
            background: "var(--accent)", border: "2.5px solid var(--bg-base)",
          }}
        />
      )}
      <div
        className="kc-rail-icon flex h-12 w-12 cursor-pointer items-center justify-center text-sm font-bold"
        data-selected={isSelected ? "1" : undefined}
        title={server.name}
      >
        {server.icon_url ? (
          <img src={server.icon_url} alt={server.name} className="h-full w-full rounded-full object-cover" />
        ) : (
          initials || "?"
        )}
      </div>
    </button>
  );
}

export function ServerSidebar({ servers, selectedId, onSelect, onCreateServer, onOpenSettings, onOpenSaved, unreadServerIds }: Props) {
  return (
    <div
      className="flex w-[72px] flex-shrink-0 flex-col items-center gap-2 py-3"
      style={{ background: "var(--bg-base)" }}
    >
      {/* DMs / Home button */}
      <button
        type="button"
        className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full text-xl transition-all duration-150 hover:rounded-[30%]"
        style={{ background: selectedId === null ? "var(--accent)" : "var(--bg-sidebar)", borderRadius: selectedId === null ? "30%" : "50%", border: "none" }}
        onClick={() => onSelect("")}
        title="Direct Messages"
        aria-label="Direct Messages"
      >
        <Icon name="chat" size={22} />
      </button>

      <div className="w-8 border-t my-1" style={{ borderColor: "var(--bg-hover)" }} />

      {servers.map((s) => (
        <ServerIcon
          key={s.id}
          server={s}
          isSelected={selectedId === s.id}
          hasUnread={unreadServerIds?.has(s.id) ?? false}
          onClick={() => onSelect(s.id)}
        />
      ))}

      {/* Add server */}
      <button
        type="button"
        className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full text-xl font-bold transition-all duration-150 hover:rounded-[30%]"
        style={{ background: "var(--bg-sidebar)", color: "var(--green)", border: "none" }}
        onClick={onCreateServer}
        title="Add a Server"
        aria-label="Add a server"
      >
        +
      </button>

      <div className="flex-1" />

      {/* Saved messages */}
      {onOpenSaved && (
        <button
          type="button"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-lg transition-opacity hover:opacity-100"
          style={{ color: "var(--text-muted)", opacity: 0.6, background: "none", border: "none" }}
          onClick={onOpenSaved}
          title="Saved messages"
          aria-label="Saved messages"
        >
          <Icon name="bookmark" size={18} />
        </button>
      )}

      {/* Settings */}
      <button
        type="button"
        className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-lg transition-opacity hover:opacity-100"
        style={{ color: "var(--text-muted)", opacity: 0.6, background: "none", border: "none" }}
        onClick={onOpenSettings}
        title="Settings (Ctrl+,)"
        aria-label="Settings"
      >
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}
