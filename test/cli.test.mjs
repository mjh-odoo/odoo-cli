import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../src/cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(root, 'bin/odoo.mjs');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo cli 中文 '));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.copyFileSync(path.join(root, 'test/fixtures/project/.env.example'), path.join(dir, '.env.example'));
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
  return dir;
}

function launch(args, cwd) {
  return spawnSync(process.execPath, [binary, ...args], {cwd, env: {...process.env, PATH: ''}, encoding: 'utf8'});
}

test('all public help pages work outside projects without Docker or creating configuration', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo cli help '));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const topic of ['', 'init', 'doctor', 'config', 'up', 'down', 'restart', 'status', 'logs', 'build', 'module', 'module list', 'module install', 'module update', 'db', 'db list', 'db backup', 'db restore', 'image', 'image build']) {
    for (const flag of ['--help', '-h']) {
      const r = launch([...topic.split(' ').filter(Boolean), flag], dir);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('Usage: odoo'));
    }
  }
  for (const args of [[], ['help'], ['help', 'module', 'update'], ['help', 'exec'], ['module'], ['db'], ['image']]) assert.equal(launch(args, dir).status, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('CLI version and invalid parameters never initialize a project', t => {
  const dir = project(t);
  for (const args of [['--version'], ['-V'], ['version']]) assert.equal(launch(args, dir).stdout.trim(), '0.1.0');
  for (const args of [['db', 'restore'], ['up', '--wait-timeout', '-1'], ['down', '--unknown'], ['module', 'install'], ['logs', '--tail', 'bad'], ['missing']]) assert.notEqual(launch(args, dir).status, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.env')));
  assert.ok(!fs.existsSync(path.join(dir, '.local')));
});

test('installed-style init discovers nested projects and preserves environment on repeat', async t => {
  const dir = project(t);
  const nested = path.join(dir, 'addons/custom/nested');
  fs.mkdirSync(nested, {recursive: true});
  let r = launch(['init', '--json'], nested);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.projectDirectory, fs.realpathSync(dir));
  assert.ok(!r.stdout.includes('PGPASSWORD'));
  const before = fs.readFileSync(path.join(dir, '.env'));
  r = launch(['-C', dir, 'init'], os.tmpdir());
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dir, '.env')), before);
});

test('down preview is project-scoped, exposes volume deletion and has no side effects', t => {
  const dir = project(t);
  assert.equal(launch(['init'], dir).status, 0);
  const r = launch(['-C', dir, 'down', '-v', '--dry-run'], os.tmpdir());
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.removeVolumes, true);
  assert.ok(plan.docker.includes('--volumes'));
  assert.equal(plan.directory, fs.realpathSync(dir));
  assert.ok(!fs.existsSync(path.join(dir, '.local')));
});

test('native Odoo help and version are forwarded rather than consumed by the manager', async t => {
  const dir = project(t);
  assert.equal(launch(['init'], dir).status, 0);
  for (const native of ['--help', '--version']) {
    const calls = [];
    const p = createProgram({version: '0.1.0', cwd: dir, runner: async args => { calls.push(args); return ''; }});
    p.exitOverride();
    await p.parseAsync(['exec', '--', native], {from: 'user'});
    assert.deepEqual(calls[0].slice(-3), ['odoo', 'odoo', native]);
  }
});

test('image dry run works before initialization and produces only a plan', t => {
  const dir = project(t);
  const r = launch(['image', 'build', '--platform', 'amd64', '--file', path.join(dir, 'new', 'runtime.tar'), '--dry-run'], dir);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.platforms, ['linux/amd64']);
  assert.equal(plan.output, 'archive');
  assert.ok(!fs.existsSync(path.join(dir, '.env')));
  assert.ok(!fs.existsSync(path.join(dir, 'new')));
});
