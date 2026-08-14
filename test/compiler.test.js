import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceFile, InferEngine, compile, structuredDiagnostics } from '../src/index.js';

test('source model returns exact line and column spans', () => {
  const file = new SourceFile('demo.cannon', 'let x = 1\nreturn x\n');
  assert.deepEqual(file.position(8), { file: 'demo.cannon', offset: 8, line: 1, column: 9 });
  assert.deepEqual(file.position(10), { file: 'demo.cannon', offset: 10, line: 2, column: 1 });
});

test('Infer Engine handles numeric widening and nullable values', () => {
  const infer = new InferEngine();
  infer.bind('x', infer.inferLiteral(1));
  infer.bind('x', infer.inferLiteral(2.5));
  infer.bind('maybe', infer.inferLiteral(null));
  infer.bind('maybe', infer.inferLiteral('value'));
  const snapshot = infer.snapshot();
  assert.equal(snapshot.bindings.x.type.kind, 'float');
  assert.equal(snapshot.bindings.maybe.type.kind, 'nullable');
});

test('Nova compiles Cannon IR to JavaScript, WASM, and native C', async () => {
  const js = compile('const x = 2 + 3\nreturn x', { file: 'demo.cannon', target: 'javascript' });
  assert.equal(js.ok, true);
  assert.match(js.output.code, /export default/);
  assert.equal(js.ir.kind, 'cannon-ir');

  const wasm = compile('return 7', { target: 'wasm' });
  assert.equal(wasm.ok, true);
  assert.equal(WebAssembly.validate(wasm.output.binary), true);
  const instance = await WebAssembly.instantiate(wasm.output.binary);
  assert.equal(instance.instance.exports.main(), 7);

  const native = compile('const x = 5\nreturn x', { target: 'native' });
  assert.equal(native.ok, true);
  assert.match(native.output.code, /int64_t cannon_main/);
});

test('Nova produces structured source-aware diagnostics', () => {
  const result = compile('const x = 1\nx = "bad"', { file: 'bad.cannon' });
  assert.equal(result.ok, false);
  const diagnostics = structuredDiagnostics(result);
  assert.ok(diagnostics.some((d) => d.code === 'NOVA-S1002' || d.code === 'NOVA-T1001'));
  assert.equal(diagnostics[0].file, 'bad.cannon');
});
