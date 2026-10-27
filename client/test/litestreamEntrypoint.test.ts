// How the server image starts Litestream, the database backup. It runs the entrypoint
// with stand-ins for `litestream` and `ohiyo-server` on PATH and reads back what was run.
// The hosted backup goes to Cloudflare R2, and Litestream 0.3 only takes an S3 endpoint
// from a config file, so a replica URL alone silently aims at AWS and never backs up.
//   node --experimental-strip-types --test test/litestreamEntrypoint.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "docker-entrypoint.sh");

type Run = { status: number | null; calls: string[]; config: string | null; dir: string };

function boot(env: Record<string, string>, options: { dbExists?: boolean; restoreFails?: boolean } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "ohiyo-entrypoint-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("litestream", options.restoreFails ? 'if [ "$1" = restore ]; then exit 1; fi' : "");
  stub("ohiyo-server", "");
  stub("tini", 'shift; shift; exec "$@"');
  stub("node", "");
  const db = join(dir, "data", "ohiyo.db");
  mkdirSync(join(dir, "data"));
  if (options.dbExists) writeFileSync(db, "");
  const result = spawnSync("sh", [entrypoint], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: dir,
      DATABASE_URL: `sqlite:${db}`,
      ...env,
    },
    encoding: "utf8",
  });
  const configPath = join(dir, "ohiyo-litestream.yml");
  return {
    status: result.status,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.replaceAll(dir, "$DIR")),
    config: existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
    dir,
  };
}

const R2 = {
  LITESTREAM_REPLICA_URL: "s3://ohiyo-backups/ohiyo.db",
  LITESTREAM_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
  LITESTREAM_ACCESS_KEY_ID: "key-id-not-in-files",
  LITESTREAM_SECRET_ACCESS_KEY: "secret-not-in-files",
};

test("with no replica the server starts on its own", (t) => {
  const run = boot({});
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls, ["ohiyo-server "]);
});

test("only the exact embedded opt-in enters the subreaped supervisor", (t) => {
  const run = boot({ KIKKA_EMBEDDED_WORKER: "1", ...R2 });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls, [
    `tini -s -- node ${join(dirname(entrypoint), "worker-supervisor.mjs")}`,
    `node ${join(dirname(entrypoint), "worker-supervisor.mjs")}`,
  ]);
  assert.equal(run.config, null, "the API subprocess owns the unchanged restore path");
  for (const value of ["0", "true", "yes"]) {
    const legacy = boot({ KIKKA_EMBEDDED_WORKER: value });
    t.after(() => rmSync(legacy.dir, { recursive: true, force: true }));
    assert.equal(legacy.status, 0);
    assert.deepEqual(legacy.calls, ["ohiyo-server "]);
  }
});

test("a replica URL without an endpoint is used as it is (AWS S3)", (t) => {
  const run = boot({ LITESTREAM_REPLICA_URL: "s3://bucket/ohiyo.db" });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls, [
    "litestream restore -if-db-not-exists -if-replica-exists -o $DIR/data/ohiyo.db s3://bucket/ohiyo.db",
    "litestream replicate -exec ohiyo-server $DIR/data/ohiyo.db s3://bucket/ohiyo.db",
  ]);
  assert.equal(run.config, null, "no config file is written without an endpoint");
});

test("with an endpoint Litestream gets a config file that names it (Cloudflare R2)", (t) => {
  const run = boot(R2);
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls, [
    "litestream restore -config $DIR/ohiyo-litestream.yml -if-db-not-exists -if-replica-exists $DIR/data/ohiyo.db",
    "litestream replicate -config $DIR/ohiyo-litestream.yml -exec ohiyo-server",
  ]);
  const config = run.config ?? "";
  assert.match(config, new RegExp(`path: "${run.dir}/data/ohiyo.db"`));
  // Litestream expands these itself when it reads the file.
  assert.match(config, /url: "\$\{LITESTREAM_REPLICA_URL\}"/);
  assert.match(config, /endpoint: "\$\{LITESTREAM_ENDPOINT\}"/);
  assert.match(config, /region: "auto"/, "R2 signs with the region auto");
  assert.match(config, /sync-interval: 10s/);
  assert.match(config, /retention: 72h/);
  // Keys reach Litestream from the environment, never from a file on disk.
  assert.doesNotMatch(config, /key-id-not-in-files|secret-not-in-files/);
});

test("a region can be named for stores that need one", (t) => {
  const run = boot({ ...R2, LITESTREAM_REGION: "us-west-004" });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.match(run.config ?? "", /region: "us-west-004"/);
});

test("with a database already on the volume nothing is restored, and the store is not asked", (t) => {
  // A store that can't be reached must not keep a working server down.
  const run = boot(R2, { dbExists: true, restoreFails: true });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.equal(run.status, 0);
  assert.deepEqual(run.calls, ["litestream replicate -config $DIR/ohiyo-litestream.yml -exec ohiyo-server"]);
});

test("with no database and a backup that can't be read, the server does not start empty", (t) => {
  const run = boot(R2, { restoreFails: true });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.notEqual(run.status, 0);
  assert.equal(run.calls.some((call) => call.startsWith("ohiyo-server") || call.includes("replicate")), false);
});

test("database options in the URL are not part of the file name", (t) => {
  const run = boot({ ...R2, DATABASE_URL: "sqlite:/data/ohiyo.db?mode=rwc" });
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  assert.match(run.config ?? "", /path: "\/data\/ohiyo\.db"\n/);
});

test("local restore drill includes committed WAL messages but excludes pending writes", () => {
  const drill = join(dirname(entrypoint), "..", "scripts", "backup-restore-drill.sh");
  const result = spawnSync("python3", ["-", drill], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    input: `
import os, pathlib, sqlite3, subprocess, sys, tempfile
with tempfile.TemporaryDirectory(prefix='ohiyo-restore-wal-') as directory:
    root = pathlib.Path(directory)
    source = root / 'family chat.db'
    writer = sqlite3.connect(source)
    try:
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('PRAGMA wal_autocheckpoint=0')
        for table in ['users', 'servers', 'channels', 'messages', 'hosted_instances']:
            writer.execute(f'CREATE TABLE {table}(content TEXT)')
        writer.commit()
        writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        writer.execute("INSERT INTO messages VALUES ('committed family message')")
        writer.commit()
        writer.execute("INSERT INTO messages VALUES ('not committed')")
        for options in ['', '?mode=rwc']:
            destination = root / ('with-options' if options else 'plain')
            destination.mkdir()
            env = dict(os.environ, DATABASE_URL=f'sqlite:{source}{options}',
                WORKDIR=str(destination), KEEP_RESTORE_DRILL='1')
            run = subprocess.run(['bash', sys.argv[1]], env=env, capture_output=True, text=True, timeout=15)
            assert run.returncode == 0, run.stdout + run.stderr
            with sqlite3.connect(destination / 'ohiyo-restore-drill.db') as restored:
                assert restored.execute('SELECT content FROM messages').fetchall() == [('committed family message',)], 'restore lost committed WAL data or included an uncommitted message'
            assert writer.execute('SELECT content FROM messages').fetchall() == [('committed family message',), ('not committed',)], 'drill changed the source transaction'
        print('committed WAL message restored; pending write excluded; source unchanged')
    finally:
        writer.rollback()
        writer.close()
`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /committed WAL message restored; pending write excluded; source unchanged/);
});
