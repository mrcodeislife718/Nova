#!/usr/bin/env node
import fs from 'node:fs';
import { analyze, formatDiagnostic } from './index.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const input = args.find((arg) => !arg.startsWith('--'));

if (!input || args.includes('-h') || args.includes('--help')) {
  console.log('Usage: nova <file.cannon> [--json]');
  process.exit(input ? 0 : 1);
}

let source;
try {
  source = fs.readFileSync(input, 'utf8');
} catch (error) {
  console.error(`nova: ${error.message}`);
  process.exit(2);
}

const result = analyze(source, { file: input });
if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  const entries = Object.values(result.bindings);
  console.log(`${input}: Nova analysis passed`);
  for (const binding of entries) console.log(`${binding.name}: ${binding.type}`);
} else {
  for (const diagnostic of result.diagnostics) console.error(formatDiagnostic(diagnostic, source));
}
process.exit(result.ok ? 0 : 1);
