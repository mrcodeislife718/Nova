import crypto from 'node:crypto';

const clone = (value) => globalThis.structuredClone(value);

export class SourceFile {
  constructor(file, source) {
    this.file = file;
    this.source = source;
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') this.lineStarts.push(i + 1);
  }
  position(offset) {
    offset = Math.max(0, Math.min(this.source.length, offset));
    let low = 0, high = this.lineStarts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.lineStarts[mid] <= offset) low = mid + 1;
      else high = mid - 1;
    }
    const lineIndex = Math.max(0, high);
    return { file: this.file, offset, line: lineIndex + 1, column: offset - this.lineStarts[lineIndex] + 1 };
  }
  span(start, end = start + 1) { return { start: this.position(start), end: this.position(end) }; }
}

export class DiagnosticBag {
  constructor() { this.items = []; }
  add(code, message, span, severity = 'error', data = {}) {
    const diagnostic = { code, message, severity, span, ...data };
    this.items.push(diagnostic);
    return diagnostic;
  }
  get ok() { return !this.items.some((item) => item.severity === 'error'); }
}

export class InferEngine {
  constructor() { this.bindings = new Map(); this.functions = new Map(); this.effects = new Map(); }
  inferLiteral(value) {
    if (value === null) return type('null');
    if (typeof value === 'boolean') return type('boolean');
    if (typeof value === 'bigint' || Number.isInteger(value)) return type('integer');
    if (typeof value === 'number') return type('float');
    if (typeof value === 'string') return type('string');
    if (Array.isArray(value)) return { kind: 'array', element: unifyMany(value.map((entry) => this.inferLiteral(entry))) };
    if (value && typeof value === 'object') return { kind: 'object', fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.inferLiteral(entry)])) };
    return type('unknown');
  }
  bind(name, inferred, provenance = null) {
    const previous = this.bindings.get(name);
    if (!previous) {
      const entry = { name, type: clone(inferred), provenance: provenance ? [clone(provenance)] : [] };
      this.bindings.set(name, entry);
      return entry;
    }
    previous.type = unify(previous.type, inferred);
    if (provenance) previous.provenance.push(clone(provenance));
    return previous;
  }
  defineFunction(name, signature) { this.functions.set(name, clone(signature)); return clone(signature); }
  effect(name, effectName) { const set = this.effects.get(name) ?? new Set(); set.add(effectName); this.effects.set(name, set); }
  snapshot() {
    return {
      bindings: Object.fromEntries([...this.bindings].map(([name, entry]) => [name, clone(entry)])),
      functions: Object.fromEntries([...this.functions].map(([name, signature]) => [name, clone(signature)])),
      effects: Object.fromEntries([...this.effects].map(([name, effects]) => [name, [...effects].sort()]))
    };
  }
}

export class SemanticGraph {
  constructor() { this.nodes = new Map(); this.edges = []; }
  node(kind, name, span, data = {}) {
    const id = crypto.createHash('sha1').update(`${kind}:${name}:${span?.start?.file ?? ''}:${span?.start?.offset ?? 0}`).digest('hex');
    const node = { id, kind, name, span: clone(span), ...clone(data) };
    this.nodes.set(id, node);
    return node;
  }
  edge(from, to, relation, data = {}) { this.edges.push({ from: idOf(from), to: idOf(to), relation, ...clone(data) }); }
  references(node) { const id = idOf(node); return this.edges.filter((edge) => edge.from === id || edge.to === id).map((edge) => clone(edge)); }
  serialize() { return { nodes: [...this.nodes.values()].map((node) => clone(node)), edges: this.edges.map((edge) => clone(edge)) }; }
}

export function parseNovaSource(source, { file = '<memory>' } = {}) {
  const sourceFile = new SourceFile(file, source);
  const diagnostics = new DiagnosticBag();
  const body = [];
  let offset = 0;
  for (const rawLine of source.split(/\r?\n/)) {
    const start = offset;
    offset += rawLine.length + 1;
    const text = rawLine.replace(/\/\/.*$/, '').trim();
    if (!text) continue;
    let match;
    if ((match = text.match(/^(let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?$/))) {
      body.push({ kind: 'Binding', mutable: match[1] === 'let', name: match[2], expression: parseExpression(match[3], sourceFile, start + rawLine.indexOf(match[3]), diagnostics), span: sourceFile.span(start, start + rawLine.length) });
      continue;
    }
    if ((match = text.match(/^return\s+(.+?);?$/))) {
      body.push({ kind: 'Return', expression: parseExpression(match[1], sourceFile, start + rawLine.indexOf(match[1]), diagnostics), span: sourceFile.span(start, start + rawLine.length) });
      continue;
    }
    if ((match = text.match(/^print\s*\((.*)\)\s*;?$/))) {
      body.push({ kind: 'ExpressionStatement', expression: { kind: 'Call', callee: 'print', args: splitArgs(match[1]).map((arg) => parseExpression(arg, sourceFile, start + rawLine.indexOf(arg), diagnostics)), span: sourceFile.span(start, start + rawLine.length) }, span: sourceFile.span(start, start + rawLine.length) });
      continue;
    }
    if ((match = text.match(/^([A-Za-z_$][\w$]*)\s*=\s*(.+?);?$/))) {
      body.push({ kind: 'Assignment', name: match[1], expression: parseExpression(match[2], sourceFile, start + rawLine.indexOf(match[2]), diagnostics), span: sourceFile.span(start, start + rawLine.length) });
      continue;
    }
    diagnostics.add('NOVA-P1001', `Unsupported syntax: ${text}`, sourceFile.span(start, start + rawLine.length));
  }
  return { sourceFile, body, diagnostics: diagnostics.items };
}

export function analyzeProgram(parsed) {
  const infer = new InferEngine();
  const graph = new SemanticGraph();
  const diagnostics = new DiagnosticBag();
  const symbols = new Map();
  for (const statement of parsed.body) {
    if (statement.kind === 'Binding') {
      const inferred = inferExpression(statement.expression, infer, diagnostics);
      const symbol = graph.node('binding', statement.name, statement.span, { mutable: statement.mutable, type: inferred });
      symbols.set(statement.name, symbol);
      infer.bind(statement.name, inferred, statement.span);
      continue;
    }
    if (statement.kind === 'Assignment') {
      const target = symbols.get(statement.name);
      if (!target) { diagnostics.add('NOVA-S1001', `Unknown binding '${statement.name}'`, statement.span); continue; }
      if (!target.mutable) diagnostics.add('NOVA-S1002', `Cannot assign to immutable binding '${statement.name}'`, statement.span);
      const inferred = inferExpression(statement.expression, infer, diagnostics);
      const before = infer.bindings.get(statement.name)?.type ?? type('unknown');
      const merged = unify(before, inferred);
      if (merged.kind === 'conflict') diagnostics.add('NOVA-T1001', `Conflicting inferred types for '${statement.name}': ${displayType(before)} and ${displayType(inferred)}`, statement.span, 'error', { previous: before, next: inferred });
      infer.bind(statement.name, inferred, statement.span);
      graph.edge(target, target, 'assignment', { span: statement.span });
      continue;
    }
    if (statement.kind === 'ExpressionStatement' || statement.kind === 'Return') inferExpression(statement.expression, infer, diagnostics);
  }
  return { ok: diagnostics.ok && !(parsed.diagnostics ?? []).some((item) => item.severity === 'error'), inference: infer.snapshot(), graph: graph.serialize(), diagnostics: [...(parsed.diagnostics ?? []), ...diagnostics.items] };
}

export function lowerToIR(parsed, analysis) {
  const instructions = parsed.body.map((statement) => {
    if (statement.kind === 'Binding') return { op: 'bind', name: statement.name, mutable: statement.mutable, value: lowerExpression(statement.expression), span: statement.span };
    if (statement.kind === 'Assignment') return { op: 'store', name: statement.name, value: lowerExpression(statement.expression), span: statement.span };
    if (statement.kind === 'ExpressionStatement') return { op: 'eval', value: lowerExpression(statement.expression), span: statement.span };
    if (statement.kind === 'Return') return { op: 'return', value: lowerExpression(statement.expression), span: statement.span };
    return null;
  }).filter(Boolean);
  return { version: 1, kind: 'cannon-ir', instructions, inference: clone(analysis.inference), sourceMap: instructions.map((instruction, index) => ({ ir: index, span: clone(instruction.span) })) };
}

export function optimizeIR(ir, { constantFold = true } = {}) {
  const instructions = ir.instructions.map((instruction) => ({ ...clone(instruction), value: constantFold ? fold(instruction.value) : clone(instruction.value) }));
  return { ...clone(ir), optimized: true, instructions };
}

export function emitJavaScript(ir) {
  const lines = ['// Generated by Nova', `'use strict';`];
  for (const instruction of ir.instructions) {
    if (instruction.op === 'bind') lines.push(`${instruction.mutable ? 'let' : 'const'} ${instruction.name} = ${emitJsExpr(instruction.value)};`);
    else if (instruction.op === 'store') lines.push(`${instruction.name} = ${emitJsExpr(instruction.value)};`);
    else if (instruction.op === 'eval') lines.push(`${emitJsExpr(instruction.value)};`);
    else if (instruction.op === 'return') lines.push(`export default ${emitJsExpr(instruction.value)};`);
  }
  return { code: lines.join('\n') + '\n', sourceMap: clone(ir.sourceMap) };
}

export function emitWasm(ir) {
  const result = [...ir.instructions].reverse().find((instruction) => instruction.op === 'return');
  const constant = result?.value?.kind === 'const' && Number.isInteger(result.value.value) ? result.value.value : null;
  if (constant == null) return { ok: false, diagnostics: [{ code: 'NOVA-WASM1001', severity: 'error', message: 'Current WASM backend requires an integer constant return expression' }] };
  const body = [0x00, 0x41, ...encodeSLEB(constant), 0x0b];
  const name = [...Buffer.from('main')];
  return { ok: true, binary: Uint8Array.from([0,97,115,109,1,0,0,0, ...section(1,[1,0x60,0,1,0x7f]), ...section(3,[1,0]), ...section(7,[1,name.length,...name,0,0]), ...section(10,[1,...encodeULEB(body.length),...body])]), exports: ['main'] };
}

export function emitNativeC(ir, { functionName = 'cannon_main' } = {}) {
  const lines = ['/* Generated by Nova native backend */', '#include <stdint.h>', '#include <stdio.h>', `int64_t ${functionName}(void) {`];
  for (const instruction of ir.instructions) {
    if (instruction.op === 'bind') lines.push(`  int64_t ${instruction.name} = ${emitCExpr(instruction.value)};`);
    else if (instruction.op === 'store') lines.push(`  ${instruction.name} = ${emitCExpr(instruction.value)};`);
    else if (instruction.op === 'eval' && instruction.value?.kind === 'call' && instruction.value.callee === 'print') lines.push(`  printf("%lld\\n", (long long)${emitCExpr(instruction.value.args[0])});`);
    else if (instruction.op === 'return') lines.push(`  return ${emitCExpr(instruction.value)};`);
  }
  lines.push('}');
  return { language: 'c', code: lines.join('\n') + '\n', abi: { function: functionName, returns: 'i64', parameters: [] } };
}

export function compile(source, options = {}) {
  const parsed = parseNovaSource(source, options);
  const analysis = analyzeProgram(parsed);
  if (!analysis.ok) return { ok: false, diagnostics: analysis.diagnostics, analysis };
  const ir = optimizeIR(lowerToIR(parsed, analysis), options.optimize ?? {});
  const target = options.target ?? 'javascript';
  if (target === 'javascript') return { ok: true, target, ir, output: emitJavaScript(ir), diagnostics: analysis.diagnostics, analysis };
  if (target === 'wasm') { const output = emitWasm(ir); return { ok: output.ok, target, ir, output, diagnostics: [...analysis.diagnostics, ...(output.diagnostics ?? [])], analysis }; }
  if (target === 'native') return { ok: true, target, ir, output: emitNativeC(ir, options.native), diagnostics: analysis.diagnostics, analysis };
  return { ok: false, target, ir, analysis, diagnostics: [{ code: 'NOVA-B1001', severity: 'error', message: `Unknown backend '${target}'` }] };
}

export function structuredDiagnostics(result) {
  return (result.diagnostics ?? []).map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity ?? 'error', message: diagnostic.message, file: diagnostic.span?.start?.file ?? diagnostic.file ?? null, start: diagnostic.span?.start ?? null, end: diagnostic.span?.end ?? null, data: Object.fromEntries(Object.entries(diagnostic).filter(([key]) => !['code','severity','message','span'].includes(key))) }));
}

function parseExpression(text, sourceFile, start, diagnostics) {
  const value = text.trim().replace(/;$/, '');
  const span = sourceFile.span(start, start + value.length);
  if (/^-?\d+$/.test(value)) return { kind: 'Literal', value: Number(value), span };
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) return { kind: 'Literal', value: Number(value), span };
  if (/^(true|false)$/.test(value)) return { kind: 'Literal', value: value === 'true', span };
  if (value === 'null') return { kind: 'Literal', value: null, span };
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return { kind: 'Literal', value: value.slice(1, -1), span };
  const binary = findBinary(value);
  if (binary) return { kind: 'Binary', operator: binary.operator, left: parseExpression(binary.left, sourceFile, start, diagnostics), right: parseExpression(binary.right, sourceFile, start + value.lastIndexOf(binary.right), diagnostics), span };
  const call = value.match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)$/s);
  if (call) return { kind: 'Call', callee: call[1], args: splitArgs(call[2]).map((arg) => parseExpression(arg, sourceFile, start + value.indexOf(arg), diagnostics)), span };
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return { kind: 'Identifier', name: value, span };
  diagnostics.add('NOVA-P2001', `Unsupported expression: ${value}`, span);
  return { kind: 'Unknown', text: value, span };
}

function inferExpression(expression, infer, diagnostics) {
  if (expression.kind === 'Literal') return infer.inferLiteral(expression.value);
  if (expression.kind === 'Identifier') return infer.bindings.get(expression.name)?.type ?? type('unknown');
  if (expression.kind === 'Call') return expression.callee === 'print' ? type('void') : infer.functions.get(expression.callee)?.returns ?? type('unknown');
  if (expression.kind === 'Binary') {
    const left = inferExpression(expression.left, infer, diagnostics), right = inferExpression(expression.right, infer, diagnostics);
    if (expression.operator === '+' && (left.kind === 'string' || right.kind === 'string')) return type('string');
    if (['integer','float'].includes(left.kind) && ['integer','float'].includes(right.kind)) return type(left.kind === 'float' || right.kind === 'float' || expression.operator === '/' ? 'float' : 'integer');
    diagnostics.add('NOVA-T2001', `Operator '${expression.operator}' requires numeric operands`, expression.span);
  }
  return type('unknown');
}

function lowerExpression(expression) {
  if (expression.kind === 'Literal') return { kind: 'const', value: expression.value };
  if (expression.kind === 'Identifier') return { kind: 'ref', name: expression.name };
  if (expression.kind === 'Binary') return { kind: 'binary', operator: expression.operator, left: lowerExpression(expression.left), right: lowerExpression(expression.right) };
  if (expression.kind === 'Call') return { kind: 'call', callee: expression.callee, args: expression.args.map((arg) => lowerExpression(arg)) };
  return { kind: 'unknown' };
}

function fold(expression) {
  if (!expression || expression.kind !== 'binary') return clone(expression);
  const left = fold(expression.left), right = fold(expression.right);
  if (left.kind === 'const' && right.kind === 'const') {
    const operations = { '+': (a,b) => a+b, '-': (a,b) => a-b, '*': (a,b) => a*b, '/': (a,b) => a/b };
    if (operations[expression.operator]) return { kind: 'const', value: operations[expression.operator](left.value, right.value) };
  }
  return { ...clone(expression), left, right };
}
function emitJsExpr(expression) { if (expression.kind === 'const') return JSON.stringify(expression.value); if (expression.kind === 'ref') return expression.name; if (expression.kind === 'binary') return `(${emitJsExpr(expression.left)} ${expression.operator} ${emitJsExpr(expression.right)})`; if (expression.kind === 'call') return expression.callee === 'print' ? `console.log(${expression.args.map((arg) => emitJsExpr(arg)).join(', ')})` : `${expression.callee}(${expression.args.map((arg) => emitJsExpr(arg)).join(', ')})`; return 'undefined'; }
function emitCExpr(expression) { if (expression.kind === 'const' && typeof expression.value === 'number') return String(Math.trunc(expression.value)); if (expression.kind === 'ref') return expression.name; if (expression.kind === 'binary') return `(${emitCExpr(expression.left)} ${expression.operator} ${emitCExpr(expression.right)})`; return '0'; }
function findBinary(value) { for (const operators of [['+','-'], ['*','/']]) { let depth = 0, quote = null; for (let i = value.length - 1; i >= 0; i--) { const char = value[i]; if (quote) { if (char === quote && value[i-1] !== '\\') quote = null; continue; } if (char === '"' || char === "'") { quote = char; continue; } if (')]}'.includes(char)) depth++; else if ('([{'.includes(char)) depth--; else if (depth === 0 && operators.includes(char) && i > 0) return { left: value.slice(0,i).trim(), operator: char, right: value.slice(i+1).trim() }; } } return null; }
function splitArgs(text) { const output = []; let start = 0, depth = 0, quote = null; for (let i = 0; i < text.length; i++) { const char = text[i]; if (quote) { if (char === quote && text[i-1] !== '\\') quote = null; continue; } if (char === '"' || char === "'") { quote = char; continue; } if ('([{'.includes(char)) depth++; else if (')]}'.includes(char)) depth--; else if (char === ',' && depth === 0) { output.push(text.slice(start,i).trim()); start = i + 1; } } const tail = text.slice(start).trim(); if (tail) output.push(tail); return output; }
function type(kind) { return { kind }; }
function unify(a, b) { if (!a || a.kind === 'unknown') return clone(b); if (!b || b.kind === 'unknown') return clone(a); if (a.kind === b.kind) return clone(a); if (new Set([a.kind,b.kind]).has('integer') && new Set([a.kind,b.kind]).has('float')) return type('float'); if (a.kind === 'null') return { kind: 'nullable', inner: clone(b) }; if (b.kind === 'null') return { kind: 'nullable', inner: clone(a) }; return { kind: 'conflict', options: [clone(a), clone(b)] }; }
function unifyMany(types) { return types.reduce((current, next) => unify(current, next), type('unknown')); }
function displayType(value) { if (!value) return 'unknown'; if (value.kind === 'array') return `array<${displayType(value.element)}>`; if (value.kind === 'nullable') return `${displayType(value.inner)}?`; return value.kind; }
function idOf(value) { return typeof value === 'string' ? value : value.id; }
function section(id, payload) { return [id, ...encodeULEB(payload.length), ...payload]; }
function encodeULEB(value) { const output = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; output.push(byte); } while (value); return output; }
function encodeSLEB(value) { const output = []; let more = true; while (more) { let byte = value & 0x7f; value >>= 7; const sign = byte & 0x40; more = !((value === 0 && !sign) || (value === -1 && sign)); if (more) byte |= 0x80; output.push(byte); } return output; }
