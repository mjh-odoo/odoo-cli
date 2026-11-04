import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { archiveSeed, ensureArchiveTags, resolveArchive, saveArchive } from '../src/archive.mjs';
import { exportLibrary, importLibrary } from '../src/archive-library.mjs';

test('archive library preserves identity and tags across catalogs, and rejects damaged ZIPs', async t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-library-')));
  const oldCatalog = process.env.ODOO_MANAGER_CATALOG;
  t.after(() => {
    if (oldCatalog === undefined) delete process.env.ODOO_MANAGER_CATALOG;
    else process.env.ODOO_MANAGER_CATALOG = oldCatalog;
    fs.rmSync(tmp, {recursive: true, force: true});
  });
  function catalog(name) {
    const root = path.join(tmp, name);
    fs.mkdirSync(root);
    const storage = path.join(tmp, name + '-zips');
    const database = path.join(tmp, name + '.sqlite');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, root TEXT);
      CREATE TABLE environments (id TEXT PRIMARY KEY, root TEXT);
      CREATE TABLE settings (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE archives (id TEXT PRIMARY KEY, projectId TEXT, title TEXT, note TEXT,
        environment TEXT, database TEXT, file TEXT, bytes INTEGER, created TEXT, revision TEXT, source TEXT);`);
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(name, name, root);
    db.prepare('INSERT INTO settings VALUES (1, ?)').run(JSON.stringify({archiveRoot: storage}));
    ensureArchiveTags(db);
    process.env.ODOO_MANAGER_CATALOG = database;
    return {root, storage, db};
  }
  const source = catalog('source');
  const id = '10000000-0000-0000-0000-000000000001';
  const bytes = Buffer.from('ZIP contents');
  fs.mkdirSync(source.storage);
  const file = path.join(source.storage, id + '.zip');
  fs.writeFileSync(file, bytes);
  saveArchive(source.db, {id, projectId: 'source', title: '验收版', note: '保留备注', environment: 'main', database: 'odoo', file,
    bytes: bytes.length, created: '2026-11-04T00:00:00.000Z', revision: 'abc', source: 'backup'}, 'latest');
  source.db.close();
  await archiveSeed(source.root, 'id:' + id);
  const bundle = path.join(tmp, 'bundle');
  assert.equal((await exportLibrary(source.root, bundle)).archives, 1);
  const broken = catalog('broken');
  broken.db.close();
  const payload = path.join(bundle, id + '.zip');
  fs.writeFileSync(payload, Buffer.alloc(bytes.length));
  await assert.rejects(importLibrary(broken.root, bundle), /校验失败/);
  assert.deepEqual(fs.readdirSync(broken.storage), []);
  fs.writeFileSync(payload, bytes);
  const target = catalog('target');
  target.db.close();
  assert.deepEqual(await importLibrary(target.root, bundle), {imported: 1, retained: 0, skippedTags: []});
  assert.deepEqual(await importLibrary(target.root, bundle), {imported: 0, retained: 1, skippedTags: []});
  const restored = await resolveArchive(target.root, 'latest');
  assert.equal(restored.id, id);
  assert.equal(restored.note, '保留备注');
  assert.deepEqual(fs.readFileSync(restored.file), bytes);
});
