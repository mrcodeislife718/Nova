import crypto from 'node:crypto';

const EFFECT_BUILTINS = Object.freeze({
  print: 'io.console',
  readFile: 'io.filesystem.read',
  writeFile: 'io.filesystem.write',
  fetch: 'io.network',
  request: 'io.network',
  spawn: 'process.spawn',
  sleep: 'time.wait',
  randomBytes: 'crypto.random'
});

export class ExactSourceMap {
  constructor(source, file = '<memory>') {
    this.source = source;
    this.file = file;
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') this.lineStarts.push(i + 1);
  }
  position(offset) {
    if (!Number.isInteger(offset)) throw new TypeError('offset must be an integer');
    const safe = Math.max(0, Math.min(this.source.length, offset));
    let low = 0, high = this.lineStarts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.lineStarts[mid] <= safe) low = mid + 1;
      else high = mid - 1;
    }
    const lineIndex = Math.max(0, high);
    return { file: this.file, offset: safe, line: lineIndex + 1, column: safe - this.lineStarts[lineIndex] + 1 };
  }
  span(start, end) { return { start: this.position(start), end: this.position(end) }; }
}

export function analyzeContracts(source, { file = '<memory>' } = {}) {
  const map = new ExactSourceMap(source, file);
  const functions = new Map();
  const diagnostics = [];
  const headers = findFunctionHeaders(source);

  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    const bodyStart = header.bodyStart;
    const bodyEnd = findMatchingBrace(source, bodyStart - 1);
    if (bodyEnd < 0) {
      diagnostics.push(diagnostic('NOVA-F1001', 'Unterminated function body', map.span(header.start, header.bodyStart)));
      continue;
    }
    const params = parseParameters(header.params, map, header.paramsOffset, diagnostics);
    const declaredReturn = header.returnType?.trim() || null;
    const body = source.slice(bodyStart, bodyEnd);
    const functionSpan = map.span(header.start, bodyEnd + 1);
    const calls = scanCalls(body, bodyStart, map);
    const returns = scanReturns(body, bodyStart, map);
    const inferredReturns = returns.map((entry) => inferExpressionType(entry.expression)).filter((value) => value !== 'unknown');
    const inferredReturn = unifyReturnTypes(inferredReturns);
    if (declaredReturn && inferredReturn !== 'unknown' && !compatibleReturn(declaredReturn, inferredReturn)) {
      const returnEntry = returns.find((entry) => inferExpressionType(entry.expression) !== 'unknown') ?? returns[0];
      diagnostics.push(diagnostic('NOVA-F1002', `Function '${header.name}' declares ${declaredReturn} but returns ${inferredReturn}`, returnEntry?.span ?? functionSpan));
    }
    const directEffects = new Set();
    for (const call of calls) if (EFFECT_BUILTINS[call.name]) directEffects.add(EFFECT_BUILTINS[call.name]);
    const asyncBoundary = header.async || calls.some((call) => call.awaited);
    if (!header.async) {
      for (const call of calls.filter((entry) => entry.awaited)) diagnostics.push(diagnostic('NOVA-A1001', `await crosses an async boundary inside non-async function '${header.name}'`, call.span));
    }
    functions.set(header.name, {
      name: header.name,
      async: header.async,
      asyncBoundary,
      parameters: params,
      declaredReturn,
      inferredReturn,
      span: functionSpan,
      calls,
      directEffects: [...directEffects].sort(),
      effects: [...directEffects].sort(),
      returns
    });
  }

  const changed = () => {
    let didChange = false;
    for (const fn of functions.values()) {
      const effects = new Set(fn.directEffects);
      for (const call of fn.calls) {
        const target = functions.get(call.name);
        if (!target) continue;
        for (const effect of target.effects) effects.add(effect);
        if (target.async && !fn.async && !call.awaited) {
          diagnostics.push(diagnosticOnce(diagnostics, 'NOVA-A1002', `Async function '${target.name}' is called without await from '${fn.name}'`, call.span));
        }
      }
      const next = [...effects].sort();
      if (next.join('\0') !== fn.effects.join('\0')) { fn.effects = next; didChange = true; }
    }
    return didChange;
  };
  for (let i = 0; i < functions.size + 1 && changed(); i++);

  const callGraph = [];
  for (const fn of functions.values()) {
    for (const call of fn.calls) if (functions.has(call.name)) callGraph.push({ from: fn.name, to: call.name, awaited: call.awaited, span: call.span });
  }

  return {
    ok: !diagnostics.some((entry) => entry.severity === 'error'),
    file,
    functions: Object.fromEntries([...functions].map(([name, value]) => [name, cloneContract(value)])),
    callGraph,
    diagnostics: dedupeDiagnostics(diagnostics)
  };
}

export function buildDebugMetadata(ir, { file = '<memory>', compilerVersion = 'nova/1' } = {}) {
  if (!ir || !Array.isArray(ir.instructions)) throw new TypeError('Cannon IR with instructions is required');
  const mappings = (ir.sourceMap ?? []).map((entry) => {
    const span = structuredClone(entry.span ?? null);
    const stable = JSON.stringify({ ir: entry.ir, file, start: span?.start?.offset ?? null, end: span?.end?.offset ?? null });
    return { id: crypto.createHash('sha256').update(stable).digest('hex').slice(0, 24), ir: entry.ir, file, span };
  });
  return {
    protocol: 'nova-debug/1',
    compilerVersion,
    irVersion: ir.version ?? null,
    irKind: ir.kind ?? null,
    mappings,
    digest: crypto.createHash('sha256').update(canonical({ compilerVersion, irVersion: ir.version ?? null, irKind: ir.kind ?? null, mappings })).digest('hex')
  };
}

export function verifyDebugMetadata(metadata, ir) {
  if (metadata?.protocol !== 'nova-debug/1') return { ok: false, reason: 'unsupported debug metadata protocol' };
  if (metadata.mappings.length !== (ir.sourceMap ?? []).length) return { ok: false, reason: 'mapping count mismatch' };
  for (let index = 0; index < metadata.mappings.length; index++) {
    const mapping = metadata.mappings[index];
    const expected = ir.sourceMap[index];
    if (mapping.ir !== expected.ir || JSON.stringify(mapping.span) !== JSON.stringify(expected.span)) return { ok: false, reason: `mapping mismatch at ${index}` };
  }
  const { digest, ...body } = metadata;
  const recalculated = crypto.createHash('sha256').update(canonical(body)).digest('hex');
  return { ok: recalculated === digest, reason: recalculated === digest ? null : 'digest mismatch' };
}

function findFunctionHeaders(source) {
  const out = [];
  const regex = /(^|\n)([ \t]*)(async\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:->\s*([^\s{]+))?\s*\{/g;
  let match;
  while ((match = regex.exec(source))) {
    const leading = match[1].length;
    const start = match.index + leading + match[2].length;
    const braceIndex = regex.lastIndex - 1;
    const paramsText = match[5];
    const paramsOffset = source.indexOf(paramsText, start);
    out.push({ start, name: match[4], async: Boolean(match[3]), params: paramsText, paramsOffset, returnType: match[6] ?? null, bodyStart: braceIndex + 1 });
  }
  return out;
}

function findMatchingBrace(source, open) {
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) { if (char === quote && source[i - 1] !== '\\') quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

function parseParameters(text, map, offset, diagnostics) {
  if (!text.trim()) return [];
  return splitArgs(text).map((part) => {
    const match = part.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*(.+))?$/);
    const local = text.indexOf(part);
    const span = map.span(offset + local, offset + local + part.length);
    if (!match) {
      diagnostics.push(diagnostic('NOVA-F1003', `Invalid function parameter '${part}'`, span));
      return { name: part, type: 'unknown', span };
    }
    return { name: match[1], type: match[2]?.trim() || 'inferred', span };
  });
}

function scanCalls(body, base, map) {
  const calls = [];
  const regex = /\b(await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  const keywords = new Set(['if','while','for','switch','catch']);
  while ((match = regex.exec(body))) {
    if (keywords.has(match[2])) continue;
    const nameOffset = base + match.index + (match[1]?.length ?? 0);
    calls.push({ name: match[2], awaited: Boolean(match[1]), span: map.span(nameOffset, nameOffset + match[2].length) });
  }
  return calls;
}

function scanReturns(body, base, map) {
  const returns = [];
  const regex = /\breturn\s+([^\n;}]+)/g;
  let match;
  while ((match = regex.exec(body))) {
    const expression = match[1].trim();
    const expressionOffset = base + match.index + match[0].indexOf(match[1]) + match[1].indexOf(expression);
    returns.push({ expression, type: inferExpressionType(expression), span: map.span(expressionOffset, expressionOffset + expression.length) });
  }
  return returns;
}

function inferExpressionType(expression) {
  const value = expression.trim();
  if (/^-?\d+$/.test(value)) return 'integer';
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) return 'float';
  if (/^(true|false)$/.test(value)) return 'boolean';
  if (value === 'null') return 'null';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return 'string';
  if (/^\[.*\]$/s.test(value)) return 'array';
  if (/^\{.*\}$/s.test(value)) return 'object';
  return 'unknown';
}
function unifyReturnTypes(types) { const unique = [...new Set(types)]; if (!unique.length) return 'unknown'; if (unique.length === 1) return unique[0]; if (unique.every((type) => type === 'integer' || type === 'float')) return 'float'; return `union<${unique.sort().join('|')}>`; }
function compatibleReturn(declared, inferred) { const normalized = declared.toLowerCase(); const map = { i8:'integer',i16:'integer',i32:'integer',i64:'integer',u8:'integer',u16:'integer',u32:'integer',u64:'integer',f32:'float',f64:'float,bool:'boolean',str:'string' }; return (map[normalized] ?? normalized) === inferred || normalized === 'number' && ['integer','float'].includes(inferred); }
function splitArgs(text) { const out=[]; let start=0,depth=0,quote=null; for(let i=0;i<text.length;i++){const c=text[i]; if(quote){if(c===quote&&text[i-1]!=="\\")quote=null;continue;} if(c==='"'||c==="'"){quote=c;continue;} if('([{<'.includes(c))depth++; else if(')]}>'.includes(c))depth--; else if(c===','&&depth===0){out.push(text.slice(start,i).trim());start=i+1;}} const tail=text.slice(start).trim(); if(tail)out.push(tail); return out; }
function diagnostic(code, message, span) { return { code, severity: 'error', message, span, file: span?.start?.file ?? null }; }
function diagnosticOnce(existing, code, message, span) { return existing.some((entry) => entry.code === code && entry.span?.start?.offset === span?.start?.offset) ? existing.find((entry) => entry.code === code && entry.span?.start?.offset === span?.start?.offset) : diagnostic(code, message, span); }
function dedupeDiagnostics(diagnostics) { const seen=new Set(); return diagnostics.filter((entry)=>{const key=`${entry.code}:${entry.span?.start?.offset}:${entry.message}`; if(seen.has(key))return false; seen.add(key); return true;}); }
function cloneContract(value) { return { ...structuredClone(value), calls: value.calls.map((entry) => structuredClone(entry)), returns: value.returns.map((entry) => structuredClone(entry)) }; }
function canonical(value) { if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`; if(value&&typeof value==='object')return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
