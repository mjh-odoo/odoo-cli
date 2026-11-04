import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { archiveDirectory, checkModuleNames, publicSettings } from './lib/environment.mjs';
import { databaseName, openProject, serviceNames, withLock } from './project.mjs';
import { archiveLocation, archiveSource, resolveArchive, saveArchive, startupSeed, rememberRuntime, tagName, withArchiveCatalog } from './archive.mjs';

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
    const seed = await startupSeed(ctx.root, ctx.values);
    await rememberRuntime(ctx.root, ctx.values.PROJECT_NAME);
    if (seed.reference) {
      await seedDatabase(ctx, options, seed.reference);
      await start(ctx, ['odoo'], options.waitTimeout);
      console.log('Odoo: http://localhost:' + ctx.values.ODOO_HTTP_PORT);
      return;
    }
    if (readRecovery(ctx)?.database === ctx.values.PGDATABASE) throw new Error('当前数据库恢复尚未完成，请先处理恢复任务。');
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
    if (options.volumes) for (const file of [originsFile(ctx), recoveryFile(ctx)]) fs.rmSync(file, {force: true});
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

function databases(ctx) {
  return sql(ctx, 'postgres', "SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT datname AS name FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname) t");
}

export async function listDatabases(ctx, options) {
  const origins = readOrigins(ctx);
  const pending = readRecovery(ctx);
  const rows = (await databases(ctx)).map(row => ({...row, current: row.name === ctx.values.PGDATABASE, origin: origins[row.name]}));
  if (pending) {
    const row = rows.find(row => row.name === pending.database);
    const recovery = {recoverable: pending.disposable};
    if (row) row.recovery = recovery;
    else rows.push({name: pending.database, current: pending.database === ctx.values.PGDATABASE, recovery});
  }
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) console.log((row.current ? '* ' : '  ') + row.name + (row.recovery ? '  待恢复处理' : ''));
}

export async function listModules(ctx, options) {
  const database = options.database || ctx.values.PGDATABASE;
  const data = await sql(ctx, database, `SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT name, state, latest_version AS version FROM ir_module_module ${options.all ? '' : "WHERE state = 'installed'"} ORDER BY name) t`);
  if (options.json) console.log(JSON.stringify(data, null, 2));
  else for (const row of data) console.log(`${row.name.padEnd(40)} ${row.state.padEnd(14)} ${row.version || '-'}`);
}

async function validateZip(ctx, filename, {quiet = false, build = false} = {}) {
  const fd = fs.openSync(filename, 'r');
  try { await ctx.run(['run', '--rm', '--no-deps', '-T', ...(build ? ['--build'] : []), '--entrypoint', 'python3', 'odoo', '/opt/odoo/scripts/backup_utils.py', 'validate'], {stdio: [fd, quiet ? 'ignore' : 2, 'inherit']}); }
  finally { fs.closeSync(fd); }
}

async function writeBackup(ctx, database, target) {
  if (fs.existsSync(target)) throw new Error('存档已存在: ' + target);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temporary = target + '.' + randomUUID() + '.part';
  let fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    await ctx.run(['exec', '-T', 'odoo', 'odoo', 'db', '-c', '/etc/odoo/odoo.conf', 'dump', database, '-'], {stdio: ['ignore', fd, 'inherit']});
    fs.closeSync(fd);
    fd = undefined;
    await validateZip(ctx, temporary);
    fs.linkSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, {force: true});
  }
}

export async function backup(ctx, options) {
  const database = databaseName(options.database || ctx.values.PGDATABASE);
  if (options.name !== undefined) {
    const title = options.name.trim();
    const note = (options.note || '').trim();
    const tag = options.tag === undefined ? undefined : tagName(options.tag);
    if (!title || title.length > 120 || note.length > 2000) throw new Error('请填写有效存档名称，名称最多 120 字，备注最多 2000 字。');
    return withArchiveCatalog(ctx.root, true, (db, project) => withLock(ctx, async () => {
      if (readRecovery(ctx)?.database === database) throw new Error('该数据库恢复尚未完成，无法保存存档。');
      const id = randomUUID();
      const file = archiveLocation(db, ctx.root, id);
      const {environment, revision} = archiveSource(db, project, ctx.root);
      await writeBackup(ctx, database, file);
      let archive;
      try {
        archive = {id, projectId: project.id, title, note, environment, database, file,
          bytes: fs.statSync(file).size, created: new Date().toISOString(), revision, source: 'backup', tags: tag ? [tag] : []};
        saveArchive(db, archive, tag);
      } catch (error) {
        fs.rmSync(file, {force: true});
        throw error;
      }
      console.log(options.json ? JSON.stringify(archive) : '存档已保存：' + title + ' (' + id + ')' + (tag ? ' · ' + tag : ''));
    }));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.resolve(options.file || path.join(archiveDirectory(ctx.values), database + '-' + stamp + '.zip'));
  await withLock(ctx, () => {
    if (readRecovery(ctx)?.database === database) throw new Error('该数据库恢复尚未完成，无法导出。');
    return writeBackup(ctx, database, target);
  });
  console.log('存档已保存: ' + target);
}

export async function importArchive(ctx, filename, {name, json}) {
  const original = path.resolve(filename);
  const title = (name ?? path.basename(original).replace(/\.zip$/i, '').slice(0, 120)).trim();
  if (!title || title.length > 120) throw new Error('请填写存档名称，最多 120 字。');
  if (!fs.statSync(original, {throwIfNoEntry: false})?.isFile()) throw new Error('请提供已有的 Odoo ZIP 存档。');
  await withArchiveCatalog(ctx.root, true, async (db, project) => {
    const id = randomUUID();
    const file = archiveLocation(db, ctx.root, id);
    const temporary = file + '.part';
    try {
      fs.copyFileSync(original, temporary, fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
      await validateZip(ctx, temporary, {quiet: json, build: true});
      fs.linkSync(temporary, file);
      const row = {id, projectId: project.id, title, note: '', environment: '本机导入', database: '',
        file, bytes: fs.statSync(file).size, created: new Date().toISOString(), revision: '', source: 'import'};
      try { saveArchive(db, row); }
      catch (error) { fs.rmSync(file, {force: true}); throw error; }
      console.log(json ? JSON.stringify(row) : '已导入存档：' + title + ' (' + id + ')');
    } finally { fs.rmSync(temporary, {force: true}); }
  });
}

const originsFile = ctx => path.join(ctx.root, '.local', 'db-origins.json');

function readOrigins(ctx) {
  try { return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(originsFile(ctx), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return Object.create(null); throw error; }
}

function recordOrigin(ctx, database, archive, reference) {
  const origins = readOrigins(ctx);
  if (archive) origins[database] = {id: archive.id, title: archive.title, reference, created: archive.created};
  else if (Object.hasOwn(origins, database)) delete origins[database];
  else return;
  writeEnv(originsFile(ctx), JSON.stringify(origins, null, 2) + '\n', 0o600);
}

const dbMaintenance = ['run', '--rm', '--no-deps', '-T'];
const dbReady = ['up', '-d', '--wait', 'db'];

async function runningServices(ctx) {
  return (await ctx.run(['ps', '--status', 'running', '--services'], {capture: true})).split(/\r?\n/);
}

async function loadZip(ctx, source, database, force, container) {
  const args = [...dbMaintenance, '--name', container, '--entrypoint', 'python3', 'odoo', '/opt/odoo/scripts/backup_utils.py', 'restore', database];
  if (force) args.push('--force');
  const fd = fs.openSync(source, 'r');
  try { await ctx.run(args, {stdio: [fd, 'inherit', 'inherit']}); }
  finally { fs.closeSync(fd); }
}

function dropDatabase(ctx, database) {
  return ctx.run([...dbMaintenance, '--entrypoint', 'odoo', 'odoo', 'db', '-c', '/etc/odoo/odoo.conf', 'drop', database]);
}

const recoveryFile = ctx => path.join(ctx.root, '.local', 'db-recovery.json');

function readRecovery(ctx) {
  let record;
  try { record = JSON.parse(fs.readFileSync(recoveryFile(ctx), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!record || typeof record.disposable !== 'boolean' || typeof record.resume !== 'boolean' ||
    !/^mjh-restore-[0-9a-f-]{36}$/.test(record.container)) throw new Error('恢复记录无效，请检查 .local/db-recovery.json。');
  databaseName(record.database);
  return record;
}

async function removeInterrupted(ctx, record) {
  const running = await ctx.docker(['ps', '-a', '--filter', 'name=^/' + record.container + '$', '--format', '{{.Names}}'], {capture: true});
  if (running) throw new Error('恢复容器仍在运行，请等它退出后再重试。');
  if (!record.disposable) throw new Error('上一次覆盖恢复尚未完成。请使用可信 ZIP 重新执行恢复并显式指定 --force。');
  const rows = await databases(ctx);
  if (rows.some(row => row.name === record.database)) await dropDatabase(ctx, record.database);
  recordOrigin(ctx, record.database);
  fs.rmSync(recoveryFile(ctx), {force: true});
}

async function verifyDatabase(ctx, database) {
  const installedTable = await sql(ctx, database, "SELECT to_json(to_regclass('public.ir_module_module') IS NOT NULL)");
  if (installedTable !== true ||
    await sql(ctx, database, "SELECT to_json(EXISTS (SELECT 1 FROM ir_module_module WHERE name = 'base' AND state = 'installed'))") !== true) {
    throw new Error('目标库未完成 Odoo 初始化：' + database);
  }
}

async function restoreChecked(ctx, source, database, {force, disposable, resume, archive, reference}) {
  const record = {database, disposable, resume, container: 'mjh-restore-' + randomUUID()};
  writeEnv(recoveryFile(ctx), JSON.stringify(record), 0o600);
  try {
    console.log('正在恢复数据库和附件：' + database);
    await loadZip(ctx, source, database, force, record.container);
    console.log('正在验证 Odoo 数据库：' + database);
    await verifyDatabase(ctx, database);
    recordOrigin(ctx, database, archive, reference);
    fs.rmSync(recoveryFile(ctx), {force: true});
  } catch (error) {
    if (!disposable) throw error;
    try { await removeInterrupted(ctx, record); }
    catch (cleanup) { throw new Error('恢复失败，目标库已隔离。清理失败：' + cleanup.message, {cause: error}); }
    throw new Error('恢复失败，本次创建的数据库已清理。' + error.message, {cause: error});
  }
}

export async function recoverDatabase(project) {
  await withLock(project, async () => {
    const ctx = await openProject(project.root, {runner: project.runner});
    const record = readRecovery(ctx);
    if (!record) throw new Error('没有待清理的恢复任务。');
    await ctx.run(dbReady);
    await removeInterrupted(ctx, record);
    if (record.resume && record.database !== ctx.values.PGDATABASE) await start(ctx);
    console.log('恢复残留已清理，可以重试。');
  });
}

async function seedDatabase(ctx, {build, pull, waitTimeout}, reference) {
  const database = databaseName(ctx.values.PGDATABASE);
  if (database === 'postgres' || database === 'template0' || database === 'template1') throw new Error('请选择普通开发数据库作为首次加载的目标。');
  const pullArgs = pull ? ['--pull', pull] : [];
  await ctx.run([...dbReady, '--wait-timeout', String(waitTimeout), ...pullArgs]);
  const previous = readRecovery(ctx);
  if (previous?.database === database) await removeInterrupted(ctx, previous);
  const running = await runningServices(ctx);
  const rows = await databases(ctx);
  if (running.includes('odoo') || rows.some(row => row.name !== database)) {
    if (build) await ctx.run(['build', 'odoo']);
    return;
  }
  const exists = rows.some(row => row.name === database);
  if (exists) {
    const relations = await sql(ctx, database, `SELECT to_json(EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%'
      AND c.relkind IN ('r','p','m','v','S','f')))`);
    if (relations === true) {
      if (build) await ctx.run(['build', 'odoo']);
      return;
    }
    if (relations !== false) throw new Error('无法确认目标数据库为空。');
  }
  if (Object.keys(readOrigins(ctx)).length) throw new Error('环境已有恢复记录。请手动恢复数据库，或用 down -v 显式重置环境。');
  const archive = await resolveArchive(ctx.root, reference);
  if (build) await ctx.run(['build', 'odoo']);
  console.log('首次加载存档：' + archive.title + ' (' + archive.id + ')');
  if (readRecovery(ctx)) throw new Error('请先清理上一次恢复。');
  await validateZip(ctx, archive.file);
  await restoreChecked(ctx, archive.file, database, {force: exists, disposable: true, resume: false, archive, reference});
}

export async function restore(project, options) {
  const selected = options.archive ? await resolveArchive(project.root, options.archive) : null;
  const source = selected?.file || path.resolve(options.file);
  if (!fs.statSync(source, {throwIfNoEntry: false})?.isFile()) throw new Error('请提供已有的 ZIP 存档。');
  await withLock(project, async () => {
    if (selected) console.log('恢复存档：' + selected.title + ' (' + selected.id + ')');
    await validateZip(project, source);
    const ctx = await openProject(project.root, {runner: project.runner});
    const database = databaseName(options.database || ctx.values.PGDATABASE);
    if (['postgres', 'template0', 'template1'].includes(database)) throw new Error('请选择普通开发数据库作为恢复目标。');
    await ctx.run(dbReady);
    const previous = readRecovery(ctx);
    if (previous) {
      if (previous.database !== database) throw new Error('请先清理上一次恢复，再恢复另一份数据库。');
      if (previous.disposable) await removeInterrupted(ctx, previous);
      else {
        if (!options.force) throw new Error('上一次覆盖恢复尚未完成，请明确指定 --force 后重试。');
        if (await ctx.docker(['ps', '-a', '--filter', 'name=^/' + previous.container + '$', '--format', '{{.Names}}'], {capture: true})) {
          throw new Error('上一次恢复容器仍在运行。');
        }
      }
    }
    const exists = (await databases(ctx)).some(row => row.name === database);
    if (exists && !options.force) throw new Error('目标数据库已存在，请使用新名称：' + database);
    if (options.use && database === ctx.values.PGDATABASE) throw new Error('恢复并切换需要使用与当前库不同的新名称。');
    const running = (await runningServices(ctx)).includes('odoo');
    const resume = options.restart !== false && (running || previous?.resume || options.legacy === true);
    if (running) await ctx.run(['stop', 'odoo']);
    try {
      await restoreChecked(ctx, source, database, {force: options.force, disposable: !exists && previous?.disposable !== false,
        resume, archive: selected, reference: options.archive});
    } catch (error) {
      if (resume && (database !== ctx.values.PGDATABASE || !exists)) {
        try { await start(ctx); }
        catch (restartError) { throw new Error(error.message + ' 原库重新启动失败：' + restartError.message, {cause: error}); }
      }
      throw error;
    }
    console.log('已恢复并中和外发任务: ' + database);
    if (options.use) {
      try { await selectDatabase(ctx, database, resume); }
      catch (error) {
        if (resume && !(await runningServices(ctx)).includes('odoo')) {
          const latest = await openProject(ctx.root, {runner: ctx.runner});
          if (latest.values.PGDATABASE === ctx.values.PGDATABASE) await start(latest);
        }
        throw error;
      }
    }
    else if (resume) await start(ctx);
  });
}

function writeEnv(filename, content, mode) {
  const temporary = filename + '.' + randomUUID() + '.part';
  fs.writeFileSync(temporary, content, {mode, flag: 'wx'});
  try { fs.renameSync(temporary, filename); }
  finally { fs.rmSync(temporary, {force: true}); }
}

async function selectDatabase(ctx, database, running) {
  const filename = path.join(ctx.root, '.env');
  const original = fs.readFileSync(filename, 'utf8');
  const setting = /^[ \t]*(?:export[ \t]+)?PGDATABASE[ \t]*=[^\r\n]*/gm;
  if ([...original.matchAll(setting)].length !== 1) throw new Error('.env 中需要有且仅有一行 PGDATABASE。');
  const next = original.replace(setting, 'PGDATABASE=' + database);
  const values = parseEnv(next);
  if (values.PGDATABASE !== database || Object.entries(ctx.values).some(([key, value]) => key !== 'PGDATABASE' && values[key] !== value)) {
    throw new Error('无法安全更新 .env 中的 PGDATABASE。');
  }
  if (ctx.values.PGDATABASE === database) {
    console.log('当前数据库：' + database);
    return;
  }
  const mode = fs.statSync(filename).mode & 0o777;
  if (fs.readFileSync(filename, 'utf8') !== original) throw new Error('.env 已被其他操作修改，请重试。');
  writeEnv(filename, next, mode);
  try {
    if (running) await start(await openProject(ctx.root, {runner: ctx.runner}));
  } catch (error) {
    if (fs.readFileSync(filename, 'utf8') !== next) throw new Error('切库失败，且 .env 已有其他改动，请检查当前环境。', {cause: error});
    writeEnv(filename, original, mode);
    try { await start(ctx); }
    catch (rollbackError) { throw new Error('已恢复原数据库配置，但 Odoo 未能重新启动：' + rollbackError.message, {cause: error}); }
    throw new Error('切库失败，已恢复原数据库：' + error.message, {cause: error});
  }
  console.log('数据库已切换到：' + database);
}

export async function useDatabase(project, name) {
  const database = databaseName(name);
  await withLock(project, async () => {
    const ctx = await openProject(project.root, {runner: project.runner});
    const running = await runningServices(ctx);
    if (!running.includes('db')) await ctx.run(dbReady);
    if (readRecovery(ctx)?.database === database) throw new Error('该数据库恢复尚未完成，请先处理恢复任务。');
    if (!(await databases(ctx)).some(row => row.name === database)) throw new Error('目标数据库不存在：' + database);
    await verifyDatabase(ctx, database);
    await selectDatabase(ctx, database, running.includes('odoo'));
  });
}

export async function deleteDatabase(project, name) {
  const database = databaseName(name);
  await withLock(project, async () => {
    const ctx = await openProject(project.root, {runner: project.runner});
    const running = await runningServices(ctx);
    if (readRecovery(ctx)?.database === database) throw new Error('请通过 db recover 清理恢复残留。');
    const live = running.includes('odoo') ? await ctx.run(['exec', '-T', 'odoo', 'printenv', 'PGDATABASE'], {capture: true}) : '';
    if (database === ctx.values.PGDATABASE || database === live) throw new Error('请先切换到另一个数据库。');
    if (!running.includes('db')) await ctx.run(dbReady);
    if (!(await databases(ctx)).some(row => row.name === database)) throw new Error('目标数据库不存在：' + database);
    await dropDatabase(ctx, database);
    recordOrigin(ctx, database);
    console.log('已删除数据库及附件：' + database);
  });
}

export async function native(ctx, args) {
  if (!args.length) throw new Error('请指定官方 Odoo 参数，例如 odoo exec -- --version。');
  await ctx.run(['exec', ...(!process.stdin.isTTY || !process.stdout.isTTY ? ['-T'] : []), 'odoo', 'odoo', ...args]);
}
