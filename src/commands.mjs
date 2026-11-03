import fs from 'node:fs';
import path from 'node:path';
import { archiveDirectory, checkModuleNames, publicSettings } from './lib/environment.mjs';
import { databaseName, serviceNames, withLock } from './project.mjs';

const start = (ctx, services = ['odoo'], timeout = 300) => ctx.run(['up', '-d', '--no-build', '--wait', '--wait-timeout', String(timeout), ...services]);

export async function initialize(ctx, options) {
  if (options.json) console.log(JSON.stringify({projectDirectory: ctx.root, ...publicSettings(ctx.values)}, null, 2));
  else {
    console.log('项目配置就绪: ' + ctx.values.PROJECT_NAME);
    console.log('Odoo: http://localhost:' + ctx.values.ODOO_HTTP_PORT);
    console.log('初始管理员密码位于本机 .env 的 ODOO_ADMIN_PASSWORD。');
  }
}

export async function doctor(ctx, options) {
  const result = {project: ctx.values.PROJECT_NAME, directory: ctx.root, node: process.versions.node};
  for (const [name, argv] of [['docker', ['version', '--format', '{{.Server.Version}}']], ['compose', ['compose', 'version', '--short']], ['buildx', ['buildx', 'version']]]) result[name] = await ctx.docker(argv, {capture: true});
  if (!fs.existsSync(path.join(ctx.root, 'odoo', 'odoo-bin'))) throw new Error('项目缺少完整 Odoo 源码: odoo/odoo-bin。');
  if (!fs.existsSync(path.join(ctx.root, 'scripts', 'runtime.py'))) throw new Error('项目缺少容器入口 scripts/runtime.py。');
  await ctx.run(['config', '--quiet'], {capture: true});
  result.valid = true;
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else for (const [name, value] of Object.entries(result)) console.log(`${name}: ${value}`);
}

export function configuration(ctx) {
  console.log(JSON.stringify({PROJECT_DIRECTORY: ctx.root, ...publicSettings(ctx.values), BACKUP_DIRECTORY: archiveDirectory(ctx.values)}, null, 2));
}

export async function up(ctx, options) {
  await withLock(ctx, async () => {
    const args = ['up', '-d', options.build ? '--build' : '--no-build', '--wait', '--wait-timeout', String(options.waitTimeout)];
    if (options.pull) args.push('--pull', options.pull);
    await ctx.run(args);
    console.log('Odoo: http://localhost:' + ctx.values.ODOO_HTTP_PORT);
  });
}

export async function down(ctx, options) {
  const args = ['down', '--timeout', String(options.timeout)];
  if (options.volumes) args.push('--volumes');
  if (options.dryRun) {
    console.log(JSON.stringify({project: ctx.values.PROJECT_NAME, directory: ctx.root, removeVolumes: !!options.volumes, docker: [...ctx.compose, ...args]}, null, 2));
    return;
  }
  await withLock(ctx, async () => {
    if (options.volumes) console.error('删除本项目数据库和附件卷: ' + ctx.values.PROJECT_NAME);
    await ctx.run(args);
  });
}

export async function restart(ctx, names, options) {
  const services = serviceNames(names);
  await withLock(ctx, async () => {
    await ctx.run(['restart', '--timeout', String(options.timeout), ...services]);
    await start(ctx, services, options.waitTimeout);
  });
}

export async function status(ctx, options) {
  const args = ['ps', '--all'];
  if (options.json) {
    const raw = await ctx.run([...args, '--format', 'json'], {capture: true});
    let result;
    try { result = raw ? JSON.parse(raw) : []; }
    catch { result = raw.split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    console.log(JSON.stringify(Array.isArray(result) ? result : [result], null, 2));
  } else await ctx.run(args);
}

export async function build(ctx, options) {
  await withLock(ctx, () => ctx.run(['build', ...(options.pull ? ['--pull'] : []), ...(options.cache === false ? ['--no-cache'] : []), 'odoo']));
}

export async function maintainModules(ctx, operation, names, options) {
  const modules = checkModuleNames(names);
  if (operation === 'install' && !modules.length) throw new Error('请指定至少一个要安装的模块。');
  if (operation === 'update' && !modules.length && !options.all) throw new Error('请指定模块名，或使用 --all 升级已安装的项目扩展。');
  if (options.all && modules.length) throw new Error('--all 不能与模块名同时使用。');
  if (options.database) databaseName(options.database);
  await withLock(ctx, async () => {
    await ctx.run(['up', '-d', '--wait', 'db']);
    await ctx.run(['stop', 'odoo']);
    const args = ['run', '--rm', '--no-deps', '-T'];
    if (options.database) args.push('--env', 'PGDATABASE=' + options.database);
    args.push('--entrypoint', 'python3', 'odoo', '/opt/odoo/scripts/runtime.py', operation === 'install' ? 'install' : 'upgrade', ...modules);
    await ctx.run(args);
    if (options.restart !== false) await start(ctx);
    else console.log('模块维护完成；Odoo 保持停止，可用 odoo up 启动。');
  });
}

async function sql(ctx, database, query) {
  databaseName(database);
  const result = await ctx.run(['exec', '-T', 'db', 'psql', '--no-psqlrc', '--username', ctx.values.PGUSER, '--dbname', database, '--tuples-only', '--no-align', '--command', query], {capture: true});
  return JSON.parse(result || '[]');
}

export async function listDatabases(ctx, options) {
  const data = await sql(ctx, 'postgres', "SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT datname AS name FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname) t");
  const rows = data.map(row => ({...row, current: row.name === ctx.values.PGDATABASE}));
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) console.log((row.current ? '* ' : '  ') + row.name);
}

export async function listModules(ctx, options) {
  const database = options.database || ctx.values.PGDATABASE;
  const data = await sql(ctx, database, `SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT name, state, latest_version AS version FROM ir_module_module ${options.all ? '' : "WHERE state = 'installed'"} ORDER BY name) t`);
  if (options.json) console.log(JSON.stringify(data, null, 2));
  else for (const row of data) console.log(`${row.name.padEnd(40)} ${row.state.padEnd(14)} ${row.version || '-'}`);
}

async function validateZip(ctx, filename) {
  const fd = fs.openSync(filename, 'r');
  try { await ctx.run(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'python3', 'odoo', '/opt/odoo/scripts/backup_utils.py', 'validate'], {stdio: [fd, 'inherit', 'inherit']}); }
  finally { fs.closeSync(fd); }
}

export async function backup(ctx, options) {
  const database = databaseName(options.database || ctx.values.PGDATABASE);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.resolve(options.file || path.join(archiveDirectory(ctx.values), database + '-' + stamp + '.zip'));
  if (fs.existsSync(target)) throw new Error('存档已存在: ' + target);
  await withLock(ctx, async () => {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    const temporary = target + '.part';
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      await ctx.run(['exec', '-T', 'odoo', 'odoo', 'db', '-c', '/etc/odoo/odoo.conf', 'dump', database, '-'], {stdio: ['ignore', fd, 'inherit']});
      fs.closeSync(fd);
      fd = undefined;
      await validateZip(ctx, temporary);
      fs.linkSync(temporary, target);
      console.log('存档已保存: ' + target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, {force: true});
    }
  });
}

export async function restore(ctx, options) {
  const source = path.resolve(options.file);
  if (!fs.statSync(source, {throwIfNoEntry: false})?.isFile()) throw new Error('请提供已有的 ZIP 存档。');
  const database = databaseName(options.database || ctx.values.PGDATABASE);
  await withLock(ctx, async () => {
    await validateZip(ctx, source);
    await ctx.run(['up', '-d', '--wait', 'db']);
    await ctx.run(['stop', 'odoo']);
    const args = ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'python3', 'odoo', '/opt/odoo/scripts/backup_utils.py', 'restore', database];
    if (options.force) args.push('--force');
    const fd = fs.openSync(source, 'r');
    try { await ctx.run(args, {stdio: [fd, 'inherit', 'inherit']}); }
    finally { fs.closeSync(fd); }
    if (options.restart !== false) await start(ctx);
    console.log('已恢复并中和外发任务: ' + database);
    if (database !== ctx.values.PGDATABASE) console.log('使用新库时，将项目 .env 中的 PGDATABASE 改为 ' + database + '。');
  });
}

export async function native(ctx, args) {
  if (!args.length) throw new Error('请指定官方 Odoo 参数，例如 odoo exec -- --version。');
  await ctx.run(['exec', ...(!process.stdin.isTTY || !process.stdout.isTTY ? ['-T'] : []), 'odoo', 'odoo', ...args]);
}
