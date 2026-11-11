import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const directory = new URL("../../../migrations/", import.meta.url);
const migration = readFileSync(new URL("0035_interim_messages.sql", directory), "utf8");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    if (name >= "0035_") break;
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  db.exec(`
    INSERT INTO workspaces(id,path,name,created_at,updated_at) VALUES ('w','/fixture','w','now','now');
    INSERT INTO sessions(id,workspace_id,title,status,created_at,updated_at)
      VALUES ('s','w','s','idle','now','now');
    INSERT INTO messages(rowid,id,session_id,role,content,created_at,assistant_kind,reasoning)
      VALUES (12,'u','s','user','request','now',NULL,''),
             (24,'c','s','assistant','progress','now','commentary','thinking'),
             (36,'f','s','assistant','answer','now','final','');
    INSERT INTO model_context_snapshots(session_id,last_message_id,history_json,updated_at)
      VALUES ('s','f','[]','now');
    INSERT INTO memories(id,scope,content,metadata_json,created_at,updated_at,origin)
      VALUES ('m','global','fact','{}','now','now','extracted');
    INSERT INTO memory_sources VALUES ('m',1,'u','hash',0,7);
    INSERT INTO memory_jobs(message_id,source_hash,generation) VALUES ('u','hash',0);
  `);
  return db;
}

test("interim migration preserves rows, references, and memory evidence", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT rowid AS sequence, * FROM messages ORDER BY rowid").all();
    db.exec(`BEGIN; ${migration} COMMIT;`);
    assert.deepEqual(db.prepare("SELECT rowid AS sequence, * FROM messages ORDER BY rowid").all(), before);
    for (const table of ["model_context_snapshots", "memories", "memory_sources", "memory_jobs"]) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 1, table);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("UPDATE messages SET assistant_kind='interim' WHERE id='c'");
    assert.equal(db.prepare("SELECT assistant_kind FROM messages WHERE id='c'").get().assistant_kind, "interim");
    // The source invalidation trigger must still work after the column change.
    db.exec("UPDATE messages SET content='edited' WHERE id='u'");
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_sources").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM memory_jobs").get().count, 0);
  } finally {
    db.close();
  }
});

test("interim migration retains role and enum validation", () => {
  const db = fixture();
  try {
    assert.throws(() => db.exec("UPDATE messages SET assistant_kind='interim' WHERE id='c'"), /CHECK constraint/);
    db.exec(`BEGIN; ${migration} COMMIT;`);
    for (const kind of ["commentary", "interim", "final", "interrupted"]) {
      db.prepare("UPDATE messages SET assistant_kind=? WHERE id='c'").run(kind);
    }
    assert.throws(() => db.exec("UPDATE messages SET assistant_kind='interim' WHERE id='u'"), /CHECK constraint/);
    assert.throws(() => db.exec("UPDATE messages SET assistant_kind='unknown' WHERE id='c'"), /CHECK constraint/);
  } finally {
    db.close();
  }
});

test("protocol schema and Rust kind names agree", () => {
  const source = readFileSync(new URL("../../../crates/miniq-protocol/src/types.rs", import.meta.url), "utf8");
  const implementation = source.match(/impl AssistantMessageKind \{([\s\S]*?)\n\}/)[1];
  const kinds = [...implementation.matchAll(/Self::\w+ => "(\w+)"/g)].map(match => match[1]);
  const schema = JSON.parse(readFileSync(new URL("../../../schemas/protocol.schema.json", import.meta.url), "utf8"));
  let checked = 0;
  for (const section of Object.values(schema)) {
    if (!section?.definitions?.AssistantMessageKind) continue;
    assert.deepEqual(section.definitions.AssistantMessageKind.enum, kinds);
    checked += 1;
  }
  assert.equal(checked, 2);
});
