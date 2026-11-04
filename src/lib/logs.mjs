import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs, stripVTControlCharacters } from 'node:util';

const levels = {debug: 10, info: 20, warning: 30, error: 40, critical: 50};
const sourceLimit = 16 * 1024 * 1024;
const lineLimit = 1024 * 1024;

function validTime(value) {
  if (!value || /[\r\n]/.test(value)) return false;
  if (/^\d+(?:\.\d+)?$/.test(value)) return true;
  if (/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(value)) return true;
  return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}

export function parseLogOptions(args) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    follow: {type: 'boolean', short: 'f', default: false},
    tail: {type: 'string', short: 'n', default: '200'},
    since: {type: 'string'}, until: {type: 'string'}, level: {type: 'string'},
    match: {type: 'string'}, context: {type: 'string'}, 'hide-health': {type: 'boolean', default: false},
    json: {type: 'boolean', default: false}, file: {type: 'string'},
  }});
  const services = [...new Set((positionals.length ? positionals : ['odoo']).flatMap(service => service === 'all' ? ['odoo', 'db'] : [service]))];
  if (services.some(service => !['odoo', 'db'].includes(service))) throw new Error('日志服务只能是 odoo、db 或 all。');
  if (values.tail !== 'all' && (!/^\d+$/.test(values.tail) || +values.tail > 100000)) throw new Error('--tail 必须为 0..100000 或 all。');
  for (const key of ['since', 'until']) if (values[key] !== undefined && !validTime(values[key])) throw new Error(`--${key} 需要时长、Unix 时间戳或带时区的 RFC3339 时间。`);
  const level = values.level?.toLowerCase();
  if (level !== undefined && !Object.hasOwn(levels, level)) throw new Error('无效的 --level。');
  if (values.match !== undefined && (!values.match.trim() || /[\r\n]/.test(values.match))) throw new Error('--match 需要非空的单行文本。');
  if (values.context !== undefined && (!/^\d+$/.test(values.context) || +values.context > 100)) throw new Error('--context 必须为 0..100。');
  if (values.file !== undefined && !values.file.trim()) throw new Error('--file 需要输出文件路径。');
  if (values.follow && (level || values.match || values.context !== undefined || values['hide-health'] || values.json || values.file)) throw new Error('级别、关键词、上下文、JSON 和文件导出用于快照；持续跟随请单独使用 -f。');
  return {...values, level, services, context: +(values.context ?? 2), file: values.file ? path.resolve(values.file) : undefined};
}

export function logArguments(options) {
  const argv = ['logs', '--no-color', '--timestamps', '--tail', options.tail];
  if (options.follow) argv.push('--follow');
  if (options.since) argv.push('--since', options.since);
  if (options.until) argv.push('--until', options.until);
  return [...argv, ...options.services];
}

export function secretMask(values) {
  const secrets = [...new Set(Object.entries(values).filter(([key, value]) => /PASSWORD|TOKEN|SECRET|KEY/.test(key) && value).flatMap(([, value]) => [value, encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  return input => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), stripVTControlCharacters(input));
}

function severity(message) {
  const odoo = message.match(/^\d{4}-\d{2}-\d{2} \S+\s+(\d+)\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(\S+)\s+([^:]+):/);
  if (odoo) return {header: true, level: odoo[2].toLowerCase(), database: odoo[3], logger: odoo[4], pid: +odoo[1]};
  const postgres = message.match(/^\d{4}-\d{2}-\d{2} .*?\[(\d+)\]\s+(DEBUG\d?|INFO|NOTICE|LOG|WARNING|ERROR|FATAL|PANIC):/);
  if (postgres) {
    const key = postgres[2];
    return {header: true, level: /^(FATAL|PANIC)$/.test(key) ? 'critical' : /^(LOG|NOTICE)$/.test(key) ? 'info' : key.startsWith('DEBUG') ? 'debug' : key.toLowerCase(), pid: +postgres[1]};
  }
  if (/^Traceback \(most recent call last\):/.test(message) || /^(?:[\w]+\.)*[\w]*(?:Error|Exception):/.test(message)) return {level: 'error'};
  return {};
}

export function parseLogEvents(lines) {
  const pending = new Map(), events = [], diagnostics = [];
  const flush = key => { if (pending.has(key)) { events.push(pending.get(key)); pending.delete(key); } };
  for (const [index, raw] of lines.entries()) {
    const match = raw.match(/^(\S+)\s+\|\s?(\d{4}-\d{2}-\d{2}T\S+)\s?(.*)$/);
    if (!match) { diagnostics.push(raw); continue; }
    const [, container, timestamp, message] = match;
    const meta = severity(message);
    const current = pending.get(container);
    if (meta.header || (meta.level === 'error' && !current?.level)) flush(container);
    if (!pending.has(container)) {
      const service = container.match(/(?:^|[-_])(odoo|db)(?:[-_]\d+)?$/)?.[1] || container;
      const {header, ...fields} = meta;
      pending.set(container, {service, container, timestamp, level: null, ...fields, messages: [], lines: [], index});
    }
    const event = pending.get(container);
    event.messages.push(message);
    event.lines.push(raw);
  }
  for (const key of pending.keys()) flush(key);
  events.sort((a, b) => (Date.parse(a.timestamp) - Date.parse(b.timestamp)) || a.index - b.index);
  return {events: events.map(({messages, ...event}) => ({...event, message: messages.join('\n')})), diagnostics};
}

function isSuccessfulHealthCheck(event) {
  return event.service === 'odoo' && event.level === 'info' && event.lines.length === 1 &&
    (event.logger === 'odoo.http.server' || event.logger === 'werkzeug') &&
    /"(?:GET|HEAD) \/web\/health(?:\?[^"\s]*)? HTTP\/\d+(?:\.\d+)?"\s+2\d{2}(?:\s|$)/.test(event.message);
}

function reachedTail(events, tail) {
  if (tail === 'all' || Number(tail) === 0) return false;
  const counts = new Map();
  for (const event of events) {
    const count = (counts.get(event.container) || 0) + event.lines.length;
    if (count >= Number(tail)) return true;
    counts.set(event.container, count);
  }
  return false;
}

export function selectLogEvents(events, options) {
  const matching = events.map(event => (!options.level || (levels[event.level] ?? 0) >= levels[options.level]) && (!options.match || event.message.toLowerCase().includes(options.match.toLowerCase())));
  const selected = new Set();
  matching.forEach((matched, index) => {
    if (matched) for (let n = Math.max(0, index - options.context); n <= Math.min(events.length - 1, index + options.context); n++) selected.add(n);
  });
  return {matched: matching.filter(Boolean).length, events: events.flatMap((event, index) => selected.has(index) ? [{...event, context: !matching[index]}] : [])};
}

async function dockerLines(argv, {root, env, follow, onLine}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, {cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    const lines = [], diagnostics = [];
    let bytes = 0, failure, interrupted = 0;
    const signal = number => { interrupted = number; child.kill('SIGINT'); };
    const onInterrupt = () => signal(130), onTerminate = () => signal(143);
    if (follow) { process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate); }
    const cleanup = () => { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); };
    for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      let partial = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        const segments = chunk.toString().split('\n');
        for (const [index, segment] of segments.entries()) {
          partial += Buffer.byteLength(segment);
          if (partial > lineLimit) failure = new Error('日志单行超过 1 MiB，请缩小日志范围或降低源日志详细程度。');
          if (index < segments.length - 1) partial = 0;
        }
        if (!follow && bytes > sourceLimit) failure = new Error('日志快照超过 16 MiB，请缩小 --tail 或 --since 范围。');
        if (failure) child.kill();
      });
      const reader = createInterface({input: stream, crlfDelay: Infinity});
      reader.on('line', line => {
        if (failure) return;
        if (follow) onLine(line, kind);
        else lines.push(line);
        if (kind === 'stderr') {
          diagnostics.push(line);
          if (diagnostics.length > 15) diagnostics.shift();
        }
      });
    }
    child.once('error', error => { cleanup(); reject(new Error('无法读取 Docker 日志: ' + error.message)); });
    child.once('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (interrupted) resolve({lines, interrupted});
      else if (code !== 0) reject(new Error(`Docker 日志读取失败 (${code}): ${diagnostics.slice(-15).join('\n')}`));
      else resolve({lines, interrupted: 0});
    });
  });
}

export async function executeLogs(options, {root, env, values, compose, read = dockerLines, stdout = process.stdout, stderr = process.stderr}) {
  if (options.file && fs.existsSync(options.file)) throw new Error('日志文件已存在: ' + options.file);
  const mask = secretMask(values);
  const maskLine = input => {
    const clean = stripVTControlCharacters(input);
    const envelope = clean.match(/^(\S+\s+\|\s?\d{4}-\d{2}-\d{2}T\S+\s?)(.*)$/);
    return envelope ? envelope[1] + mask(envelope[2]) : mask(clean);
  };
  let result;
  try {
    result = await read([...compose, ...logArguments(options)], {root, env, follow: options.follow, onLine: (line, kind) => {
      const stream = kind === 'stderr' && !line.includes(' |') ? stderr : stdout;
      stream.write(maskLine(line) + '\n');
    }});
  } catch (error) { throw new Error(mask(error.message)); }
  if (options.follow) return result.interrupted;
  // Parse original structure before redaction: a password such as "odoo"
  // must not change service attribution or severity detection.
  const {events, diagnostics: rawDiagnostics} = parseLogEvents(result.lines.map(line => stripVTControlCharacters(line)));
  const diagnostics = rawDiagnostics.map(mask);
  const candidates = options['hide-health'] ? events.filter(event => !isSuccessfulHealthCheck(event)) : events;
  const selection = selectLogEvents(candidates, options);
  const selected = {matched: selection.matched, events: selection.events.map(event => ({
    ...event, message: mask(event.message), lines: event.lines.map(maskLine),
    ...(event.logger ? {logger: mask(event.logger)} : {}),
    ...(event.database ? {database: mask(event.database)} : {}),
  }))};
  const exported = selected.events.map(({lines, index, ...event}) => event);
  const payload = {project: values.PROJECT_NAME, services: options.services, query: {tail: options.tail, since: options.since, until: options.until, level: options.level, match: options.match ? mask(options.match) : undefined, context: options.context, hideHealth: options['hide-health']}, scanned: events.length, hiddenHealth: events.length - candidates.length, tailReached: reachedTail(events, options.tail), matched: selected.matched, shown: exported.length, diagnostics, events: exported};
  const output = options.json ? JSON.stringify(payload, null, 2) + '\n' : selected.events.flatMap(event => event.lines).join('\n') + (selected.events.length ? '\n' : '');
  if (!options.json) for (const line of diagnostics) stderr.write(line + '\n');
  if (options.file) {
    fs.mkdirSync(path.dirname(options.file), {recursive: true});
    fs.writeFileSync(options.file, output, {flag: 'wx', mode: 0o600});
    stderr.write('日志快照已保存: ' + options.file + '\n');
  } else stdout.write(output);
  if (!options.json && !selected.events.length) stderr.write('没有匹配的日志。\n');
  return 0;
}
