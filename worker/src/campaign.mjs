import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

// One persistent ledger for the entire authorized development campaign, shared
// by every task, probe, revision and worker restart. Attempts are not refunded.
export class Campaign {
  constructor(path, { requireExisting = false } = {}) {
    if (requireExisting && !existsSync(path)) throw new Error('The existing campaign ledger is required; refusing to reset its counters.');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS attempts (
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, identity TEXT NOT NULL,
        captured_at TEXT NOT NULL, UNIQUE(kind, identity)
      )`);
    if (requireExisting && this.counts().model < 1) {
      this.db.close(); throw new Error('The campaign ledger is missing its earlier model attempt.');
    }
  }
  counts() {
    return Object.fromEntries(['model', 'browser'].map(kind => [kind,
      this.db.prepare('SELECT count(*) n FROM attempts WHERE kind=?').get(kind).n]));
  }
  pin(selection) {
    this.db.exec('CREATE TABLE IF NOT EXISTS selection (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    const value = JSON.stringify(selection);
    this.db.prepare('INSERT OR IGNORE INTO selection VALUES(1,?)').run(value);
    if (this.db.prepare('SELECT value FROM selection WHERE id=1').get().value !== value) {
      throw new Error('The campaign already pins a different route. No fallback is authorized.');
    }
  }
  admit(kind, identity) {
    if (!['model', 'browser'].includes(kind)) throw new Error('Unapproved campaign operation.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (kind === 'model' && this.db.prepare('SELECT 1 FROM attempts WHERE kind=? AND identity=?').get(kind, identity)) {
        throw new Error('Needs you: a campaign model attempt is uncertain. It will not be repeated.');
      }
      if (this.counts()[kind] >= (kind === 'model' ? 30 : 60)) throw new Error(`Needs you: the campaign ${kind} limit is exhausted.`);
      // Browser reads may retry safely, but EVERY actual operation consumes cap.
      this.db.prepare('INSERT INTO attempts(kind,identity,captured_at) VALUES(?,?,?)')
        .run(kind, kind === 'browser' ? `${identity}:${randomUUID()}` : identity, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
