import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProject, databaseName, serviceNames } from '../src/project.mjs';
import { up, down, maintainModules, backup, restore } from '../src/commands.mjs';

function context(t, runner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo commands '));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const calls = [];
  const values = {PROJECT_NAME: 'cli_test', PGDATABASE: 'main', ODOO_HTTP_PORT: '18069'};
  const run = async (args, io) => { calls.push({args, io}); if (runner) return runner(args, io); return ''; };
  return {root, values, compose: ['compose'], run, calls};
}

test('project discovery walks parents but never accepts the CLI installation alone', t => {
  const ctx = context(t);
  const nested = path.join(ctx.root, 'a/b');
  fs.mkdirSync(nested, {recursive: true});
  assert.throws(() => findProject(nested), /没有找到/);
  fs.writeFileSync(path.join(ctx.root, 'compose.yaml'), '');
  fs.writeFileSync(path.join(ctx.root, '.env.example'), '');
  assert.equal(findProject(nested), fs.realpathSync(ctx.root));
});

test('database and service arguments reject malformed or option-like input', () => {
  for (const name of ['--force', 'bad-name', 'x'.repeat(64), 'a;drop']) assert.throws(() => databaseName(name));
  assert.equal(databaseName('test_erp'), 'test_erp');
  assert.deepEqual(serviceNames(['all', 'db']), ['odoo', 'db']);
  assert.throws(() => serviceNames(['--help']));
});

test('up honors offline flags and down only removes volumes when explicit', async t => {
  const ctx = context(t);
  await up(ctx, {build: false, pull: 'never', waitTimeout: 30});
  assert.ok(ctx.calls[0].args.includes('--no-build'));
  assert.ok(!ctx.calls[0].args.includes('--build'));
  assert.deepEqual(ctx.calls[0].args.slice(-2), ['--pull', 'never']);
  await down(ctx, {timeout: 1});
  assert.ok(!ctx.calls.at(-1).args.includes('--volumes'));
  await down(ctx, {timeout: 1, volumes: true});
  assert.ok(ctx.calls.at(-1).args.includes('--volumes'));
  assert.ok(!fs.existsSync(path.join(ctx.root, '.local/operation.lock')));
});

test('multiple modules use one maintenance process and database override does not alter project settings', async t => {
  const ctx = context(t);
  await maintainModules(ctx, 'update', ['module_a', 'module_b', 'module_a'], {database: 'test_db', restart: false});
  const maintenance = ctx.calls.find(call => call.args.includes('/opt/odoo/scripts/runtime.py'));
  assert.deepEqual(maintenance.args.slice(-3), ['upgrade', 'module_a', 'module_b']);
  assert.ok(maintenance.args.includes('PGDATABASE=test_db'));
  assert.equal(ctx.values.PGDATABASE, 'main');
  assert.equal(ctx.calls.filter(call => call.args[0] === 'stop').length, 1);
  assert.equal(ctx.calls.length, 3);
  await assert.rejects(maintainModules(ctx, 'update', [], {}), /--all/);
  await assert.rejects(maintainModules(ctx, 'update', ['module_a'], {all: true}), /不能/);
});

test('failed maintenance releases the lock and leaves the web service stopped', async t => {
  const ctx = context(t, async args => { if (args.includes('/opt/odoo/scripts/runtime.py')) throw new Error('module error'); });
  await assert.rejects(maintainModules(ctx, 'install', ['module_a'], {}), /module error/);
  assert.ok(!fs.existsSync(path.join(ctx.root, '.local/operation.lock')));
  assert.ok(!ctx.calls.some(call => call.args.includes('--no-build')));
});

test('backup protects existing files and invalid restores never stop the web service', async t => {
  const ctx = context(t, async args => { if (args.includes('validate')) throw new Error('bad ZIP'); });
  const file = path.join(ctx.root, 'backup.zip');
  fs.writeFileSync(file, 'existing');
  await assert.rejects(backup(ctx, {file}), /已存在/);
  assert.equal(ctx.calls.length, 0);
  await assert.rejects(restore(ctx, {file}), /bad ZIP/);
  assert.ok(!ctx.calls.some(call => call.args[0] === 'stop'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing');
});

test('database switch restores the original env and service when the new Odoo start fails', async t => {
  const ctx = context(t);
  const original = [
    'PROJECT_NAME=cli_test', 'ENV=DEV', 'PGDATABASE=main', 'PGUSER=odoo',
    'PGPASSWORD=fixture', 'ODOO_MASTER_PASSWORD=fixture', 'ODOO_ADMIN_PASSWORD=fixture',
    'DB_PORT=15432', 'ODOO_HTTP_PORT=18069', 'ODOO_GEVENT_PORT=18072', '',
  ].join('\r\n');
  const file = path.join(ctx.root, '.env');
  fs.writeFileSync(file, original, {mode: 0o600});
  const attempts = [];
  const runner = async (args, {env}) => {
    if (args.includes('ps')) return 'odoo\ndb';
    if (args.includes('psql')) return args.some(arg => arg.includes('to_json(')) ? 'true' : '[{"name":"main"},{"name":"restored"}]';
    if (args.includes('up')) {
      attempts.push(env.PGDATABASE);
      assert.equal(fs.readFileSync(file, 'utf8').includes('PGDATABASE=' + env.PGDATABASE + '\r\n'), true);
      if (env.PGDATABASE === 'restored') throw new Error('incompatible addons');
      return '';
    }
    assert.fail(args.join(' '));
  };
  const {useDatabase} = await import('../src/commands.mjs');
  await assert.rejects(useDatabase({root: ctx.root, runner}, 'restored'), /已恢复原数据库/);
  assert.deepEqual(attempts, ['restored', 'main']);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(ctx.root, '.local/operation.lock')), false);
});

test('a tagged save rolls back the new archive when publishing fails', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const {saveArchive} = await import('../src/archive.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE archives (id TEXT PRIMARY KEY, projectId TEXT, title TEXT, note TEXT,
        environment TEXT, database TEXT, file TEXT, bytes INTEGER, created TEXT, revision TEXT, source TEXT);
      CREATE TABLE archive_tags (projectId TEXT, tag TEXT, archiveId TEXT, PRIMARY KEY (projectId, tag));
    `);
    const old = {id: 'old', projectId: 'p', title: 'Old', note: '', environment: 'main', database: 'odoo',
      file: '/archives/old.zip', bytes: 1, created: '2026-01-01', revision: '', source: 'backup'};
    saveArchive(db, old, 'latest');
    db.exec("CREATE TRIGGER reject_release BEFORE UPDATE ON archive_tags BEGIN SELECT RAISE(ABORT, 'publish failed'); END;");
    assert.throws(() => saveArchive(db, {...old, id: 'new'}, 'latest'), /publish failed/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM archives').get().count, 1);
    assert.equal(db.prepare("SELECT archiveId FROM archive_tags WHERE tag = 'latest'").get().archiveId, 'old');
    db.exec('DROP TRIGGER reject_release');
    saveArchive(db, {...old, id: 'new'}, 'latest');
    assert.equal(db.prepare('SELECT count(*) AS count FROM archives').get().count, 2);
    assert.equal(db.prepare("SELECT archiveId FROM archive_tags WHERE tag = 'latest'").get().archiveId, 'new');
  } finally { db.close(); }
});

test('interrupted restore cleanup waits for its container and removes only the recorded temporary database', async t => {
  const {recoverDatabase} = await import('../src/commands.mjs');
  const ctx = context(t);
  fs.writeFileSync(path.join(ctx.root, '.env'), [
    'PROJECT_NAME=cli_test', 'ENV=DEV', 'PGDATABASE=main', 'PGUSER=odoo',
    'PGPASSWORD=fixture', 'ODOO_MASTER_PASSWORD=fixture', 'ODOO_ADMIN_PASSWORD=fixture',
    'DB_PORT=15432', 'ODOO_HTTP_PORT=18069', 'ODOO_GEVENT_PORT=18072',
  ].join('\n'));
  fs.mkdirSync(path.join(ctx.root, '.local'));
  const record = path.join(ctx.root, '.local', 'db-recovery.json');
  const container = 'mjh-restore-10000000-0000-0000-0000-000000000001';
  fs.writeFileSync(record, JSON.stringify({database: 'unfinished', disposable: true, resume: false, container}));
  let containerAlive = true;
  const dropped = [];
  const runner = async args => {
    if (args[0] === 'ps') return containerAlive ? container : '';
    if (args.includes('up')) return '';
    if (args.includes('psql')) return '[{"name":"main"},{"name":"unfinished"}]';
    if (args.includes('drop')) { dropped.push(args.at(-1)); return ''; }
    assert.fail(args.join(' '));
  };
  await assert.rejects(recoverDatabase({root: ctx.root, runner}), /容器仍在运行/);
  assert.deepEqual(dropped, []);
  assert.ok(fs.existsSync(record));
  containerAlive = false;
  await recoverDatabase({root: ctx.root, runner});
  assert.deepEqual(dropped, ['unfinished']);
  assert.ok(!fs.existsSync(record));
});
