import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogOptions, logArguments, parseLogEvents, selectLogEvents, secretMask, executeLogs } from '../src/lib/logs.mjs';

const row = (service, n, text) => `${service}-1  | 2026-11-03T01:00:${String(n).padStart(2, '0')}.000000000Z ${text}`;
const lines = [
  row('odoo', 0, '2026-11-03 01:00:00,000 1 INFO demo odoo.http: before'),
  row('odoo', 1, '2026-11-03 01:00:01,000 1 ERROR demo odoo.http: request failed'),
  row('db', 2, '2026-11-03 01:00:02.000 UTC [23] LOG: checkpoint'),
  row('odoo', 3, 'Traceback (most recent call last):'),
  row('odoo', 4, '  File "/addons/my_module/models.py", line 7, in run'),
  row('odoo', 5, 'ValueError: invalid value'),
  row('odoo', 6, 'During handling of the above exception, another exception occurred:'),
  row('odoo', 7, 'Traceback (most recent call last):'),
  row('odoo', 8, 'RuntimeError: second error'),
  row('db', 9, '2026-11-03 01:00:09.000 UTC [23] ERROR: relation missing'),
  row('db', 10, '2026-11-03 01:00:10.000 UTC [23] STATEMENT: select * from missing'),
  row('odoo', 11, '2026-11-03 01:00:11,000 1 INFO demo odoo.http: after'),
];

test('logs default to a finite timestamped snapshot with explicit service selection', () => {
  const options = parseLogOptions([]);
  assert.equal(options.follow, false);
  assert.equal(options.tail, '200');
  assert.deepEqual(options.services, ['odoo']);
  assert.deepEqual(logArguments(options), ['logs', '--no-color', '--timestamps', '--tail', '200', 'odoo']);
  const all = parseLogOptions(['all', 'db', '-f', '-n', '50', '--since', '1h30m']);
  assert.deepEqual(all.services, ['odoo', 'db']);
  assert.ok(logArguments(all).includes('--follow'));
  assert.equal(parseLogOptions(['--until', '2026-11-03T09:00:00+08:00']).until, '2026-11-03T09:00:00+08:00');
});

test('unsupported inputs and snapshot-only options fail before Docker or file creation', () => {
  for (const args of [['unknown'], ['--tail', '-1'], ['--tail', '100001'], ['--since', 'yesterday'], ['--since', '2026-11-03'], ['--level', 'broken'], ['--match', ''], ['--context', '101'], ['--unknown'], ['-f', '--json'], ['-f', '--level', 'error'], ['-f', '--hide-health'], ['-f', '--file', 'x']]) assert.throws(() => parseLogOptions(args));
});

test('Python tracebacks and PostgreSQL statement context survive interleaved services', () => {
  const parsed = parseLogEvents(lines);
  assert.equal(parsed.diagnostics.length, 0);
  const selected = selectLogEvents(parsed.events, parseLogOptions(['all', '--level', 'error', '--context', '0']));
  assert.equal(selected.matched, 2);
  assert.equal(selected.events.length, 2);
  assert.ok(selected.events[0].message.includes('ValueError: invalid value'));
  assert.ok(selected.events[0].message.includes('RuntimeError: second error'));
  assert.ok(selected.events[0].message.includes('my_module/models.py'));
  assert.equal(selected.events[0].database, 'demo');
  assert.ok(selected.events[1].message.includes('STATEMENT: select * from missing'));
  assert.equal(selected.events[1].service, 'db');
});

test('literal search and severity filters combine while context is identified without duplicates', () => {
  const parsed = parseLogEvents(lines);
  const options = parseLogOptions(['--level', 'error', '--match', 'MY_MODULE', '--context', '1']);
  const selected = selectLogEvents(parsed.events, options);
  assert.equal(selected.matched, 1);
  assert.equal(selected.events.length, 3);
  assert.equal(selected.events.filter(event => !event.context).length, 1);
  const overlapping = selectLogEvents(parsed.events, parseLogOptions(['--level', 'error', '--context', '1']));
  assert.equal(overlapping.events.length, 5);
  assert.equal(overlapping.matched, 2);
  const raw = parseLogEvents([row('odoo', 0, 'Traceback (most recent call last):'), row('odoo', 1, 'TypeError: broken'), row('odoo', 2, '2026-11-03 01:00:02,000 1 INFO demo odoo.http: next')]);
  assert.equal(raw.events[0].level, 'error');
  const warning = parseLogEvents([row('odoo', 0, '2026-11-03 01:00:00,000 1 WARNING demo odoo.http: recoverable'), row('odoo', 1, 'Traceback (most recent call last):'), row('odoo', 2, 'ValueError: handled')]);
  assert.equal(warning.events[0].level, 'warning');
  assert.equal(selectLogEvents(warning.events, parseLogOptions(['--level', 'error'])).matched, 0);
  assert.equal(selectLogEvents(parsed.events, parseLogOptions(['--level', 'critical'])).events.length, 0);
});

test('known secrets and ANSI escapes are removed using literal values', () => {
  const secret = 'p@ss[$]\\word';
  const mask = secretMask({PGPASSWORD: secret, ODOO_MASTER_PASSWORD: 'other-password', ENV: 'DEV'});
  assert.equal(mask(`\x1b[31m${secret} ${encodeURIComponent(secret)}\x1b[0m`), '[REDACTED] [REDACTED]');
});


test('hiding health checks preserves failures and keeps useful context within the scanned window', async () => {
  const http = (n, route, status) => row('odoo', n, `2026-11-03 01:00:00,000 1 INFO demo odoo.http.server: 127.0.0.1 "GET ${route} HTTP/1.1" ${status} 5`);
  const source = [
    http(0, '/web/health?db_server_status=1', 200),
    http(1, '/web/health', 503),
    http(2, '/web/health/details', 200),
    row('odoo', 3, '2026-11-03 01:00:03,000 1 ERROR demo odoo.addons.demo: failed'),
    row('odoo', 4, 'Traceback (most recent call last):'),
    row('odoo', 5, 'ValueError: bad input'),
    http(6, '/web/health', 204),
    row('db', 7, '2026-11-03 01:00:07.000 UTC [23] LOG: checkpoint'),
  ];
  async function snapshot(args) {
    let output;
    await executeLogs(parseLogOptions(['all', '--json', ...args]), {
      values: {PROJECT_NAME: 'test'}, compose: ['compose'], read: async () => ({lines: source}),
      stdout: {write: text => { output = text; }},
    });
    return JSON.parse(output);
  }
  const result = await snapshot(['--hide-health', '--tail', '7', '--level', 'error', '--context', '1']);
  assert.equal(result.hiddenHealth, 2);
  assert.equal(result.tailReached, true);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.events.map(event => event.context), [true, false, true]);
  assert.match(result.events[0].message, /health\/details/);
  assert.match(result.events[1].message, /ValueError: bad input/);
  assert.equal(result.events[2].service, 'db');
  const visible = await snapshot(['--hide-health']);
  assert.match(visible.events[0].message, /503/);
  assert.equal(visible.tailReached, false);
  assert.equal((await snapshot([])).hiddenHealth, 0);
});
