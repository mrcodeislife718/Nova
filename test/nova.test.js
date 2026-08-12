import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, assertValid, formatDiagnostic } from '../src/index.js';

test('Nova infers primitive Cannon bindings', () => {
  const result = analyze('name = "Charles"\nage = 44\nactive = true', { file: 'app.cannon' });
  assert.equal(result.ok, true);
  assert.equal(result.bindings.name.type, 'string');
  assert.equal(result.bindings.age.type, 'integer');
  assert.equal(result.bindings.active.type, 'boolean');
});

test('Nova records binding origin and assignment locations', () => {
  const result = assertValid('count = 1\ncount = 2', { file: 'counter.cannon' });
  assert.deepEqual(result.bindings.count.origin, { file: 'counter.cannon', line: 1, column: 1, endColumn: 6 });
  assert.equal(result.bindings.count.assignments.length, 2);
});

test('Nova reports conflicting inferred types with provenance', () => {
  const source = 'age = 44\nage = "old"';
  const result = analyze(source, { file: 'user.cannon' });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'NOVA-T1001');
  assert.equal(result.diagnostics[0].line, 2);
  assert.equal(result.diagnostics[0].origin.line, 1);
  const message = formatDiagnostic(result.diagnostics[0], source);
  assert.match(message, /user\.cannon:2:/);
  assert.match(message, /first inferred as integer/);
});
