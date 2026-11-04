import fs from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { archiveLocation, insertArchive, pointTag, projectTags, tagName, transaction, withArchiveCatalog } from './archive.mjs';

const filename = 'odoo-archives.json';
const validId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const textFields = ['title', 'note', 'environment', 'database', 'created', 'revision'];

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function checkedCopy(source, target, size, hash) {
  const info = await lstat(source);
  if (!info.isFile() || info.size !== size) throw new Error('ZIP 不存在或大小不符：' + path.basename(source));
  await copyFile(source, target, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  const result = await digest(target);
  if (hash && result !== hash) throw new Error('ZIP 校验失败：' + path.basename(source));
  return result;
}

export async function exportLibrary(root, destination) {
  const inventory = await withArchiveCatalog(root, false, (db, project) => {
    db.exec('BEGIN');
    try {
      const archives = db.prepare('SELECT * FROM archives WHERE projectId = ? ORDER BY created').all(project.id);
      const tags = projectTags(db, project.id);
      const seed = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'project_seeds'").get()
        ? db.prepare('SELECT reference FROM project_seeds WHERE projectId = ?').get(project.id)?.reference : undefined;
      return {project: project.name, archives, tags, seed};
    } finally { db.exec('COMMIT'); }
  });
  if (!inventory.archives.length) throw new Error('当前项目没有可导出的存档。');
  const folder = path.resolve(destination);
  const parent = fs.realpathSync(path.dirname(folder));
  const checkout = path.relative(root, parent);
  if (!checkout || (!path.isAbsolute(checkout) && checkout !== '..' && !checkout.startsWith('..' + path.sep))) {
    throw new Error('请将存档库导出到项目目录之外。');
  }
  await mkdir(folder, {mode: 0o700});
  try {
    const archives = [];
    for (const archive of inventory.archives) {
      if (!validId.test(archive.id)) throw new Error('不支持的存档 ID：' + archive.id);
      const sha256 = await checkedCopy(archive.file, path.join(folder, archive.id + '.zip'), archive.bytes);
      archives.push({id: archive.id, ...Object.fromEntries(textFields.map(key => [key, archive[key]])), bytes: archive.bytes, source: archive.source, sha256});
    }
    await writeFile(path.join(folder, filename), JSON.stringify({format: 1, ...inventory, archives}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    return {directory: folder, archives: archives.length, tags: inventory.tags.length};
  } catch (error) {
    await rm(folder, {recursive: true, force: true});
    throw error;
  }
}

async function readInventory(folder) {
  const file = path.join(folder, filename);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('存档库索引文件无效。');
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data?.format !== 1 || !Array.isArray(data.archives) || !data.archives.length || !Array.isArray(data.tags)) {
    throw new Error('请选择包含 odoo-archives.json 的存档库目录。');
  }
  const ids = new Set();
  for (const row of data.archives) {
    if (!row || typeof row.id !== 'string' || !validId.test(row.id) || ids.has(row.id) ||
        !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !/^[a-f0-9]{64}$/.test(row.sha256) ||
        !['backup', 'import'].includes(row.source) || textFields.some(key => typeof row[key] !== 'string') ||
        !row.title.trim() || row.title.length > 120 || row.note.length > 2000 || !Number.isFinite(Date.parse(row.created))) {
      throw new Error('存档库的存档记录无效。');
    }
    ids.add(row.id);
  }
  const tags = new Set();
  for (const row of data.tags) {
    if (!row || typeof row.tag !== 'string' || tags.has(tagName(row.tag)) || !ids.has(row.archiveId)) throw new Error('存档库的标签记录无效。');
    tags.add(row.tag);
  }
  if (data.seed !== undefined && data.seed !== 'empty' &&
    !(typeof data.seed === 'string' && (data.seed.startsWith('tag:') ? tagName(data.seed.slice(4)) :
      data.seed.startsWith('id:') && ids.has(data.seed.slice(3))))) throw new Error('存档库的首次启动来源无效。');
  return data;
}

export async function importLibrary(root, source) {
  const folder = fs.realpathSync(path.resolve(source));
  const manifest = await readInventory(folder);
  return withArchiveCatalog(root, true, async (db, project) => {
    const existing = db.prepare('SELECT * FROM archives WHERE id = ?');
    const staged = [], added = [], skippedTags = [];
    let retained = 0;
    try {
      for (const row of manifest.archives) {
        const file = path.join(folder, row.id + '.zip');
        const prior = existing.get(row.id);
        if (prior) {
          if (prior.projectId !== project.id || prior.bytes !== row.bytes || await digest(prior.file) !== row.sha256) {
            throw new Error('本机已有内容不同或属于其他项目的存档：' + row.id);
          }
          retained++;
          continue;
        }
        const target = archiveLocation(db, root, row.id);
        const temporary = target + '.' + randomUUID() + '.part';
        staged.push({temporary, archive: {...row, projectId: project.id, file: target}});
        await checkedCopy(file, temporary, row.bytes, row.sha256);
      }
      transaction(db, () => {
        for (const {temporary, archive} of staged) {
          fs.linkSync(temporary, archive.file);
          added.push(archive.file);
          insertArchive(db, archive);
        }
        const tags = new Map(projectTags(db, project.id).map(tag => [tag.tag, tag.archiveId]));
        for (const row of manifest.tags) {
          if (!tags.has(row.tag)) pointTag(db, project.id, row.tag, row.archiveId);
          else if (tags.get(row.tag) !== row.archiveId) skippedTags.push(row.tag);
        }
        if (manifest.seed) db.prepare('INSERT INTO project_seeds VALUES (?, ?) ON CONFLICT(projectId) DO NOTHING').run(project.id, manifest.seed);
      });
      return {imported: staged.length, retained, skippedTags};
    } catch (error) {
      for (const file of added) fs.rmSync(file, {force: true});
      throw error;
    } finally {
      for (const {temporary} of staged) fs.rmSync(temporary, {force: true});
    }
  });
}
