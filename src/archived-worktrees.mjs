import fs from 'node:fs';
import path from 'node:path';
import { projectNameForPath } from './lib/environment.mjs';
import { execFileSync } from 'node:child_process';
import { withArchiveCatalog } from './archive.mjs';

const managedVolumes = ['db-data', 'odoo-data'];

async function retired(root) {
  return await withArchiveCatalog(root, false, (db, project) => {
    const roots = db.prepare("SELECT root, name FROM environments WHERE projectId = ? AND kind = 'worktree'").all(project.id);
    const names = new Map(roots.map(row => [row.root, row.name]));
    const runtimes = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'project_runtimes'").get()
      ? db.prepare('SELECT root, composeProject FROM project_runtimes WHERE projectId = ?').all(project.id) : [];
    const rows = new Map(roots.map(row => [row.root, projectNameForPath(row.root)]));
    for (const row of runtimes) rows.set(row.root, row.composeProject);
    return [...rows].filter(([directory]) => directory !== project.root && !fs.existsSync(directory))
      .map(([directory, composeProject]) => ({
        root: directory, composeProject, name: names.get(directory) || path.basename(directory),
        managed: composeProject === projectNameForPath(directory), repository: project.root,
      }));
  }) || [];
}

async function exactVolumes(docker, composeProject) {
  const raw = await docker(['volume', 'ls', '--quiet', '--filter', 'label=com.docker.compose.project=' + composeProject]);
  return managedVolumes.map(kind => composeProject + '_' + kind).filter(name => raw.split(/\r?\n/).includes(name));
}

export async function archivedWorktrees(root, docker) {
  const rows = await retired(root);
  if (!rows.length) return [];
  const usage = await docker(['system', 'df', '-v', '--format', 'json']).then(raw => JSON.parse(raw).Volumes || []).catch(() => []);
  const sizes = new Map(usage.map(row => [row.Name, row.Size]));
  return Promise.all(rows.map(async row => {
    const volumes = row.managed ? await exactVolumes(docker, row.composeProject) : [];
    return {...row, volumes: volumes.map(name => ({name, size: sizes.get(name) || null}))};
  }));
}

export async function cleanArchivedWorktree(root, composeProject, docker) {
  const row = (await retired(root)).find(row => row.composeProject === composeProject);
  if (!row?.managed) throw new Error('仅可清理路径已移除且使用自动 Compose 标识的已归档工作树。');
  const check = () => {
    if (fs.existsSync(row.root)) throw new Error('工作树已恢复，请刷新列表。');
    const registered = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: row.repository, timeout: 5000, encoding: 'utf8',
    }).split('\0');
    if (registered.includes('worktree ' + row.root)) throw new Error('Git 仍登记此工作树，请先完成归档。');
  };
  check();
  const containers = await docker(['ps', '-a', '-q', '--filter', 'label=com.docker.compose.project=' + composeProject]);
  if (containers) throw new Error('该环境仍有 Docker 容器，请先完成停止和归档。');
  const volumes = await exactVolumes(docker, composeProject);
  if (volumes.length) {
    const inspected = JSON.parse(await docker(['volume', 'inspect', ...volumes]));
    if (inspected.length !== volumes.length || inspected.some(row =>
      row.Labels?.['com.docker.compose.project'] !== composeProject ||
      row.Name !== composeProject + '_' + row.Labels?.['com.docker.compose.volume'] ||
      !volumes.includes(row.Name))) throw new Error('卷归属发生变化，请刷新后再试。');
    check();
    await docker(['volume', 'rm', ...volumes]);
  }
  return volumes;
}
