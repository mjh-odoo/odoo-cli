import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { prepareEnv, readEnv, publicSettings, projectName, validateEnv, checkModuleNames } from '../src/lib/environment.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo base 中文 '));
  fs.copyFileSync(new URL('./fixtures/project/.env.example', import.meta.url), path.join(root, '.env.example'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

test('first preparation generates independent credentials and stable project identity', async t => {
  const root = fixture(t);
  const values = await prepareEnv(root);
  assert.equal(values.PROJECT_NAME, projectName(root));
  assert.equal(new Set([values.PGPASSWORD, values.ODOO_MASTER_PASSWORD, values.ODOO_ADMIN_PASSWORD]).size, 3);
  assert.match(values.PGPASSWORD, /^[a-f0-9]{48}$/);
  assert.equal(new Set([values.DB_PORT, values.ODOO_HTTP_PORT, values.ODOO_GEVENT_PORT]).size, 3);
});

test('repeated preparation preserves hand edited settings byte for byte', async t => {
  const root = fixture(t);
  await prepareEnv(root);
  const filename = path.join(root, '.env');
  const body = fs.readFileSync(filename, 'utf8').replace('ENV=DEV', 'ENV=TEST') + '# personal configuration\n';
  fs.writeFileSync(filename, body);
  await prepareEnv(root);
  assert.equal(fs.readFileSync(filename, 'utf8'), body);
});

test('separate worktree paths have separate runtime identities', async t => {
  const first = fixture(t), second = fixture(t);
  assert.notEqual(projectName(first), projectName(second));
});

test('environment parser preserves quotes, spaces and literal special characters', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'CUSTOM="with spaces # hash $value"\n');
  assert.equal(readEnv(root).CUSTOM, 'with spaces # hash $value');
});

test('a partial existing environment fails without rewriting it', async t => {
  const root = fixture(t), filename = path.join(root, '.env');
  fs.writeFileSync(filename, 'ENV=DEV\n');
  await assert.rejects(prepareEnv(root), /Missing/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'ENV=DEV\n');
});

test('configuration output excludes credentials', () => {
  assert.deepEqual(publicSettings({ENV: 'DEV', PGPASSWORD: 'secret', ODOO_ADMIN_PASSWORD: 'secret', API_TOKEN: 'secret'}), {ENV: 'DEV'});
});

test('invalid or colliding host ports are rejected before Docker runs', async t => {
  const values = await prepareEnv(fixture(t));
  assert.throws(() => validateEnv({...values, DB_PORT: '65536'}), /Invalid DB_PORT/);
  assert.throws(() => validateEnv({...values, DB_PORT: values.ODOO_HTTP_PORT}), /distinct/);
});

test('module names cannot become shell options or commands', () => {
  assert.throws(() => checkModuleNames(['--force']), /Invalid/);
  assert.throws(() => checkModuleNames(['base;echo bad']), /Invalid/);
  assert.deepEqual(checkModuleNames(['contacts', 'contacts']), ['contacts']);
});
