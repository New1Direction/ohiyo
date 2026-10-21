-- Burrow owns explicit memory and declarative methods; neither grants authority.
ALTER TABLE burrow_tasks ADD COLUMN project TEXT;
ALTER TABLE burrow_tasks ADD COLUMN routine_id TEXT;
ALTER TABLE burrow_tasks ADD COLUMN routine_version INTEGER;
ALTER TABLE burrow_tasks ADD COLUMN comparison INTEGER NOT NULL DEFAULT 0;
ALTER TABLE burrow_tasks ADD COLUMN manual_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE burrow_tasks ADD COLUMN manual_edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE burrow_tasks ADD COLUMN proposed_result TEXT NOT NULL DEFAULT '';
CREATE TABLE burrow_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project TEXT,
    text TEXT NOT NULL,
    source_task TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    forgotten INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX burrow_memory_scope ON burrow_memories(user_id,project,forgotten);
CREATE TABLE burrow_routines (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project TEXT,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    source_task TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(id,version)
);
CREATE VIRTUAL TABLE burrow_task_search USING fts5(request,result,content='burrow_tasks',content_rowid='rowid');
INSERT INTO burrow_task_search(burrow_task_search) VALUES('rebuild');
CREATE TRIGGER burrow_search_insert AFTER INSERT ON burrow_tasks BEGIN
    INSERT INTO burrow_task_search(rowid,request,result) VALUES(new.rowid,new.request,new.result);
END;
CREATE TRIGGER burrow_search_delete AFTER DELETE ON burrow_tasks BEGIN
    INSERT INTO burrow_task_search(burrow_task_search,rowid,request,result) VALUES('delete',old.rowid,old.request,old.result);
END;
CREATE TRIGGER burrow_search_update AFTER UPDATE OF request,result ON burrow_tasks BEGIN
    INSERT INTO burrow_task_search(burrow_task_search,rowid,request,result) VALUES('delete',old.rowid,old.request,old.result);
    INSERT INTO burrow_task_search(rowid,request,result) VALUES(new.rowid,new.request,new.result);
END;
