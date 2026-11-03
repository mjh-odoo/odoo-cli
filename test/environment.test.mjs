import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { prepareEnv, readEnv, publicSettings, projectName, validateEnv, checkModuleNames } from '../src/lib/environment.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo base 中文 '));
  const template = fs.readFileSync(new URL('./fixtures/project/.env.example', import.meta.url), 'utf8');
  const blankPasswords = template.replace(/^[ \t]*(?:export[ \t]+)?(PGPASSWORD|ODOO_MASTER_PASSWORD|ODOO_ADMIN_PASSWORD)[ \t]*=[^\r\n]*/gm, '$1=');
  fs.writeFileSync(path.join(root, '.env.example'), blankPasswords);
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
  fs.appendFileSync(path.join(root, '.env.example'), '\nODOO_ADMIN_PASSWORD=changed-template-password\n');
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

test('template passwords and ordinary defaults are preserved without reserializing secrets', async t => {
  const root = fixture(t), filename = path.join(root, '.env.example');
  let template = fs.readFileSync(filename, 'utf8');
  const settings = {
    PGPASSWORD: {line: `PGPASSWORD=' pg # $value = "quoted" \\path '`, value: ' pg # $value = "quoted" \\path '},
    ODOO_MASTER_PASSWORD: {line: 'ODOO_MASTER_PASSWORD="master # $value" # template comment', value: 'master # $value'},
    ODOO_ADMIN_PASSWORD: {line: 'ODOO_ADMIN_PASSWORD=dev-admin', value: 'dev-admin'},
    PGDATABASE: {line: 'PGDATABASE=custom_db', value: 'custom_db'},
    PGUSER: {line: 'PGUSER=custom_user', value: 'custom_user'},
    ODOO_ADMIN_LOGIN: {line: 'ODOO_ADMIN_LOGIN=dev@example.test', value: 'dev@example.test'},
  };
  for (const [key, {line}] of Object.entries(settings)) template = template.replace(new RegExp('^' + key + '=.*$', 'm'), () => line);
  fs.writeFileSync(filename, template);
  const values = await prepareEnv(root);
  const output = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const [key, {line, value}] of Object.entries(settings)) {
    assert.equal(values[key], value);
    assert.ok(output.split('\n').includes(line));
  }
  assert.equal(fs.readFileSync(filename, 'utf8'), template);
});

test('each configured password is kept while the other blank passwords are generated', async t => {
  const keys = ['PGPASSWORD', 'ODOO_MASTER_PASSWORD', 'ODOO_ADMIN_PASSWORD'];
  for (const configured of keys) {
    await t.test(configured, async t => {
      const root = fixture(t), filename = path.join(root, '.env.example');
      let template = fs.readFileSync(filename, 'utf8');
      for (const key of keys) template = template.replace(new RegExp('^' + key + '=.*$', 'm'), key + '=' + (key === configured ? '0' : '""'));
      fs.writeFileSync(filename, template);
      const values = await prepareEnv(root);
      for (const key of keys) {
        if (key === configured) assert.equal(values[key], '0');
        else assert.match(values[key], /^[a-f0-9]{48}$/);
      }
    });
  }
});

test('missing password entries are generated and appended to the environment', async t => {
  const root = fixture(t), filename = path.join(root, '.env.example');
  const template = fs.readFileSync(filename, 'utf8').replace(/^(?:PGPASSWORD|ODOO_MASTER_PASSWORD|ODOO_ADMIN_PASSWORD)=.*\n/gm, '').trimEnd();
  fs.writeFileSync(filename, template);
  const values = await prepareEnv(root);
  for (const key of ['PGPASSWORD', 'ODOO_MASTER_PASSWORD', 'ODOO_ADMIN_PASSWORD']) assert.match(values[key], /^[a-f0-9]{48}$/);
  assert.equal(fs.readFileSync(filename, 'utf8'), template);
});

test('blank password entries with export and whitespace work with Windows line endings', async t => {
  const root = fixture(t), filename = path.join(root, '.env.example');
  const template = fs.readFileSync(filename, 'utf8')
    .replace(/^(PGPASSWORD|ODOO_MASTER_PASSWORD|ODOO_ADMIN_PASSWORD)=.*$/gm, '  export $1 = "" # generate')
    .replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(filename, template);
  const values = await prepareEnv(root);
  for (const key of ['PGPASSWORD', 'ODOO_MASTER_PASSWORD', 'ODOO_ADMIN_PASSWORD']) assert.match(values[key], /^[a-f0-9]{48}$/);
  assert.ok(!fs.readFileSync(path.join(root, '.env'), 'utf8').replaceAll('\r\n', '').includes('\n'));
});
