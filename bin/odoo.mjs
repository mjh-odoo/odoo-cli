#!/usr/bin/env node
import fs from 'node:fs';
import { createProgram } from '../src/cli.mjs';

const {version} = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
try {
  await createProgram({version}).parseAsync(process.argv);
} catch (error) {
  console.error('错误: ' + error.message);
  process.exitCode = error.exitCode || 1;
}
