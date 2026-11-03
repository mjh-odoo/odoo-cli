import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';

export function readEnv(root) {
  const filename = path.join(root, '.env');
  return fs.existsSync(filename) ? parseEnv(fs.readFileSync(filename, 'utf8')) : {};
}

export function projectName(root) {
  const location = fs.realpathSync(root);
  const prefix = path.basename(location).toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[_-]+/, '') || 'odoo';
  return prefix.slice(0, 32) + '_' + crypto.createHash('sha256').update(location).digest('hex').slice(0, 10);
}

async function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({host: '127.0.0.1', port, exclusive: true}, () => server.close(() => resolve(true)));
  });
}

export function validateEnv(values) {
  for (const key of ['PROJECT_NAME', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'ODOO_MASTER_PASSWORD', 'ODOO_ADMIN_PASSWORD']) {
    if (!values[key]) throw new Error('Missing ' + key + '. Check .env or run init in a new checkout.');
    if (/[\r\n]/.test(values[key])) throw new Error(key + ' must be a single line.');
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(values.PROJECT_NAME)) throw new Error('Invalid PROJECT_NAME.');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(values.PGDATABASE)) throw new Error('Invalid PGDATABASE.');
  if (!['DEV', 'TEST', 'PROD'].includes(values.ENV)) throw new Error('ENV must be DEV, TEST or PROD.');
  const ports = ['DB_PORT', 'ODOO_HTTP_PORT', 'ODOO_GEVENT_PORT'].map(key => {
    const value = values[key];
    if (!/^\d+$/.test(value || '') || +value < 1 || +value > 65535) throw new Error('Invalid ' + key + '.');
    return +value;
  });
  if (new Set(ports).size !== ports.length) throw new Error('Host ports must be distinct.');
  return values;
}

export async function prepareEnv(root) {
  const filename = path.join(root, '.env');
  if (fs.existsSync(filename)) return validateEnv(readEnv(root));
  let text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const values = parseEnv(text);
  const name = projectName(root);
  const offset = parseInt(crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 6), 16) % 1000;
  let ports;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const n = (offset + attempt) % 1000;
    const candidate = [15432 + n, 18069 + n, 18072 + n];
    if ((await Promise.all(candidate.map(portFree))).every(Boolean)) { ports = candidate; break; }
  }
  if (!ports) throw new Error('No free host port set found.');
  const generated = {
    PROJECT_NAME: name, DB_PORT: String(ports[0]), ODOO_HTTP_PORT: String(ports[1]), ODOO_GEVENT_PORT: String(ports[2]),
  };
  for (const key of ['PGPASSWORD', 'ODOO_MASTER_PASSWORD', 'ODOO_ADMIN_PASSWORD']) {
    if (!values[key]) generated[key] = crypto.randomBytes(24).toString('hex');
  }
  validateEnv({...values, ...generated});
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(generated)) {
    const pattern = new RegExp('^[ \t]*(?:export[ \t]+)?' + key + '[ \t]*=[^\r\n]*', 'gm');
    if (pattern.test(text)) text = text.replace(pattern, () => key + '=' + value);
    else text += (text && !text.endsWith('\n') ? newline : '') + key + '=' + value + newline;
  }
  try { fs.writeFileSync(filename, text, {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return validateEnv(readEnv(root));
}

export function archiveDirectory(values) {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'mjh-odoo', 'backups', values.PROJECT_NAME);
}

export function publicSettings(values) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !/PASSWORD|TOKEN|SECRET|KEY/.test(key)));
}

export function checkModuleNames(names) {
  if (names.some(name => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))) throw new Error('Invalid module name.');
  return [...new Set(names)];
}
