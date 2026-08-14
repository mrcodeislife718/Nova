import test from 'node:test';
import assert from 'node:assert/strict';
import { ExactSourceMap, analyzeContracts, compile, buildDebugMetadata, verifyDebugMetadata } from '../src/index.js';

test('ExactSourceMap preserves exact offsets line and column across multiline input', () => {
  const source = 'first\n  second\nthird';
  const map = new ExactSourceMap(source, 'proof.cannon');
  assert.deepEqual(map.position(0), { file:'proof.cannon', offset:0, line:1, column:1 });
  assert.deepEqual(map.position(6), { file:'proof.cannon', offset:6, line:2, column:1 });
  assert.deepEqual(map.position(8), { file:'proof.cannon', offset:8, line:2, column:3 });
  assert.deepEqual(map.position(source.indexOf('third')), { file:'proof.cannon', offset:15, line:3, column:1 });
});

test('Nova infers function returns, direct/transitive effects, and async call graph boundaries', () => {
  const source = `
fn logValue(value: i32) -> i32 {
  print(value)
  return 1
}

async fn load(id: i32) -> string {
  fetch("/users")
  return "ready"
}

async fn orchestrate(id: i32) -> string {
  logValue(id)
  await load(id)
  return "done"
}
`;
  const result = analyzeContracts(source, { file:'contracts.cannon' });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.functions.logValue.inferredReturn, 'integer');
  assert.deepEqual(result.functions.logValue.effects, ['io.console']);
  assert.deepEqual(result.functions.load.effects, ['io.network']);
  assert.deepEqual(result.functions.orchestrate.effects, ['io.console','io.network']);
  assert.equal(result.functions.orchestrate.asyncBoundary, true);
  assert.ok(result.callGraph.some((edge) => edge.from === 'orchestrate' && edge.to === 'load' && edge.awaited));
});

test('Nova rejects await in non-async functions and async calls without await with exact spans', () => {
  const source = `async fn remote() -> i32 {\n  return 1\n}\nfn bad() -> i32 {\n  await remote()\n  return 1\n}\nfn alsoBad() -> i32 {\n  remote()\n  return 1\n}`;
  const result = analyzeContracts(source, { file:'bad.cannon' });
  assert.equal(result.ok, false);
  const awaitDiagnostic = result.diagnostics.find((entry) => entry.code === 'NOVA-A1001');
  assert.ok(awaitDiagnostic);
  assert.equal(awaitDiagnostic.span.start.file, 'bad.cannon');
  assert.equal(awaitDiagnostic.span.start.line, 5);
  assert.equal(awaitDiagnostic.span.start.column, 9);
  const missingAwait = result.diagnostics.find((entry) => entry.code === 'NOVA-A1002' && entry.span.start.line === 9);
  assert.ok(missingAwait);
  assert.equal(missingAwait.span.start.column, 3);
});

test('Nova verifies declared return type conflicts at the return expression span', () => {
  const source = 'fn mismatch() -> i32 {\n  return "wrong"\n}';
  const result = analyzeContracts(source, { file:'return.cannon' });
  const diagnostic = result.diagnostics.find((entry) => entry.code === 'NOVA-F1002');
  assert.ok(diagnostic);
  assert.equal(diagnostic.span.start.line, 2);
  assert.equal(diagnostic.span.start.column, 10);
  assert.equal(diagnostic.span.start.offset, source.indexOf('"wrong"'));
  assert.equal(diagnostic.span.end.offset, source.indexOf('"wrong"') + '"wrong"'.length);
});

test('Nova debug metadata is deterministic, source-linked, and tamper evident for Cortex', () => {
  const compiled = compile('const x = 2 + 3\nreturn x', { file:'debug.cannon', target:'javascript' });
  assert.equal(compiled.ok, true);
  const first = buildDebugMetadata(compiled.ir, { file:'debug.cannon', compilerVersion:'nova-test' });
  const second = buildDebugMetadata(compiled.ir, { file:'debug.cannon', compilerVersion:'nova-test' });
  assert.equal(first.digest, second.digest);
  assert.equal(verifyDebugMetadata(first, compiled.ir).ok, true);
  assert.equal(first.mappings.length, compiled.ir.sourceMap.length);
  assert.ok(first.mappings.every((mapping) => mapping.id && mapping.span?.start?.file));
  const tampered = structuredClone(first);
  tampered.mappings[0].ir = 999;
  assert.equal(verifyDebugMetadata(tampered, compiled.ir).ok, false);
});
