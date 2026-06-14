-- Image pixel dimensions so the client can reserve exact space before an image
-- loads (no layout shift). Nullable — only populated for image uploads.
ALTER TABLE files ADD COLUMN width INTEGER;
ALTER TABLE files ADD COLUMN height INTEGER;
