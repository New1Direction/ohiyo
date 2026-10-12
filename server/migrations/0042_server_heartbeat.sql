-- When the server was last known to be up, written by every background sweep. On the
-- next start the gap tells how long it was down, so that time isn't counted towards
-- anyone's dead-man's switch: nobody could open Ohiyo while it was down.
CREATE TABLE IF NOT EXISTS server_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at INTEGER NOT NULL
);
