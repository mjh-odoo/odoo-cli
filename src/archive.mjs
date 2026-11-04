import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function catalogFile() {
  const home = os.homedir();
  const appData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return process.env.ODOO_MANAGER_CATALOG || path.join(appData, 'Odoo Manager', 'manager.sqlite');
}

function gitCommonDirectory(root) {
  try {
    const value = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']});
    return fs.realpathSync(value.trim());
  } catch { return null; }
}

function resolveProject(db, root, optional) {
  const direct = db.prepare('SELECT * FROM projects WHERE root = ?').get(root);
  if (direct) return direct;
  const common = gitCommonDirectory(root);
  if (!common && optional) return null;
  if (!common) throw new Error('请先在 Odoo Manager 接入当前项目。');
  const matches = db.prepare('SELECT * FROM projects').all()
    .filter(project => gitCommonDirectory(project.root) === common);
  if (!matches.length && optional) return null;
  if (matches.length !== 1) throw new Error(matches.length ? '当前工作树匹配了多个项目，请从已接入的项目目录执行。' : '请先在 Odoo Manager 接入当前项目。');
  return matches[0];
}

export async function withArchiveCatalog(root, write, action, {optional = false} = {}) {
  const file = catalogFile();
  if (!fs.statSync(file, {throwIfNoEntry: false})?.isFile()) {
    if (optional) return null;
    throw new Error('找不到本机存档库，请先在 Odoo Manager 接入项目。');
  }
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(file, {readOnly: !write});
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const project = resolveProject(db, root, optional);
    if (!project) return null;
    if (write) ensureArchiveTags(db);
    return await action(db, project);
  } finally { db.close(); }
}

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function ensureArchiveTags(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS archive_tags (
      projectId TEXT NOT NULL REFERENCES projects(id),
      tag TEXT NOT NULL,
      archiveId TEXT NOT NULL REFERENCES archives(id),
      PRIMARY KEY (projectId, tag)
    );
    CREATE TABLE IF NOT EXISTS project_seeds (
      projectId TEXT PRIMARY KEY REFERENCES projects(id), reference TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_runtimes (
      root TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), composeProject TEXT NOT NULL
    )`);
    if (hasTable(db, 'archive_defaults')) {
      db.exec(`INSERT OR IGNORE INTO archive_tags
        SELECT projectId, 'latest', archiveId FROM archive_defaults;
        DROP TABLE archive_defaults;`);
    }
  });
}

export function projectTags(db, projectId) {
  if (hasTable(db, 'archive_tags')) {
    return db.prepare('SELECT tag, archiveId FROM archive_tags WHERE projectId = ? ORDER BY tag').all(projectId);
  }
  if (hasTable(db, 'archive_defaults')) {
    return db.prepare("SELECT 'latest' AS tag, archiveId FROM archive_defaults WHERE projectId = ?").all(projectId);
  }
  return [];
}

export async function archiveList(root, {json}) {
  const result = await withArchiveCatalog(root, false, (db, project) => {
    const tags = projectTags(db, project.id);
    const rows = db.prepare('SELECT id, title, note, environment, database, bytes, created, revision, source FROM archives WHERE projectId = ? ORDER BY created DESC').all(project.id);
    return rows.map(archive => ({...archive, tags: tags.filter(tag => tag.archiveId === archive.id).map(tag => tag.tag)}));
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (!result.length) console.log('此项目还没有数据库存档。');
  else for (const archive of result) console.log([archive.id, archive.title, archive.database, archive.tags.join(', ')].filter(Boolean).join('  '));
}

function findArchive(db, projectId, id, requireFile = true) {
  const row = db.prepare('SELECT * FROM archives WHERE projectId = ? AND id = ?').get(projectId, id);
  if (!row) throw new Error('此项目没有该存档：' + id);
  if (requireFile && (!path.isAbsolute(row.file) || !fs.statSync(row.file, {throwIfNoEntry: false})?.isFile())) {
    throw new Error('存档 ZIP 已丢失或不可用：' + id + '。请在 Odoo Manager 检查存档。');
  }
  return row;
}

export function tagName(value) {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(value)) throw new Error('标签须以小写字母开头，最多 64 字符，可包含小写字母、数字、点、下划线和短横线。');
  return value;
}

function findReference(db, projectId, reference) {
  if (reference.startsWith('id:')) return findArchive(db, projectId, reference.slice(3));
  const tags = projectTags(db, projectId);
  const explicitTag = reference.startsWith('tag:');
  const tag = explicitTag ? tagName(reference.slice(4)) : reference === 'default' ? 'latest' : reference;
  const selected = tags.find(row => row.tag === tag);
  if (!selected && (explicitTag || reference === 'default' || reference === 'latest')) throw new Error('此项目尚未设置标签：' + tag);
  return findArchive(db, projectId, selected?.archiveId || reference);
}

export async function resolveArchive(root, reference) {
  return withArchiveCatalog(root, false, (db, project) => findReference(db, project.id, reference));
}

export async function archiveSeed(root, reference, {json} = {}) {
  const result = await withArchiveCatalog(root, reference !== undefined, (db, project) => {
    if (reference !== undefined) transaction(db, () => {
      if (reference.startsWith('tag:')) tagName(reference.slice(4));
      else if (reference.startsWith('id:')) findReference(db, project.id, reference);
      else if (reference !== 'empty') throw new Error('数据来源使用 tag:<标签>、id:<存档ID> 或 empty。');
      db.prepare('INSERT INTO project_seeds VALUES (?, ?) ON CONFLICT(projectId) DO UPDATE SET reference = excluded.reference')
        .run(project.id, reference);
    });
    return hasTable(db, 'project_seeds') ? db.prepare('SELECT reference FROM project_seeds WHERE projectId = ?').get(project.id)?.reference : null;
  });
  console.log(json ? JSON.stringify({reference: result || 'empty'}) : (result || 'empty'));
}

export async function startupSeed(root, values, preview = false) {
  if (values.ENV === 'PROD' || values.ODOO_SEED_MODE === 'empty' ||
      (values.ODOO_SEED && values.ODOO_SEED_MODE !== 'first-start')) return {reference: null, source: 'env'};
  const configured = values.ODOO_SEED && values.ODOO_SEED_MODE === 'first-start' ? values.ODOO_SEED : null;
  return await withArchiveCatalog(root, false, (db, project) => {
    const projectSeed = root !== project.root && hasTable(db, 'project_seeds') ? db.prepare('SELECT reference FROM project_seeds WHERE projectId = ?').get(project.id)?.reference : null;
    const reference = configured || projectSeed || null;
    const source = configured ? 'env' : 'project';
    if (!reference || reference === 'empty') return {reference: null, source};
    if (!preview) return {reference, source};
    try {
      const archive = findReference(db, project.id, reference);
      return {reference, source, archive: {id: archive.id, title: archive.title}};
    } catch (error) { return {reference, source, issue: error.message}; }
  }, {optional: true}) || {reference: configured, source: configured ? 'env' : 'project',
    ...(configured && preview ? {issue: '请先在 Odoo Manager 接入当前项目。'} : {})};
}

export async function rememberRuntime(root, composeProject) {
  return withArchiveCatalog(root, true, (db, project) => {
    if (root === project.root) return;
    db.prepare('INSERT INTO project_runtimes VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET composeProject = excluded.composeProject')
      .run(root, project.id, composeProject);
  }, {optional: true});
}

export async function archiveTags(root, {json}) {
  const rows = await withArchiveCatalog(root, false, (db, project) =>
    projectTags(db, project.id).map(row => ({...row, title: findArchive(db, project.id, row.archiveId, false).title})));
  if (json) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) console.log(row.tag + ' → ' + row.title + ' (' + row.archiveId + ')');
}

export async function archiveTag(root, tag, id) {
  tagName(tag);
  await withArchiveCatalog(root, true, (db, project) => transaction(db, () => {
    if (!id) {
      db.prepare('DELETE FROM archive_tags WHERE projectId = ? AND tag = ?').run(project.id, tag);
      console.log('已移除标签：' + tag);
      return;
    }
    const row = findArchive(db, project.id, id);
    pointTag(db, project.id, tag, row.id);
    console.log(tag + ' → ' + row.title + ' (' + row.id + ')');
  }));
}

export async function archiveDefault(root, id) {
  if (id) return archiveTag(root, 'latest', id);
  const selected = await withArchiveCatalog(root, false, (db, project) => projectTags(db, project.id).find(row => row.tag === 'latest'));
  console.log(selected?.archiveId || '此项目尚未设置 latest。');
}

export async function deleteArchive(root, id) {
  await withArchiveCatalog(root, true, (db, project) => transaction(db, () => {
    const row = findArchive(db, project.id, id, false);
    const tags = projectTags(db, project.id).filter(tag => tag.archiveId === id);
    if (tags.length) throw new Error('请先移动或移除标签：' + tags.map(row => row.tag).join(', '));
    if (db.prepare('SELECT 1 FROM project_seeds WHERE projectId = ? AND reference = ?').get(project.id, 'id:' + id)) {
      throw new Error('该存档用于新工作树首次启动，请先更改项目的数据来源。');
    }
    if (!path.isAbsolute(row.file) || path.basename(row.file) !== row.id + '.zip') throw new Error('无法确认存档文件位置。');
    fs.rmSync(row.file, {force: true});
    db.prepare('DELETE FROM archives WHERE projectId = ? AND id = ?').run(project.id, id);
    console.log('已删除存档：' + row.title);
  }));
}

export function pointTag(db, projectId, tag, id) {
  db.prepare('INSERT INTO archive_tags VALUES (?, ?, ?) ON CONFLICT(projectId, tag) DO UPDATE SET archiveId = excluded.archiveId')
    .run(projectId, tag, id);
}

export function insertArchive(db, archive) {
  const {id, projectId, title, note, environment, database, file, bytes, created, revision, source} = archive;
  db.prepare('INSERT INTO archives (id, projectId, title, note, environment, database, file, bytes, created, revision, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, title, note, environment, database, file, bytes, created, revision, source);
}

export function saveArchive(db, archive, tag) {
  transaction(db, () => {
    insertArchive(db, archive);
    if (tag) pointTag(db, archive.projectId, tag, archive.id);
  });
}

export function archiveLocation(db, root, id) {
  const settings = JSON.parse(db.prepare('SELECT value FROM settings WHERE id = 1').get()?.value || '{}');
  if (typeof settings.archiveRoot !== 'string' || !path.isAbsolute(settings.archiveRoot)) {
    throw new Error('请在 Odoo Manager 设置存档目录。');
  }
  fs.mkdirSync(settings.archiveRoot, {recursive: true});
  const directory = fs.realpathSync(settings.archiveRoot);
  const roots = [root, ...db.prepare('SELECT root FROM environments').all().map(env => env.root)];
  if (roots.some(checkout => {
    const relative = path.relative(checkout, directory);
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  })) throw new Error('请选择项目和工作树之外的存档目录。');
  return path.join(directory, id + '.zip');
}

export function archiveSource(db, project, root) {
  const name = db.prepare('SELECT name FROM environments WHERE projectId = ? AND root = ?').get(project.id, root)?.name;
  let revision = '';
  try {
    const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
    revision = git(['rev-parse', 'HEAD']) + (git(['status', '--porcelain']) ? '（有未提交改动）' : '');
  } catch { /* Git metadata is optional. */ }
  return {environment: name || path.basename(root), revision};
}
