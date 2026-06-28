# Discord template migration

A community can die in transit if admins have to rebuild categories, channels, roles, and assets by hand. Ohiyo now has a one-command migration path for Discord Server Template links.

## One command

```bash
OHIYO_TOKEN=<owner-jwt> \
  E2E_API=https://ohiyo.fly.dev/api/v1 \
  scripts/migrate-discord-template.mjs https://discord.new/<template-code>
```

Do not paste the token into chat. Use a short-lived signed-in owner token from the target Ohiyo home.

The command calls:

```http
POST /api/v1/imports/discord/template
Authorization: Bearer <owner-jwt>
Content-Type: application/json

{ "template": "https://discord.new/<template-code>" }
```

## What is reconstructed

- Server name and icon, when the template exposes an icon hash/URL.
- Category hierarchy and positions.
- Text/announcement/forum channels as Ohiyo text channels.
- Voice channels as Ohiyo voice channels.
- Channel topics.
- Roles, colors, hierarchy positions, and Discord role identifiers.
- Best-effort server-level permission equivalents:
  - Administrator → all current Ohiyo permissions.
  - Manage Channels → `MANAGE_CHANNELS`.
  - Manage Messages → `MANAGE_MESSAGES`.
  - Kick Members → `KICK_MEMBERS`.
  - Ban Members → `BAN_MEMBERS`.
  - Manage Roles → `MANAGE_ROLES`.
  - Manage Server → `MANAGE_SERVER`.
- Granular Discord channel permission overwrites are preserved in `discord_import_permission_overwrites` for audit/replay. Ohiyo does not yet enforce Discord-style channel overwrites, so roles with source permissions are flagged for review.
- Custom emojis are downloaded into Ohiyo files and created as server emojis when Discord includes them in the template payload.

## What is intentionally not imported from templates

Discord Server Templates do not carry message history. Use the managed bot/Discrawl importer when you need archive history and attachments.

## Operator checklist

1. Create or fetch a Discord Server Template link from the source server.
2. Run the command above against the target Ohiyo home.
3. Open the new Ohiyo space.
4. Review the import report:
   - roles needing review;
   - preserved channel overwrites;
   - parked assets or unsupported Discord-only features.
5. Invite the community only after roles/channel visibility have been checked.

## Privacy boundary

Template migration imports structure and public-ish community assets. It does not claim anonymity or SimpleX-level metadata privacy. Migrated Ohiyo-native content can use E2E; Discord template structure and imported assets are operational metadata needed to make the community feel familiar immediately.
