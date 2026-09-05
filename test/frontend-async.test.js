import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { compileFrontendArtifact } from '../src/index.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function artifact(ast) {
  const body = { protocol: 'cannon-frontend/1', frontendVersion: 'cannon/test', file: 'async.cannon', sourceDigest: digest(ast), ast };
  return { ...body, artifactDigest: digest(body) };
}

test('Nova retains async function identity and await expressions in Cannon IR v2', async () => {
  const input = artifact({
    type: 'Program',
    body: [
      { type: 'FunctionDeclaration', name: 'resolve', params: ['value'], async: true, body: { type: 'BlockStatement', body: [
        { type: 'ReturnStatement', value: { type: 'AwaitExpression', argument: { type: 'Identifier', name: 'value' } } }
      ] } },
      { type: 'FunctionDeclaration', name: 'main', params: [], async: true, body: { type: 'BlockStatement', body: [
        { type: 'ReturnStatement', value: { type: 'AwaitExpression', argument: { type: 'CallExpression', callee: { type: 'Identifier', name: 'resolve' }, arguments: [{ type: 'Literal', value: 42 }] } } }
      ] } },
      { type: 'AssignmentStatement', target: { type: 'Identifier', name: 'result' }, value: { type: 'CallExpression', callee: { type: 'Identifier', name: 'main' }, arguments: [] } }
    ]
  });
  const compiled = compileFrontendArtifact(input);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.ir.body[0].async, true);
  assert.equal(compiled.ir.body[0].body.body[0].value.kind, 'await');
  assert.match(compiled.output.code, /async function resolve/);
  assert.match(compiled.output.code, /await resolve\(42\)/);
  const context = { Promise };
  vm.createContext(context);
  vm.runInContext(`${compiled.output.code}\nglobalThis.__result = result;`, context);
  assert.equal(await context.__result, 42);
});
