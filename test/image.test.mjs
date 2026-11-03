import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { imageBuildPlan, executeImageBuild } from '../src/lib/image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {root, version: '0.1.0'};
const plan = args => imageBuildPlan(args, defaults);

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo image 中文 '));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('default image build loads only a local base image', () => {
  const value = plan([]);
  assert.equal(value.target, 'base');
  assert.equal(value.output, 'local');
  assert.equal(value.tag, 'mjh-odoo/odoo-runtime:20.0-v0.1.0');
  assert.ok(value.argv.includes('--load'));
  assert.ok(!value.argv.includes('--push'));
  assert.deepEqual(value.platforms, []);
  assert.equal(value.argv.at(-1), root);
});

test('multi-platform publishing requires explicit push and tag', () => {
  assert.throws(() => plan(['--platform', 'amd64,arm64']), /--push/);
  assert.throws(() => plan(['--platform', 'amd64,arm64', '--push']), /--tag/);
  const value = plan(['--platform', 'amd64,linux/arm64,amd64', '--push', '--tag', 'registry.example:5000/team/runtime:20.0-v1']);
  assert.deepEqual(value.platforms, ['linux/amd64', 'linux/arm64']);
  assert.ok(value.argv.includes('--push'));
  assert.ok(!value.argv.includes('--load'));
});

test('offline export uses a single architecture and keeps file paths out of exporter CSV', () => {
  const value = plan(['--platform', 'amd64', '--file', '中文, archive.tar']);
  assert.deepEqual(value.platforms, ['linux/amd64']);
  assert.equal(value.output, 'archive');
  assert.equal(value.argv[value.argv.indexOf('--output') + 1], 'type=docker,dest=-');
  assert.ok(!value.argv.includes(value.file));
  assert.throws(() => plan(['--file', 'a.tar', '--platform', 'amd64,arm64']), /one platform/);
  assert.throws(() => plan(['--file', 'a.tar', '--push', '--tag', 'team/runtime:v1']), /cannot be combined/);
});

test('invalid targets, tags, platforms and flags fail before Docker', () => {
  for (const args of [
    ['--target', 'development'], ['--platform', 'windows/amd64'], ['--platform', 'amd64,'],
    ['--tag=-option'], ['--tag', 'name with spaces'], ['--file', ''], ['--builder=-bad'], ['--unknown'],
  ]) assert.throws(() => plan(args));
  assert.throws(() => plan(['--target', 'production']), /explicit --tag/);
  assert.equal(plan(['--target', 'production', '--tag', 'my-erp:20.0-v1']).target, 'production');
});

test('only a non-secret apt mirror becomes a build argument', () => {
  const value = imageBuildPlan([], {...defaults, mirror: 'https://mirror.example/debian'});
  assert.ok(value.argv.includes('APT_MIRROR_BASE=https://mirror.example/debian'));
  for (const mirror of ['file:///tmp/apt', 'https://user:password@mirror.example', 'https://mirror.example\n']) {
    assert.throws(() => imageBuildPlan([], {...defaults, mirror}));
  }
});

test('archive writes are exclusive and failures remove partial output', async t => {
  const directory = folder(t);
  const file = path.join(directory, '中文, archive.tar');
  const value = plan(['--file', file]);
  const calls = [];
  const run = async (argv, stdio) => {
    calls.push(argv);
    if (stdio) fs.writeSync(stdio[1], Buffer.from('sample image stream'));
  };
  await executeImageBuild(value, run);
  assert.equal(fs.readFileSync(file, 'utf8'), 'sample image stream');
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
  const count = calls.length;
  await assert.rejects(executeImageBuild(value, run), /already exists/);
  assert.equal(calls.length, count);
  const failed = plan(['--file', path.join(directory, 'failed.tar')]);
  await assert.rejects(executeImageBuild(failed, async (argv, stdio) => {
    if (stdio) { fs.writeSync(stdio[1], 'partial'); throw new Error('build failed'); }
  }), /build failed/);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test('empty Docker output is rejected without publishing an archive', async t => {
  const directory = folder(t);
  const value = plan(['--file', path.join(directory, 'empty.tar')]);
  await assert.rejects(executeImageBuild(value, async () => {}), /empty archive/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

