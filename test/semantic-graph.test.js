import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildSemanticGraph, verifySemanticGraph } from '../src/index.js';

function artifact(ast, source = 'fixture') {
  const body = {
    protocol: 'cannon-frontend/1',
    frontendVersion: 'cannon/test',
    file: 'fixture.cannon',
    sourceDigest: crypto.createHash('sha256').update(source).digest('hex'),
    ast
  };
  return { ...body, artifactDigest: digest(body) };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
  return value;
}

test('Nova semantic graph gives declarations and references stable identities', () => {
  const graph = buildSemanticGraph(artifact({
    type: 'Program',
    body: [
      { type: 'VariableDeclaration', kind: 'let', name: 'count', value: { type: 'Literal', value: 1 } },
      { type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: { type: 'Identifier', name: 'print' }, arguments: [{ type: 'Identifier', name: 'count' }] } }
    ]
  }));
  assert.equal(graph.protocol, 'nova-semantic/1');
  assert.equal(graph.diagnostics.length, 0);
  assert.equal(verifySemanticGraph(graph).ok, true);
  const binding = graph.nodes.find((node) => node.kind === 'binding' && node.name === 'count');
  const reference = graph.nodes.find((node) => node.kind === 'reference' && node.name === 'count');
  assert.ok(binding);
  assert.ok(reference);
  assert.ok(graph.edges.some((edge) => edge.kind === 'refers-to' && edge.from === reference.id && edge.to === binding.id));
});

test('Nova semantic graph records function calls, effects, and async boundaries', () => {
  const graph = buildSemanticGraph(artifact({
    type: 'Program',
    body: [
      {
        type: 'FunctionDeclaration', name: 'worker', params: ['value'], async: true,
        body: { type: 'BlockStatement', body: [
          { type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: { type: 'Identifier', name: 'print' }, arguments: [{ type: 'Identifier', name: 'value' }] } },
          { type: 'ReturnStatement', value: { type: 'AwaitExpression', argument: { type: 'Identifier', name: 'value' } } }
        ] }
      },
      { type: 'AssignmentStatement', target: { type: 'Identifier', name: 'result' }, value: { type: 'CallExpression', callee: { type: 'Identifier', name: 'worker' }, arguments: [{ type: 'Literal', value: 42 }] } }
    ]
  }));
  const worker = graph.nodes.find((node) => node.kind === 'function' && node.name === 'worker');
  assert.deepEqual(worker.effects, ['io.console']);
  assert.ok(graph.nodes.some((node) => node.kind === 'expression' && node.expressionKind === 'await' && node.asyncBoundary));
  assert.ok(graph.edges.some((edge) => edge.kind === 'calls' && edge.to === worker.id));
  assert.equal(verifySemanticGraph(graph).ok, true);
});

test('Nova semantic graph verification rejects tampering', () => {
  const graph = buildSemanticGraph(artifact({ type: 'Program', body: [] }));
  const changed = structuredClone(graph);
  changed.nodes.push({ id: 'tampered', kind: 'binding', name: 'x', file: 'fixture.cannon', astPath: [] });
  assert.equal(verifySemanticGraph(changed).ok, false);
});
