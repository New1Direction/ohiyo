// Discord import decisions for DiscordImportModal, kept pure for unit tests.
import type { DiscrawlImportCapability, DiscrawlImportRequest, ImportHistoryWindow } from "../api";

/** Which imports to offer: only what the capability route reports available to this user
 *  (it answers per caller; local and managed import are operator-only). Nothing while it
 *  hasn't answered or failed. The template link import needs no capability. */
export function importOptions(capability: DiscrawlImportCapability | null): { archive: boolean; managed: boolean } {
  return { archive: capability?.enabled === true, managed: capability?.managed_enabled === true };
}

/** The body for previewing or running a local Discrawl archive import. No media_root: the
 *  server ignores it on this route. */
export function discrawlRequest(fields: { dbPath: string; guildId: string; history: ImportHistoryWindow }): DiscrawlImportRequest {
  return {
    db_path: fields.dbPath.trim(),
    guild_id: fields.guildId.trim() || null,
    history: fields.history,
  };
}
