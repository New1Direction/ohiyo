# Meilisearch — message search for Kikkacord

Kikkacord can serve full-text message search from [Meilisearch](https://www.meilisearch.com/)
(typo-tolerant, relevance-ranked). It's **optional**: with search disabled, the
`GET /servers/{id}/search` endpoint falls back to a SQL `LIKE` query, so nothing
breaks — Meilisearch just makes it fast and fuzzy.

## Run it

```bash
# 1. Pick a key and start the service
export MEILI_MASTER_KEY=$(openssl rand -hex 32)
docker compose -f infra/meilisearch/docker-compose.yml up -d

# 2. Point the server at it (server/.env)
MEILISEARCH_ENABLED=true
MEILISEARCH_URL=http://localhost:7700
MEILISEARCH_API_KEY=<the same MEILI_MASTER_KEY>
```

Restart the server. On boot with search enabled it creates and configures the
`messages` index automatically (filterable: `channel_id`, `server_id`, `author_id`;
searchable: `content`, `author_name`).

## How it works

- **Indexing** is live and fire-and-forget: send/edit/delete each enqueue a
  background index update, so search latency or a down index never affects sending.
- **Searching** is server-scoped — results are filtered to the server you're
  querying and re-checked against the live DB before return (a stale index entry
  can never leak a message across servers).
- **Auth/scope**: the endpoint still requires server membership; disabling
  Meilisearch is transparent to the client.

## Back-indexing existing messages

New messages index automatically; messages that predate enabling search are **not**
back-filled. To index history, run a one-off that reads existing rows and POSTs them
to `{MEILISEARCH_URL}/indexes/messages/documents` with the same `MessageDoc` shape
(`id, channel_id, server_id, author_id, author_name, content, created_at`). A small
admin binary or a `psql`/`sqlite3` → `curl` script both work.

## Verify

```bash
# Documents present?
curl -H "Authorization: Bearer $MEILI_MASTER_KEY" http://localhost:7700/indexes/messages/documents

# Search directly
curl -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  -X POST http://localhost:7700/indexes/messages/search \
  -H 'Content-Type: application/json' -d '{"q":"hello"}'
```
