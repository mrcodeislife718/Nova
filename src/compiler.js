import crypto from 'node:crypto';

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
    while (low <= high) { const mid = (low + high) >> 1; if (this.lineStarts[mid] <= offset) low = mid + 1; else high = mid - 1; }
    const lineIndex = Math.max(0, high);
    return { file: this.file, offset, line: lineIndex + 1, column: offset - this.lineStarts[lineIndex] + 1 };
  }
  span(start, end = start + 1) { return { start: this.position(start), end: this.position(end) }; }
}

export class DiagnosticBag {
  constructor() { this.items = []; }
  add(code, message, span, severity = 'error', data = {}) { const diagnostic = { code, message, severity, span, ...data }; this.items.push(diagnostic); return diagnostic; }
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
    if (Array.isArray(value)) return collectionType('array', unifyMany(value.map((entry) => this.inferLiteral(entry))));
    if (value && typeof value === 'object') return { kind: 'object', fields: Object.fromEntries(Object.entries(value).map(([k,v]) => [k, this.inferLiteral(v)])) };
    return type('unknown');
  }
  bind(name, inferred, provenance = null) {
    const previous = this.bindings.get(name);
    if (!previous) { const entry = { name, type: inferred, provenance: provenance ? [provenance] : [] }; this.bindings.set(name, entry); return entry; }
    const unified = unify(previous.type, inferred);
    previous.type = unified;
    if (provenance) previous.provenance.push(provenance);
    return previous;
  }
  defineFunction(name, signature) { this.functions.set(name, structuredClone(signature)); return signature; }
  effect(name, effectName) { const set = this.effects.get(name) ?? new Set(); set.add(effectName); this.effects.set(name, set); }
  snapshot() { return { bindings: Object.fromEntries([...this.bindings].map(([k,v]) => [k, cloneTypeEntry(v)])), functions: Object.fromEntries(this.functions), effects: Object.fromEntries([...this.effects].map(([k,v]) => [k,[...v].sort()])) }; }
}

export class SemanticGraph {
  constructor() { this.nodes = new Map(); this.edges = []; }
  node(kind, name, span, data = {}) { const id = crypto.createHash('sha1').update(`${kind}:${name}:${span?.start?.file ?? ''}:${span?.start?.offset ?? 0}`).digest('hex'); const node = { id, kind, name, span, ...structuredClone(data) }; this.nodes.set(id, node); return node; }
  edge(from, to, relation, data = {}) { this.edges.push({ from: idOf(from), to: idOf(to), relation, ...structuredClone(data) }); }
  references(node) { const id = idOf(node); return this.edges.filter((edge) => edge.from === id || edge.to === id).map(structuredClone); }
  serialize() { return { nodes: [...this.nodes.values()].map(structuredClone), edges: this.edges.map(structuredClone) }; }
}

export function parseNovaSource(source, { file = '<memory>' } = {}) {
  const sf = new SourceFile(file, source);
  const diagnostics = new DiagnosticBag();
  const body = [];
  const lines = source.split(/\r?\n/);
  let offset = 0;
  for (const rawLine of lines) {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const stripped = rawLine.replace(/\/\/.*$/, '').trim();
    if (!stripped) continue;
    let match;
    if ((match = stripped.match(/^(?:let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?$/))) {
      body.push({ kind: 'Binding', name: match[1], expression: parseExpression(match[2], sf, lineStart + rawLine.indexOf(match[2]), diagnostics), mutable: stripped.startsWith('let '), span: sf.span(lineStart, lineStart + rawLine.length) });
      continue;
    }
    if ((match = stripped.match(/^return\s+(.+?);?$/))) { body.push({ kind: 'Return', expression: parseExpression(match[1], sf, lineStart + rawLine.indexOf(match[1]), diagnostics), span: sf.span(lineStart, lineStart + rawLine.length) }); continue; }
    if ((match = stripped.match(/^print\s*\((.*)\)\s*;?$/))) { body.push({ kind: 'ExpressionStatement', expression: { kind: 'Call', callee: 'print', args: splitArgs(match[1]).map((arg) => parseExpression(arg, sf, lineStart + rawLine.indexOf(arg), diagnostics)), span: sf.span(lineStart, lineStart + rawLine.length) }, span: sf.span(lineStart, lineStart + rawLine.length) }); continue; }
    if ((match = stripped.match(/^([A-Za-z_$][\w$]*)\s*=\s*(.+?);?$/))) { body.push({ kind: 'Assignment', name: match[1], expression: parseExpression(match[2], sf, lineStart + rawLine.indexOf(match[2]), diagnostics), span: sf.span(lineStart, lineStart + rawLine.length) }); continue; }
    diagnostics.add('NOVA-P1001', `Unsupported syntax: ${stripped}`, sf.span(lineStart, lineStart + rawLine.length));
  }
  return { sourceFile: sf, body, diagnostics: diagnostics.items };
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
      symbols.set(statement.name, symbol); infer.bind(statement.name, inferred, statement.span);
    } else if (statement.kind === 'Assignment') {
      const target = symbols.get(statement.name);
      if (!target) { diagnostics.add('NOVA-S1001', `Unknown binding '${statement.name}'`, statement.span); continue; }
      if (!target.mutable) diagnostics.add('NOVA-S1002', `Cannot assign to immutable binding '${statement.name}'`, statement.span);
      const inferred = inferExpression(statement.expression, infer, diagnostics);
      const before = infer.bindings.get(statement.name)?.type ?? type('unknown');
      const after = unify(before, inferred);
      if (after.kind === 'conflict') diagnostics.add('NOVA-T1001', `Conflicting inferred types for '${statement.name}': ${displayType(before)} and ${displayType(inferred)}`, statement.span, 'error', { previous: before, next: inferred });
      infer.bind(statement.name, inferred, statement.span);
      graph.edge(target, target, 'assignment', { span: statement.span });
    } else if (statement.kind === 'ExpressionStatement') {
      inferExpression(statement.expression, infer, diagnostics);
    } else if (statement.kind === 'Return') inferExpression(statement.expression, infer, diagnostics);
  }
  return { ok: diagnostics.ok && !(parsed.diagnostics ?? []).some((d) => d.severity === 'error'), inference: infer.snapshot(), graph: graph.serialize(), diagnostics: [...(parsed.diagnostics ?? []), ...diagnostics.items] };
}

export function lowerToIR(parsed, analysis) {
  const instructions = [];
  for (const statement of parsed.body) {
    if (statement.kind === 'Binding') instructions.push({ op: 'bind', name: statement.name, mutable: statement.mutable, value: lowerExpression(statement.expression), span: statement.span });
    if (statement.kind === 'Assignment') instructions.push({ op: 'store', name: statement.name, value: lowerExpression(statement.expression), span: statement.span });
    if (statement.kind === 'ExpressionStatement') instructions.push({ op: 'eval', value: lowerExpression(statement.expression), span: statement.span });
    if (statement.kind === 'Return') instructions.push({ op: 'return', value: lowerExpression(statement.expression), span: statement.span });
  }
  return { version: 1, kind: 'cannon-ir', instructions, inference: analysis.inference, sourceMap: instructions.map((instruction, index) => ({ ir: index, span: instruction.span })) };
}

export function optimizeIR(ir, { constantFold = true, deadStoreElimination = true } = {}) {
  let instructions = ir.instructions.map(structuredClone);
  if (constantFold) instructions = instructions.map((instruction) => ({ ...instruction, value: fold(instruction.value) }));
  if (deadStoreElimination) {
    const used = new Set();
    for (const instruction of instructions) collectRefs(instruction.value, used);
    instructions = instructions.filter((instruction) => instruction.op !== 'bind' || used.has(instruction.name) || instruction.mutable || instructions.some((i) => i.op === 'return' && references(i.value, instruction.name)));
  }
  return { ...structuredClone(ir), optimized: true, instructions };
}

export function emitJavaScript(ir, { module = true } = {}) {
  const lines = module ? [`// Generated by Nova`, `'use strict';`] : [`'use strict';`];
  for (const instruction of ir.instructions) {
    if (instruction.op === 'bind') lines.push(`${instruction.mutable ? 'let' : 'const'} ${instruction.name} = ${emitJsExpr(instruction.value)};`);
    else if (instruction.op === 'store') lines.push(`${instruction.name} = ${emitJsExpr(instruction.value)};`);
    else if (instruction.op === 'eval') lines.push(`${emitJsExpr(instruction.value)};`);
    else if (instruction.op === 'return') lines.push(`export default ${emitJsExpr(instruction.value)};`);
  }
  return { code: lines.join('\n') + '\n', sourceMap: ir.sourceMap };
}

export function emitWasm(ir) {
  const returnInstruction = [...ir.instructions].reverse().find((instruction) => instruction.op === 'return');
  const constant = returnInstruction?.value?.kind === 'const' && Number.isInteger(returnInstruction.value.value) ? returnInstruction.value.value : null;
  if (constant == null) return { ok: false, diagnostics: [{ code: 'NOVA-WASM1001', severity: 'error', message: 'Current WASM backend requires an integer constant return expression' }] };
  const body = [0x00, 0x41, ...encodeSLEB(constant), 0x0b];
  const typeSection = section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]);
  const functionSection = section(3, [0x01, 0x00]);
  const exportName = [...Buffer.from('main')];
  const exportSection = section(7, [0x01, exportName.length, ...exportName, 0x00, 0x00]);
  const codeSection = section(10, [0x01, ...encodeULEB(body.length), ...body]);
  return { ok: true, binary: Uint8Array.from([0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,...typeSection,...functionSection,...exportSection,...codeSection]), exports: ['main'] };
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
  return { ok: false, diagnostics: [{ code: 'NOVA-B1001', severity: 'error', message: `Unknown backend '${target}'` }], analysis, ir };
}

export function structuredDiagnostics(result) {
  return (result.diagnostics ?? []).map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity ?? 'error', message: diagnostic.message, file: diagnostic.span?.start?.file ?? diagnostic.file ?? null, start: diagnostic.span?.start ?? null, end: diagnostic.span?.end ?? null, data: Object.fromEntries(Object.entries(diagnostic).filter(([key]) => !['code','severity','message','span'].includes(key))) }));
}

function parseExpression(text, sf, start, diagnostics) {
  const value = text.trim().replace(/;$/, '');
  const span = sf.span(start, start + value.length);
  if (/^-?\d+$/.test(value)) return { kind: 'Literal', value: Number(value), span };
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) return { kind: 'Literal', value: Number(value), span };
  if (/^(true|false)$/.test(value)) return { kind: 'Literal', value: value === 'true', span };
  if (value === 'null') return { kind: 'Literal', value: null, span };
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return { kind: 'Literal', value: value.slice(1,-1), span };
  const binary = findBinary(value);
  if (binary) return { kind: 'Binary', operator: binary.operator, left: parseExpression(binary.left, sf, start, diagnostics), right: parseExpression(binary.right, sf, start + value.indexOf(binary.right), diagnostics), span };
  const call = value.match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)$/s);
  if (call) return { kind: 'Call', callee: call[1], args: splitArgs(call[2]).map((arg) => parseExpression(arg, sf, start + value.indexOf(arg), diagnostics)), span };
  if (/^[A-Za-z_$][\w$]*$/.test(value)) return { kind: 'Identifier', name: value, span };
  diagnostics.add('NOVA-P2001', `Unsupported expression: ${value}`, span);
  return { kind: 'Unknown', text: value, span };
}
function inferExpression(expr, infer, diagnostics) {
  if (expr.kind === 'Literal') return infer.inferLiteral(expr.value);
  if (expr.kind === 'Identifier') return infer.bindings.get(expr.name)?.type ?? type('unknown');
  if (expr.kind === 'Call') { if (expr.callee === 'print') return type('void'); return infer.functions.get(expr.callee)?.returns ?? type('unknown'); }
  if (expr.kind === 'Binary') { const left = inferExpression(expr.left, infer, diagnostics), right = inferExpression(expr.right, infer, diagnostics); if (['+','-','*','/'].includes(expr.operator)) { if (expr.operator === '+' && (left.kind === 'string' || right.kind === 'string')) return type('string'); if (['integer','float'].includes(left.kind) && ['integer','float'].includes(right.kind)) return type(left.kind === 'float' || right.kind === 'float' || expr.operator === '/' ? 'float' : 'integer'); diagnostics.add('NOVA-T2001', `Operator '${expr.operator}' requires numeric operands`, expr.span); } }
  return type('unknown');
}
function lowerExpression(expr) { if (expr.kind === 'Literal') return { kind: 'const', value: expr.value }; if (expr.kind === 'Identifier') return { kind: 'ref', name: expr.name }; if (expr.kind === 'Binary') return { kind: 'binary', operator: expr.operator, left: lowerExpression(expr.left), right: lowerExpression(expr.right) }; if (expr.kind === 'Call') return { kind: 'call', callee: expr.callee, args: expr.args.map(lowerExpression) }; return { kind: 'unknown' }; }
function fold(expr) { if (!expr) return expr; if (expr.kind === 'binary') { const left = fold(expr.left), right = fold(expr.right); if (left.kind === 'const' && right.kind === 'const') { const ops = { '+': (a,b)=>a+b, '-':(a,b)=>a-b, '*':(a,b)=>a*b, '/':(a,b)=>a/b }; if (ops[expr.operator]) return { kind: 'const', value: ops[expr.operator](left.value,right.value) }; } return { ...expr, left, right }; } return expr; }
function emitJsExpr(expr) { if (expr.kind === 'const') return JSON.stringify(expr.value); if (expr.kind === 'ref') return expr.name; if (expr.kind === 'binary') return `(${emitJsExpr(expr.left)} ${expr.operator} ${emitJsExpr(expr.right)})`; if (expr.kind === 'call') return expr.callee === 'print' ? `console.log(${expr.args.map(emitJsExpr).join(', ')})` : `${expr.callee}(${expr.args.map(emitJsExpr).join(', ')})`; return 'undefined'; }
function emitCExpr(expr) { if (expr.kind === 'const' && typeof expr.value === 'number') return String(Math.trunc(expr.value)); if (expr.kind === 'ref') return expr.name; if (expr.kind === 'binary') return `(${emitCExpr(expr.left)} ${expr.operator} ${emitCExpr(expr.right)})`; if (expr.kind === 'call' && expr.callee !== 'print') return `${expr.callee}(${expr.args.map(emitCExpr).join(', ')})`; return '0'; }
function findBinary(value) { let depth=0, quote=null; for (let i=value.length-1;i>=0;i--){const c=value[i];if(quote){if(c===quote&&value[i-1]!=="\\")quote=null;continue;}if(c==='"'||c==="'"){quote=c;continue;}if(c===')'||c===']'||c==='}')depth++; else if(c==='('||c==='['||c==='{')depth--; else if(depth===0&&['+','-'].includes(c)&&i>0)return{left:value.slice(0,i).trim(),operator:c,right:value.slice(i+1).trim()};} depth=0; for(let i=value.length-1;i>=0;i--){const c=value[i];if(c===')'||c===']'||c==='}')depth++;else if(c==='('||c==='['||c==='{')depth--;else if(depth===0&&['*','/'].includes(c))return{left:value.slice(0,i).trim(),operator:c,right:value.slice(i+1).trim()};} return null; }
function splitArgs(text) { const out=[]; let start=0,depth=0,quote=null; for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(c===quote&&text[i-1]!=="\\")quote=null;continue;}if(c==='"'||c==="'"){quote=c;continue;}if('([{'.includes(c))depth++;else if(')]}'.includes(c))depth--;else if(c===','&&depth===0){out.push(text.slice(start,i).trim());start=i+1;}} const tail=text.slice(start).trim();if(tail)out.push(tail);return out; }
function type(kind) { return { kind }; }
function collectionType(kind, element) { return { kind, element }; }
function unify(a,b) { if (!a || a.kind==='unknown') return structuredClone(b); if (!b || b.kind==='unknown') return structuredClone(a); if (a.kind===b.kind) { if (a.element||b.element) return { kind:a.kind, element:unify(a.element,b.element) }; return structuredClone(a); } if ((a.kind==='integer'&&b.kind==='float')||(a.kind==='float'&&b.kind==='integer')) return type('float'); if (a.kind==='null') return { kind:'nullable', inner:structuredClone(b) }; if (b.kind==='null') return { kind:'nullable', inner:structuredClone(a) }; return { kind:'conflict', options:[structuredClone(a),structuredClone(b)] }; }
function unifyMany(types) { return types.reduce((acc,current)=>unify(acc,current),type('unknown')); }
function displayType(t) { if (!t) return 'unknown'; if (t.kind==='array') return `array<${displayType(t.element)}>`; if (t.kind==='nullable') return `${displayType(t.inner)}?`; return t.kind; }
function cloneTypeEntry(entry) { return { ...structuredClone(entry), type: structuredClone(entry.type) }; }
function idOf(value) { return typeof value === 'string' ? value : value.id; }
function collectRefs(expr,set){if(!expr)return;if(expr.kind==='ref')set.add(expr.name);for(const key of ['left','right'])if(expr[key])collectRefs(expr[key],set);for(const arg of expr.args??[])collectRefs(arg,set);}
function references(expr,name){const set=new Set();collectRefs(expr,set);return set.has(name);}
function section(id,payload){return[id,...encodeULEB(payload.length),...payload];}
function encodeULEB(value){const out=[];do{let byte=value&0x7f;value>>>=7;if(value)byte|=0x80;out.push(byte);}while(value);return out;}
function encodeSLEB(value){const out=[];let more=true;while(more){let byte=value&0x7f;value>>=7;const sign=byte&0x40;more=!((value===0&&!sign)||(value===-1&&sign));if(more)byte|=0x80;out.push(byte);}return out;}
