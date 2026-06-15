-- Profile banner image. Mirrors avatar_url: a full /files/<id> URL set via the
-- dedicated POST /users/@me/banner endpoint. NULL = no banner image (the banner_color
-- still shows). Existing rows get NULL, which is the correct "no banner yet" state.
ALTER TABLE users ADD COLUMN banner_url TEXT;
