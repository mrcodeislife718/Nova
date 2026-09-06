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
function resign(graph) {
  const { digest: _old, ...body } = graph;
  graph.digest = digest(body);
  return graph;
}

test('Nova semantic graph gives declarations and references stable identities', () => {
  const frontend = artifact({
    type: 'Program',
    body: [
      { type: 'VariableDeclaration', kind: 'let', name: 'count', value: { type: 'Literal', value: 1 } },
      { type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: { type: 'Identifier', name: 'print' }, arguments: [{ type: 'Identifier', name: 'count' }] } }
    ]
  });
  const graph = buildSemanticGraph(frontend);
  assert.equal(graph.protocol, 'nova-semantic/1');
  assert.equal(graph.diagnostics.length, 0);
  assert.equal(verifySemanticGraph(graph, { frontendArtifact: frontend }).ok, true);
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

test('Nova semantic graph verification rejects ordinary tampering', () => {
  const graph = buildSemanticGraph(artifact({ type: 'Program', body: [] }));
  const changed = structuredClone(graph);
  changed.nodes.push({ id: 'tampered', kind: 'binding', name: 'x', file: 'fixture.cannon', astPath: [] });
  assert.equal(verifySemanticGraph(changed).ok, false);
});

test('Nova rejects a re-digested graph with forged deterministic node identity', () => {
  const graph = structuredClone(buildSemanticGraph(artifact({
    type:'Program',
    body:[{ type:'VariableDeclaration', kind:'let', name:'x', value:{ type:'Literal', value:1 } }]
  })));
  const node = graph.nodes.find((entry) => entry.kind === 'binding');
  const oldId = node.id;
  node.id = '0'.repeat(32);
  for (const edge of graph.edges) {
    if (edge.from === oldId) edge.from = node.id;
    if (edge.to === oldId) edge.to = node.id;
  }
  resign(graph);
  const result = verifySemanticGraph(graph);
  assert.equal(result.ok, false);
  assert.match(result.reason, /node identity mismatch/);
});

test('Nova rejects duplicate semantic identities even when graph digest is recomputed', () => {
  const graph = structuredClone(buildSemanticGraph(artifact({ type:'Program', body:[] })));
  graph.nodes.push(structuredClone(graph.nodes[0]));
  graph.nodes.sort((a,b) => a.id.localeCompare(b.id));
  resign(graph);
  const result = verifySemanticGraph(graph);
  assert.equal(result.ok, false);
  assert.match(result.reason, /duplicate semantic node id/);
});

test('Nova rejects forged edge identity after attacker recomputes graph digest', () => {
  const graph = structuredClone(buildSemanticGraph(artifact({
    type:'Program',
    body:[{ type:'VariableDeclaration', kind:'let', name:'x', value:{ type:'Literal', value:1 } }]
  })));
  assert.ok(graph.edges.length > 0);
  graph.edges[0].id = 'f'.repeat(32);
  resign(graph);
  const result = verifySemanticGraph(graph);
  assert.equal(result.ok, false);
  assert.match(result.reason, /edge identity mismatch/);
});

test('Nova binds semantic graph to the exact verified frontend artifact when supplied', () => {
  const first = artifact({ type:'Program', body:[] }, 'first');
  const second = artifact({ type:'Program', body:[] }, 'second');
  const graph = buildSemanticGraph(first);
  assert.equal(verifySemanticGraph(graph, { frontendArtifact:first }).ok, true);
  const mismatch = verifySemanticGraph(graph, { frontendArtifact:second });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /source digest does not match/);
});
