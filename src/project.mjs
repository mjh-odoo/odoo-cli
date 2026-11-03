import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareEnv, readEnv, validateEnv } from './lib/environment.mjs';

export function findProject(start = process.cwd()) {
  let root = fs.realpathSync(path.resolve(start));
  if (!fs.statSync(root).isDirectory()) throw new Error('项目路径必须是目录。');
  while (true) {
    if (fs.existsSync(path.join(root, 'compose.yaml')) && fs.existsSync(path.join(root, '.env.example'))) return root;
    const parent = path.dirname(root);
    if (parent === root) throw new Error('没有找到兼容的 Odoo base 项目。请进入项目目录，或使用 odoo --project <目录>。');
    root = parent;
  }
}

export function databaseName(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name || '') || Buffer.byteLength(name) > 63) throw new Error('数据库名必须是 1..63 字节的字母、数字或下划线，且不能以数字开头。');
  return name;
}

export function serviceNames(names, fallback = ['odoo']) {
  const result = [...new Set((names.length ? names : fallback).flatMap(value => value === 'all' ? ['odoo', 'db'] : [value]))];
  if (result.some(name => !['odoo', 'db'].includes(name))) throw new Error('服务只能是 odoo、db 或 all。');
  return result;
}

export async function runDocker(argv, {root, env, stdio = 'inherit', capture = false}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, {cwd: root, env, shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : stdio});
    const out = [], err = [];
    let size = 0, failure;
    if (capture) for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { failure = new Error('Docker 输出超过 8 MiB，请缩小查询范围。'); child.kill(); }
      else chunks.push(chunk);
    });
    child.once('error', error => reject(new Error('无法执行 Docker: ' + error.message)));
    child.once('close', (code, signal) => {
      if (failure) reject(failure);
      else if (code === 0) resolve(capture ? Buffer.concat(out).toString('utf8').trim() : '');
      else {
        const error = new Error(`Docker 操作失败 (${signal || code})${capture ? ': ' + Buffer.concat(err).toString('utf8').trim() : '，请查看上方输出。'}`);
        error.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
        reject(error);
      }
    });
  });
}

export async function openProject(root, {initialize = false, runner = runDocker} = {}) {
  const values = initialize ? await prepareEnv(root) : validateEnv(readEnv(root));
  const env = {...process.env, ...values};
  const compose = ['compose', '--file', path.join(root, 'compose.yaml'), '--project-directory', root, '--env-file', path.join(root, '.env'), '--project-name', values.PROJECT_NAME];
  const docker = (args, io = {}) => runner(args, {root, env, ...io});
  const run = (args, io) => docker([...compose, ...args], io);
  return {root, values, env, compose, docker, run};
}

export async function withLock(ctx, action) {
  const lock = path.join(ctx.root, '.local', 'operation.lock');
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('本项目存在进行中的维护操作。若操作曾中断，请先核对 .local/operation.lock/owner.json 中的进程，再清理过期锁。');
    throw error;
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid, started: new Date().toISOString()}), {mode: 0o600});
  try { return await action(); }
  finally { fs.rmSync(lock, {recursive: true, force: true}); }
}

export function projectVersion(root) {
  const filename = path.join(root, 'package.json');
  if (!fs.existsSync(filename)) return '0.1.0';
  return JSON.parse(fs.readFileSync(filename, 'utf8')).version || '0.1.0';
}
