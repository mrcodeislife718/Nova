import crypto from 'node:crypto';

const FRONTEND_PROTOCOL = 'cannon-frontend/1';
const IR_PROTOCOL = 'cannon-ir/2';

export function verifyCannonFrontendArtifact(artifact) {
  if (!artifact || artifact.protocol !== FRONTEND_PROTOCOL) return { ok: false, reason: 'unsupported Cannon frontend protocol' };
  if (!artifact.frontendVersion || !artifact.file || !artifact.sourceDigest || artifact.ast?.type !== 'Program' || !Array.isArray(artifact.ast.body)) return { ok: false, reason: 'incomplete Cannon frontend artifact' };
  const { artifactDigest, ...body } = artifact;
  const expected = digest(body);
  return { ok: expected === artifactDigest, reason: expected === artifactDigest ? null : 'frontend artifact digest mismatch', expectedDigest: expected };
}

export function lowerFrontendArtifact(artifact) {
  const verification = verifyCannonFrontendArtifact(artifact);
  if (!verification.ok) throw new Error(`Nova rejected Cannon frontend artifact: ${verification.reason}`);
  const body = artifact.ast.body.map(lowerStatement);
  return Object.freeze({
    protocol: IR_PROTOCOL,
    version: 2,
    kind: 'cannon-ir',
    frontendProtocol: artifact.protocol,
    frontendVersion: artifact.frontendVersion,
    file: artifact.file,
    sourceDigest: artifact.sourceDigest,
    body,
    irDigest: digest({ protocol: IR_PROTOCOL, frontendVersion: artifact.frontendVersion, file: artifact.file, sourceDigest: artifact.sourceDigest, body })
  });
}

export function optimizeFrontendIR(ir) {
  validateIr(ir);
  const body = ir.body.map(optimizeStatement);
  const optimized = { ...structuredClone(ir), body, optimized: true };
  optimized.irDigest = digest({ protocol: optimized.protocol, frontendVersion: optimized.frontendVersion, file: optimized.file, sourceDigest: optimized.sourceDigest, body: optimized.body, optimized: true });
  return Object.freeze(optimized);
}

export function emitFrontendJavaScript(ir) {
  validateIr(ir);
  const scopes = [new Set()];
  const currentScope = () => scopes[scopes.length - 1];
  const isDeclared = (name) => scopes.some((scope) => scope.has(name));

  function statement(node, level = 0) {
    const pad = '  '.repeat(level);
    switch (node.op) {
      case 'declare': currentScope().add(node.name); return `${pad}${node.bindingKind} ${node.name} = ${expression(node.value)};`;
      case 'assign': {
        if (node.target.kind === 'identifier') {
          const first = !isDeclared(node.target.name);
          if (first) currentScope().add(node.target.name);
          return `${pad}${first ? 'let ' : ''}${node.target.name} = ${expression(node.value)};`;
        }
        return `${pad}${expression(node.target)} = ${expression(node.value)};`;
      }
      case 'evaluate': return `${pad}${expression(node.value)};`;
      case 'return': return `${pad}return${node.value ? ` ${expression(node.value)}` : ''};`;
      case 'function': {
        currentScope().add(node.name);
        scopes.push(new Set(node.params));
        const body = block(node.body, level);
        scopes.pop();
        return `${pad}function ${node.name}(${node.params.join(', ')}) ${body}`;
      }
      case 'if': {
        let output = `${pad}if (${expression(node.test)}) ${block(node.consequent, level)}`;
        if (node.alternate) output += node.alternate.op === 'if' ? ` else ${statement(node.alternate, level).trimStart()}` : ` else ${block(node.alternate, level)}`;
        return output;
      }
      case 'while': return `${pad}while (${expression(node.test)}) ${block(node.body, level)}`;
      case 'block': return `${pad}${block(node, level)}`;
      default: throw new Error(`Nova cannot emit unsupported IR statement: ${node.op}`);
    }
  }

  function block(node, level) {
    scopes.push(new Set());
    const content = node.body.map((entry) => statement(entry, level + 1)).join('\n');
    scopes.pop();
    return `{\n${content}\n${'  '.repeat(level)}}`;
  }

  function expression(node) {
    switch (node.kind) {
      case 'literal': return JSON.stringify(node.value);
      case 'identifier': return node.name;
      case 'array': return `[${node.elements.map(expression).join(', ')}]`;
      case 'object': return `{ ${node.properties.map((property) => `${JSON.stringify(property.key)}: ${expression(property.value)}`).join(', ')} }`;
      case 'member': return node.computed ? `${expression(node.object)}[${expression(node.property)}]` : `${expression(node.object)}.${node.property.name}`;
      case 'unary': return `(${node.operator}${expression(node.argument)})`;
      case 'binary': return `(${expression(node.left)} ${node.operator === '==' ? '===' : node.operator === '!=' ? '!==' : node.operator} ${expression(node.right)})`;
      case 'call': { const callee = node.callee.kind === 'identifier' && node.callee.name === 'print' ? 'console.log' : expression(node.callee); return `${callee}(${node.args.map(expression).join(', ')})`; }
      default: throw new Error(`Nova cannot emit unsupported IR expression: ${node.kind}`);
    }
  }

  return { code: ir.body.map((node) => statement(node, 0)).join('\n') + '\n', target: 'javascript', irDigest: ir.irDigest };
}

export function compileFrontendArtifact(artifact, { optimize = true, target = 'javascript' } = {}) {
  const lowered = lowerFrontendArtifact(artifact);
  const ir = optimize ? optimizeFrontendIR(lowered) : lowered;
  if (target !== 'javascript') return { ok: false, target, ir, diagnostics: [{ code: 'NOVA-FRONTEND-TARGET', severity: 'error', message: `Canonical frontend IR target '${target}' is not implemented by this path` }] };
  return { ok: true, target, ir, output: emitFrontendJavaScript(ir), diagnostics: [] };
}

function lowerStatement(node) {
  switch (node?.type) {
    case 'VariableDeclaration': return { op: 'declare', bindingKind: node.kind, name: node.name, value: lowerExpression(node.value) };
    case 'AssignmentStatement': return { op: 'assign', target: lowerExpression(node.target), value: lowerExpression(node.value) };
    case 'ExpressionStatement': return { op: 'evaluate', value: lowerExpression(node.expression) };
    case 'ReturnStatement': return { op: 'return', value: node.value ? lowerExpression(node.value) : null };
    case 'FunctionDeclaration': return { op: 'function', name: node.name, params: [...node.params], body: lowerBlock(node.body) };
    case 'IfStatement': return { op: 'if', test: lowerExpression(node.test), consequent: lowerBlock(node.consequent), alternate: node.alternate ? (node.alternate.type === 'IfStatement' ? lowerStatement(node.alternate) : lowerBlock(node.alternate)) : null };
    case 'WhileStatement': return { op: 'while', test: lowerExpression(node.test), body: lowerBlock(node.body) };
    case 'BlockStatement': return lowerBlock(node);
    default: throw new Error(`Nova rejected unsupported Cannon AST statement: ${node?.type ?? 'unknown'}`);
  }
}
function lowerBlock(node) { if (node?.type !== 'BlockStatement') throw new Error('Nova expected Cannon BlockStatement'); return { op: 'block', body: node.body.map(lowerStatement) }; }
function lowerExpression(node) {
  switch (node?.type) {
    case 'Literal': return { kind: 'literal', value: node.value };
    case 'Identifier': return { kind: 'identifier', name: node.name };
    case 'ArrayExpression': return { kind: 'array', elements: node.elements.map(lowerExpression) };
    case 'ObjectExpression': return { kind: 'object', properties: node.properties.map((property) => ({ key: property.key, value: lowerExpression(property.value) })) };
    case 'MemberExpression': return { kind: 'member', object: lowerExpression(node.object), property: lowerExpression(node.property), computed: Boolean(node.computed) };
    case 'UnaryExpression': return { kind: 'unary', operator: node.operator, argument: lowerExpression(node.argument) };
    case 'BinaryExpression': return { kind: 'binary', operator: node.operator, left: lowerExpression(node.left), right: lowerExpression(node.right) };
    case 'CallExpression': return { kind: 'call', callee: lowerExpression(node.callee), args: node.arguments.map(lowerExpression) };
    default: throw new Error(`Nova rejected unsupported Cannon AST expression: ${node?.type ?? 'unknown'}`);
  }
}
function optimizeStatement(node) {
  const copy = structuredClone(node);
  if (copy.value) copy.value = optimizeExpression(copy.value);
  if (copy.target) copy.target = optimizeExpression(copy.target);
  if (copy.test) copy.test = optimizeExpression(copy.test);
  if (copy.body?.body) copy.body = { ...copy.body, body: copy.body.body.map(optimizeStatement) };
  if (copy.consequent?.body) copy.consequent = { ...copy.consequent, body: copy.consequent.body.map(optimizeStatement) };
  if (copy.alternate) copy.alternate = copy.alternate.op === 'if' ? optimizeStatement(copy.alternate) : { ...copy.alternate, body: copy.alternate.body.map(optimizeStatement) };
  return copy;
}
function optimizeExpression(node) {
  const copy = structuredClone(node);
  if (copy.kind === 'binary') {
    copy.left = optimizeExpression(copy.left); copy.right = optimizeExpression(copy.right);
    if (copy.left.kind === 'literal' && copy.right.kind === 'literal') {
      const folded = foldBinary(copy.operator, copy.left.value, copy.right.value);
      if (folded.folded) return { kind: 'literal', value: folded.value };
    }
  } else if (copy.kind === 'unary') {
    copy.argument = optimizeExpression(copy.argument);
    if (copy.argument.kind === 'literal') {
      const folded = foldUnary(copy.operator, copy.argument.value);
      if (folded.folded) return { kind: 'literal', value: folded.value };
    }
  } else if (copy.kind === 'array') copy.elements = copy.elements.map(optimizeExpression);
  else if (copy.kind === 'object') copy.properties = copy.properties.map((property) => ({ ...property, value: optimizeExpression(property.value) }));
  else if (copy.kind === 'member') { copy.object = optimizeExpression(copy.object); copy.property = optimizeExpression(copy.property); }
  else if (copy.kind === 'call') { copy.callee = optimizeExpression(copy.callee); copy.args = copy.args.map(optimizeExpression); }
  return copy;
}
function foldBinary(operator, left, right) { try { switch (operator) { case '+': return { folded:true, value:left+right }; case '-': return { folded:true, value:left-right }; case '*': return { folded:true, value:left*right }; case '/': return right === 0 ? { folded:false } : { folded:true, value:left/right }; case '%': return right === 0 ? { folded:false } : { folded:true, value:left%right }; case '==': return { folded:true, value:left===right }; case '!=': return { folded:true, value:left!==right }; case '<': return { folded:true, value:left<right }; case '<=': return { folded:true, value:left<=right }; case '>': return { folded:true, value:left>right }; case '>=': return { folded:true, value:left>=right }; case '&&': return { folded:true, value:left&&right }; case '||': return { folded:true, value:left||right }; default:return { folded:false }; } } catch { return { folded:false }; } }
function foldUnary(operator, value) { try { if (operator === '!') return { folded:true, value:!value }; if (operator === '+') return { folded:true, value:+value }; if (operator === '-') return { folded:true, value:-value }; return { folded:false }; } catch { return { folded:false }; } }
function validateIr(ir) { if (!ir || ir.protocol !== IR_PROTOCOL || !Array.isArray(ir.body)) throw new TypeError('Nova Cannon IR v2 is required'); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex'); }
function canonicalize(value) { if (Array.isArray(value)) return value.map(canonicalize); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])])); return value; }
