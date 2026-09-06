import crypto from 'node:crypto';
import { verifyCannonFrontendArtifact } from './frontend.js';

const PROTOCOL = 'nova-semantic/1';
const BUILTIN_EFFECTS = Object.freeze({
  print: 'io.console',
  readFile: 'io.filesystem.read',
  writeFile: 'io.filesystem.write',
  fetch: 'io.network',
  request: 'io.network',
  spawn: 'process.spawn',
  randomBytes: 'crypto.random'
});

export function buildSemanticGraph(artifact) {
  const verification = verifyCannonFrontendArtifact(artifact);
  if (!verification.ok) throw new Error(`Nova rejected Cannon frontend artifact: ${verification.reason}`);

  const nodes = [];
  const edges = [];
  const diagnostics = [];
  const scopes = [];
  const functionStack = [];
  const nodeById = new Map();

  const addNode = (kind, name, path, metadata = {}) => {
    const id = stableId(artifact.sourceDigest, kind, name ?? '', path.join('.'));
    const node = { id, kind, name: name ?? null, file: artifact.file, astPath: [...path], ...metadata };
    nodes.push(node);
    nodeById.set(id, node);
    return node;
  };
  const addEdge = (kind, from, to, metadata = {}) => {
    if (!from || !to) return null;
    const edge = { id: stableId(artifact.sourceDigest, 'edge', kind, from, to, JSON.stringify(metadata)), kind, from, to, ...metadata };
    edges.push(edge);
    return edge;
  };

  function pushScope(kind, path, owner = null) {
    const node = addNode('scope', null, path, { scopeKind: kind, owner });
    scopes.push({ node, symbols: new Map() });
    if (scopes.length > 1) addEdge('contains', scopes.at(-2).node.id, node.id);
    return node;
  }
  function popScope() { scopes.pop(); }
  function currentScope() { return scopes.at(-1); }
  function define(name, kind, path, metadata = {}) {
    const scope = currentScope();
    if (scope.symbols.has(name)) {
      diagnostics.push({ code: 'NOVA-SEM-DUPLICATE', severity: 'error', message: `Duplicate semantic binding '${name}'`, file: artifact.file, astPath: [...path] });
      return scope.symbols.get(name);
    }
    const symbol = addNode(kind, name, path, metadata);
    scope.symbols.set(name, symbol.id);
    addEdge('declares', scope.node.id, symbol.id);
    return symbol.id;
  }
  function resolve(name) {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const id = scopes[index].symbols.get(name);
      if (id) return id;
    }
    return null;
  }

  function predeclareFunctions(body, path) {
    body.forEach((statement, index) => {
      if (statement?.type !== 'FunctionDeclaration') return;
      const statementPath = [...path, 'body', index];
      define(statement.name, 'function', statementPath, { async: Boolean(statement.async), arity: statement.params.length });
    });
  }

  function visitBody(body, path) {
    predeclareFunctions(body, path);
    body.forEach((statement, index) => visitStatement(statement, [...path, 'body', index]));
  }

  function visitStatement(node, path) {
    if (!node) return;
    switch (node.type) {
      case 'VariableDeclaration': {
        visitExpression(node.value, [...path, 'value']);
        const id = define(node.name, 'binding', path, { bindingKind: node.kind });
        const fn = functionStack.at(-1);
        if (fn) addEdge('contains', fn, id);
        return;
      }
      case 'AssignmentStatement':
        visitExpression(node.value, [...path, 'value']);
        visitAssignmentTarget(node.target, [...path, 'target']);
        return;
      case 'ExpressionStatement': visitExpression(node.expression, [...path, 'expression']); return;
      case 'ReturnStatement': if (node.value) visitExpression(node.value, [...path, 'value']); return;
      case 'FunctionDeclaration': {
        const functionId = resolve(node.name);
        const scope = pushScope('function', [...path, 'scope'], functionId);
        functionStack.push(functionId);
        node.params.forEach((name, index) => define(name, 'parameter', [...path, 'params', index], { index }));
        visitBody(node.body.body, [...path, 'body']);
        functionStack.pop();
        popScope();
        addEdge('owns-scope', functionId, scope.id);
        return;
      }
      case 'IfStatement': {
        visitExpression(node.test, [...path, 'test']);
        visitBlock(node.consequent, [...path, 'consequent']);
        if (node.alternate) node.alternate.type === 'IfStatement' ? visitStatement(node.alternate, [...path, 'alternate']) : visitBlock(node.alternate, [...path, 'alternate']);
        return;
      }
      case 'WhileStatement':
        visitExpression(node.test, [...path, 'test']);
        visitBlock(node.body, [...path, 'body']);
        return;
      case 'BlockStatement': visitBlock(node, path); return;
      default:
        diagnostics.push({ code: 'NOVA-SEM-STMT', severity: 'error', message: `Unsupported Cannon AST statement '${node.type}'`, file: artifact.file, astPath: [...path] });
    }
  }

  function visitBlock(node, path) {
    pushScope('block', [...path, 'scope'], functionStack.at(-1) ?? null);
    visitBody(node.body ?? [], path);
    popScope();
  }

  function visitAssignmentTarget(node, path) {
    if (node?.type === 'Identifier') {
      const target = resolve(node.name);
      if (!target) {
        const id = define(node.name, 'binding', path, { implicit: true, bindingKind: 'let' });
        addReference(node.name, id, path, 'write');
      } else addReference(node.name, target, path, 'write');
      return;
    }
    visitExpression(node, path, 'write');
  }

  function addReference(name, target, path, access = 'read') {
    const reference = addNode('reference', name, path, { access });
    if (target) addEdge(access === 'write' ? 'writes' : 'refers-to', reference.id, target);
    else diagnostics.push({ code: 'NOVA-SEM-UNRESOLVED', severity: 'error', message: `Unresolved semantic reference '${name}'`, file: artifact.file, astPath: [...path] });
    const fn = functionStack.at(-1);
    if (fn) addEdge('contains', fn, reference.id);
    return reference.id;
  }

  function visitExpression(node, path, access = 'read') {
    if (!node) return null;
    switch (node.type) {
      case 'Literal': return addNode('literal', null, path, { valueType: literalType(node.value) }).id;
      case 'Identifier': return addReference(node.name, resolve(node.name), path, access);
      case 'ArrayExpression':
        node.elements.forEach((element, index) => visitExpression(element, [...path, 'elements', index]));
        return addNode('expression', null, path, { expressionKind: 'array' }).id;
      case 'ObjectExpression':
        node.properties.forEach((property, index) => visitExpression(property.value, [...path, 'properties', index, 'value']));
        return addNode('expression', null, path, { expressionKind: 'object', keys: node.properties.map((property) => property.key) }).id;
      case 'MemberExpression':
        visitExpression(node.object, [...path, 'object']);
        if (node.computed) visitExpression(node.property, [...path, 'property']);
        return addNode('expression', null, path, { expressionKind: 'member', computed: Boolean(node.computed) }).id;
      case 'UnaryExpression':
        visitExpression(node.argument, [...path, 'argument']);
        return addNode('expression', null, path, { expressionKind: 'unary', operator: node.operator }).id;
      case 'AwaitExpression': {
        const awaited = visitExpression(node.argument, [...path, 'argument']);
        const expression = addNode('expression', null, path, { expressionKind: 'await', asyncBoundary: true });
        if (awaited) addEdge('awaits', expression.id, awaited);
        return expression.id;
      }
      case 'BinaryExpression':
        visitExpression(node.left, [...path, 'left']);
        visitExpression(node.right, [...path, 'right']);
        return addNode('expression', null, path, { expressionKind: 'binary', operator: node.operator }).id;
      case 'CallExpression': {
        const calleeId = visitExpression(node.callee, [...path, 'callee']);
        node.arguments.forEach((argument, index) => visitExpression(argument, [...path, 'arguments', index]));
        const call = addNode('call', node.callee.type === 'Identifier' ? node.callee.name : null, path, { arity: node.arguments.length });
        if (calleeId) addEdge('callee-expression', call.id, calleeId);
        if (node.callee.type === 'Identifier') {
          const target = resolve(node.callee.name);
          if (target) addEdge('calls', functionStack.at(-1) ?? call.id, target, { call: call.id });
          const effect = BUILTIN_EFFECTS[node.callee.name];
          if (effect && functionStack.at(-1)) {
            const fn = nodeById.get(functionStack.at(-1));
            fn.effects = [...new Set([...(fn.effects ?? []), effect])].sort();
          }
        }
        return call.id;
      }
      default:
        diagnostics.push({ code: 'NOVA-SEM-EXPR', severity: 'error', message: `Unsupported Cannon AST expression '${node.type}'`, file: artifact.file, astPath: [...path] });
        return null;
    }
  }

  const rootScope = pushScope('program', ['program']);
  define('print', 'builtin', ['builtin', 'print'], { effect: 'io.console', variadic: true });
  visitBody(artifact.ast.body, ['program']);
  popScope();

  const graph = {
    protocol: PROTOCOL,
    file: artifact.file,
    sourceDigest: artifact.sourceDigest,
    frontendArtifactDigest: artifact.artifactDigest,
    rootScope: rootScope.id,
    nodes: nodes.sort(compareIdentity),
    edges: edges.sort(compareIdentity),
    diagnostics
  };
  graph.digest = digest({ ...graph, digest: undefined });
  return Object.freeze(graph);
}

export function verifySemanticGraph(graph, { frontendArtifact = null } = {}) {
  if (!graph || graph.protocol !== PROTOCOL || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.diagnostics)) return { ok: false, reason: 'invalid Nova semantic graph' };
  if (typeof graph.sourceDigest !== 'string' || !graph.sourceDigest || typeof graph.file !== 'string' || !graph.file) return { ok: false, reason: 'semantic graph source identity is missing' };

  if (frontendArtifact) {
    const verification = verifyCannonFrontendArtifact(frontendArtifact);
    if (!verification.ok) return { ok: false, reason: `invalid Cannon frontend artifact: ${verification.reason}` };
    if (graph.sourceDigest !== frontendArtifact.sourceDigest) return { ok: false, reason: 'semantic graph source digest does not match frontend artifact' };
    if (graph.frontendArtifactDigest !== frontendArtifact.artifactDigest) return { ok: false, reason: 'semantic graph frontend artifact digest mismatch' };
    if (graph.file !== frontendArtifact.file) return { ok: false, reason: 'semantic graph file does not match frontend artifact' };
  }

  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || typeof node.kind !== 'string' || !Array.isArray(node.astPath)) return { ok: false, reason: 'invalid semantic node' };
    if (ids.has(node.id)) return { ok: false, reason: `duplicate semantic node id ${node.id}` };
    const expectedNodeId = stableId(graph.sourceDigest, node.kind, node.name ?? '', node.astPath.join('.'));
    if (node.id !== expectedNodeId) return { ok: false, reason: `semantic node identity mismatch ${node.id}` };
    if (node.file !== graph.file) return { ok: false, reason: `semantic node file mismatch ${node.id}` };
    ids.add(node.id);
  }

  const root = graph.nodes.find((node) => node.id === graph.rootScope);
  if (!root || root.kind !== 'scope' || root.scopeKind !== 'program') return { ok: false, reason: 'invalid semantic root scope' };

  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== 'string' || typeof edge.kind !== 'string' || typeof edge.from !== 'string' || typeof edge.to !== 'string') return { ok: false, reason: 'invalid semantic edge' };
    if (edgeIds.has(edge.id)) return { ok: false, reason: `duplicate semantic edge id ${edge.id}` };
    if (!ids.has(edge.from) || !ids.has(edge.to)) return { ok: false, reason: `dangling semantic edge ${edge.id}` };
    const metadata = Object.fromEntries(Object.entries(edge).filter(([key]) => !['id','kind','from','to'].includes(key)));
    const expectedEdgeId = stableId(graph.sourceDigest, 'edge', edge.kind, edge.from, edge.to, JSON.stringify(metadata));
    if (edge.id !== expectedEdgeId) return { ok: false, reason: `semantic edge identity mismatch ${edge.id}` };
    edgeIds.add(edge.id);
  }

  const { digest: actual, ...body } = graph;
  const expected = digest(body);
  if (typeof actual !== 'string' || actual !== expected) return { ok: false, reason: 'semantic graph digest mismatch', expectedDigest: expected };
  return { ok: true, reason: null, expectedDigest: expected };
}

function literalType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
function stableId(...parts) { return crypto.createHash('sha256').update(parts.map((part) => String(part)).join('\0')).digest('hex').slice(0, 32); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex'); }
function canonicalize(value) { if (Array.isArray(value)) return value.map(canonicalize); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])])); return value; }
function compareIdentity(a, b) { return a.id.localeCompare(b.id); }
