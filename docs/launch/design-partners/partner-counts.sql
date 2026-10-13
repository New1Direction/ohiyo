-- Ohiyo design-partner counts. Aggregates only: no message content, no names, no ids.
-- Run against a COPY of the database, never the live file:
--   sqlite3 ohiyo-copy.db < docs/launch/design-partners/partner-counts.sql
-- DMs and group chats belong to no space, so they are never counted. Webhook accounts
-- (users.is_bot = 1) are not people, so they are left out of every count.
.headers on
.mode column

SELECT
  s.name AS space,
  (SELECT COUNT(*) FROM server_members sm JOIN users u ON u.id = sm.user_id
     WHERE sm.server_id = s.id AND u.is_bot = 0) AS members,
  (SELECT COUNT(*) FROM server_members sm JOIN users u ON u.id = sm.user_id
     WHERE sm.server_id = s.id AND u.is_bot = 0
       AND sm.joined_at >= CAST(strftime('%s', 'now', '-14 days') AS INTEGER)) AS joined_14d,
  (SELECT COUNT(DISTINCT m.author_id) FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.author_id
     WHERE c.server_id = s.id AND u.is_bot = 0
       AND m.created_at >= CAST(strftime('%s', 'now', '-7 days') AS INTEGER)) AS posters_7d,
  (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.author_id
     WHERE c.server_id = s.id AND u.is_bot = 0
       AND m.created_at >= CAST(strftime('%s', 'now', '-7 days') AS INTEGER)) AS messages_7d
FROM servers s
ORDER BY members DESC;
