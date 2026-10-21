-- Local, interactive pages share the existing owner and revision boundary.
ALTER TABLE burrow_tasks ADD COLUMN template TEXT
    CHECK (template IS NULL OR template IN ('bill', 'packing'));
