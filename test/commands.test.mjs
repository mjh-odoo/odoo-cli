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
