# Ohiyo Discord Import — Beginner Live Smoke Test

This is the checklist to prove the customer flow works before showing it to anyone.

Goal: a normal user should be able to do this flow:

1. Open Ohiyo.
2. Click **Import Discord**.
3. Click **Add Ohiyo to Discord**.
4. Come back and click **Find my servers**.
5. Pick a server card.
6. Click **Clone selected server**.
7. Land in the imported Ohiyo space.

No customer should ever see bot tokens, database paths, Discrawl paths, or GitHub release pages.

---

## Part 1 — Create the tiny Discord test server

Do this in Discord first.

1. Create a new Discord server named something obvious, like `Ohiyo Import Test`.
2. Add 2–3 text channels:
   - `#general`
   - `#photos`
   - `#announcements`
3. Add 1 voice channel:
   - `Lounge`
4. Send a few test messages in each text channel.
5. Add one image/file attachment if you want to test attachments.
6. Optional: pin one message and add a few reactions.

Keep this server small for the first smoke test. Use **Last 90 days** first if you want the fastest proof.

---

## Part 2 — Create/configure the Discord bot

Do this once in the Discord Developer Portal.

1. Go to <https://discord.com/developers/applications>.
2. Create or open the Ohiyo application.
3. Go to **Bot**.
4. Copy the **bot token**. Treat it like a password.
5. Turn on these privileged intents:
   - **Server Members Intent**
   - **Message Content Intent**
6. Go to **OAuth2** and copy the **Client ID**.

The bot only needs read permissions for import:

- View Channels
- Read Message History

Ohiyo uses permission integer `66560` by default.

---

## Part 3 — Set private server secrets

Set these only on the Ohiyo server/deployment. Do **not** put them in the browser app.

Required:

```bash
OHIYO_ENABLE_MANAGED_DISCORD_IMPORT=true
OHIYO_DISCORD_CLIENT_ID=<discord application client id>
DISCORD_BOT_TOKEN=<discord bot token>
OHIYO_DISCRAWL_BIN=/usr/local/bin/discrawl
```

For a Docker/Fly-style deployment, `/usr/local/bin/discrawl` is correct because the Docker image now bundles Discrawl.

If testing locally without Docker, make sure this works first:

```bash
discrawl version
```

Then set:

```bash
OHIYO_DISCRAWL_BIN=$(which discrawl)
```

Restart the Ohiyo server after setting secrets.

---

## Part 4 — Preflight checks before clicking around

After the server restarts:

1. Open Ohiyo.
2. Open **Import Discord**.
3. Expected: you should see the friendly **Move your Discord into Ohiyo** wizard.
4. Expected: the first card, **Add Ohiyo to Discord**, should be clickable.
5. If you see **Discord move-in is not ready here yet**, the server secrets are not active or the server was not restarted.

If you have API access, this endpoint should say managed import is enabled:

```bash
curl -H "Authorization: Bearer <your token>" \
  https://<your-ohiyo-server>/api/v1/imports/discord/capability
```

Expected shape:

```json
{
  "enabled": false,
  "managed_enabled": true,
  "mode": "managed_discord_connect",
  "message": "This home can connect to Discord and clone a server directly."
}
```

`enabled` can be `false`; that only means the old local archive fallback is off. For the customer flow, `managed_enabled` must be `true`.

---

## Part 5 — Run the actual customer smoke test

In Ohiyo:

1. Click **Import Discord**.
2. Click **Add Ohiyo to Discord**.
3. Discord opens.
4. Choose the tiny test server.
5. Click **Continue**.
6. Click **Authorize**.
7. Return to Ohiyo.
8. Click **Find my servers**.
9. Expected: your server appears as a card.
10. Click the server card.
11. Choose **Last 90 days** for the first smoke test.
12. Click **Clone selected server**.

Expected progress messages:

- Queued
- Preparing the Discord clone workspace
- Copying channels, messages, and attachments from Discord
- Reading the cloned Discord archive
- Creating channels, messages, authors, and attachments in Ohiyo
- Opening your new Ohiyo space
- Done

Expected result:

- Ohiyo opens a new imported space.
- Imported text channels are present.
- Voice channels are present.
- Messages are visible.
- Attachments render if your test had any.
- Imported channels are clearly marked **Not E2E**.
- Native Ohiyo chats still behave normally.

---

## Part 6 — Common beginner fixes

### The server does not appear after “Find my servers”

Try:

1. Wait 5–10 seconds.
2. Click **Find my servers** again.
3. Make sure the bot was added to the right Discord server.
4. Make sure the bot role can see the server/channel.

### Discord says you cannot add the bot

Your Discord account needs **Manage Server** permission.

Ask the server owner/admin to do the add-bot step.

### Import fails saying the bot cannot read messages

In Discord:

1. Open **Server Settings**.
2. Open **Roles**.
3. Find the Ohiyo bot role.
4. Make sure it has:
   - View Channels
   - Read Message History
5. For private channels, make sure the channel permissions allow the bot role too.

### Import takes too long

For the first proof, choose **Last 90 days**.

Large real servers should use the async job flow already added; the wizard now polls the backend instead of blocking the UI.

### It imports, but history is missing

Check:

1. Message Content Intent is enabled in the Discord Developer Portal.
2. Bot role has Read Message History.
3. Private channels allow the bot role.
4. You selected **Everything** if you need older history.

---

## Pass/fail criteria

Pass means:

- A beginner can follow the wizard without env vars or database paths.
- Bot invite opens correctly.
- Server picker works.
- Clone starts as a background job.
- Progress is visible.
- Imported space opens.
- Channels/messages look correct.
- Imported channels are honestly marked not end-to-end encrypted.

Fail means:

- The user needs to paste env vars.
- The user needs to find a local DB path.
- The server picker does not show the test server.
- Clone blocks forever or gives no progress.
- Imported messages/channels are missing unexpectedly.
