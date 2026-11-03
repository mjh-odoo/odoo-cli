import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

export function imageBuildPlan(args, {root, version, mirror = ''}) {
  const values = parseArgs({args, options: {
    platform: {type: 'string'}, tag: {type: 'string'}, file: {type: 'string'},
    target: {type: 'string', default: 'base'}, builder: {type: 'string'},
    push: {type: 'boolean', default: false}, 'dry-run': {type: 'boolean', default: false},
  }}).values;
  if (!['base', 'production'].includes(values.target)) throw new Error('Use --target base or production.');
  if (values.push && !values.tag) throw new Error('--push requires an explicit --tag.');
  if (values.target === 'production' && !values.tag) throw new Error('production requires an explicit --tag.');
  if (values.push && values.file) throw new Error('--push and --file cannot be combined.');
  const tag = values.tag ?? `mjh-odoo/odoo-runtime:20.0-v${version}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/.test(tag)) throw new Error('Invalid image tag.');
  if (values.file !== undefined && !values.file.trim()) throw new Error('--file must name an output archive.');
  if (values.builder !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(values.builder)) throw new Error('Invalid builder name.');
  const platforms = [];
  if (values.platform !== undefined) {
    for (const value of values.platform.split(',')) {
      const platform = value.startsWith('linux/') ? value : `linux/${value}`;
      if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Supported platforms: amd64, arm64 (or linux/amd64, linux/arm64).');
      if (!platforms.includes(platform)) platforms.push(platform);
    }
  }
  if (platforms.length > 1 && !values.push) throw new Error('Multiple platforms require --push. Export offline archives one platform at a time.');
  if (mirror) {
    let url;
    try { url = new URL(mirror); } catch { throw new Error('Invalid APT_MIRROR_BASE URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\r\n]/.test(mirror)) throw new Error('APT_MIRROR_BASE must be an HTTP(S) URL without credentials.');
  }
  const file = values.file ? path.resolve(values.file) : undefined;
  const argv = ['buildx', 'build', '--file', path.join(root, 'Dockerfile'), '--target', values.target, '--tag', tag];
  if (values.builder) argv.push('--builder', values.builder);
  if (platforms.length) argv.push('--platform', platforms.join(','));
  if (mirror) argv.push('--build-arg', `APT_MIRROR_BASE=${mirror}`);
  if (file) argv.push('--output', 'type=docker,dest=-');
  else argv.push(values.push ? '--push' : '--load');
  argv.push(root);
  return {target: values.target, tag, platforms, output: file ? 'archive' : values.push ? 'registry' : 'local', file, dryRun: values['dry-run'], argv};
}

export async function executeImageBuild(plan, run) {
  if (plan.file && fs.existsSync(plan.file)) throw new Error('Archive already exists: ' + plan.file);
  await run(['buildx', 'version']);
  if (!plan.file) {
    await run(plan.argv);
    return;
  }
  fs.mkdirSync(path.dirname(plan.file), {recursive: true});
  const temporary = plan.file + '.' + randomUUID() + '.part';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    await run(plan.argv, ['ignore', fd, 'inherit']);
    fs.closeSync(fd);
    fd = undefined;
    if (!fs.statSync(temporary).size) throw new Error('Docker produced an empty archive.');
    fs.linkSync(temporary, plan.file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, {force: true});
  }
}
