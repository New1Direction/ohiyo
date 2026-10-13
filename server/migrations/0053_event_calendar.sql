-- Events grow up: an optional end, a place (one of the space's voice or text channels, or
-- a place of the host's own: an address or a link), a cover image the host uploaded, and
-- cancelling, which keeps the event on the calendar marked as cancelled.
ALTER TABLE events ADD COLUMN ends_at INTEGER;
ALTER TABLE events ADD COLUMN location_kind TEXT;        -- 'voice' | 'text' | 'place' | NULL
ALTER TABLE events ADD COLUMN location_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN location_text TEXT;
ALTER TABLE events ADD COLUMN cover_file_id TEXT;
ALTER TABLE events ADD COLUMN cancelled_at INTEGER;
ALTER TABLE events ADD COLUMN updated_at INTEGER;

-- Three answers instead of one: 'interested', 'going' or 'not_going'. Every answer given
-- before this was "I'm in". The reminded flags make each reminder (15 minutes before, and
-- at the start) go to a person once, even across restarts.
ALTER TABLE event_rsvps ADD COLUMN status TEXT NOT NULL DEFAULT 'going'
    CHECK (status IN ('interested', 'going', 'not_going'));
ALTER TABLE event_rsvps ADD COLUMN reminded_soon INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_rsvps ADD COLUMN reminded_start INTEGER NOT NULL DEFAULT 0;

-- The reminder sweep looks at events starting around now.
CREATE INDEX idx_events_starts ON events(starts_at) WHERE cancelled_at IS NULL;
