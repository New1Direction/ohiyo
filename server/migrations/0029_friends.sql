CREATE TABLE friendships (
    id           TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK(status IN ('pending','accepted')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    CHECK (requester_id != addressee_id),
    UNIQUE (requester_id, addressee_id)
);

-- Only one friendship/request row may exist for a pair, regardless of who sent it.
CREATE UNIQUE INDEX idx_friendships_pair ON friendships (
    CASE WHEN requester_id < addressee_id THEN requester_id ELSE addressee_id END,
    CASE WHEN requester_id < addressee_id THEN addressee_id ELSE requester_id END
);

CREATE INDEX idx_friendships_requester ON friendships(requester_id, status);
CREATE INDEX idx_friendships_addressee ON friendships(addressee_id, status);
