export class NovaDiagnosticError extends Error {
  constructor(diagnostics) {
    super(diagnostics[0]?.message ?? 'Nova analysis failed');
    this.name = 'NovaDiagnosticError';
    this.diagnostics = diagnostics;
  }
}

function literalType(text) {
  const value = text.trim();
  if (/^[-+]?\d+$/.test(value)) return 'integer';
  if (/^[-+]?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) return 'float';
  if (/^(true|false)$/.test(value)) return 'boolean';
  if (/^null$/.test(value)) return 'null';
  if (/^(['"]).*\1$/s.test(value)) return 'string';
  if (/^\[.*\]$/s.test(value)) return 'array';
  if (/^\{.*\}$/s.test(value)) return 'object';
  return null;
}

function locationFor(line, fragment, lineNumber) {
  const column = Math.max(1, line.indexOf(fragment) + 1);
  return { line: lineNumber, column, endColumn: column + Math.max(1, fragment.length) };
}

export function analyze(source, options = {}) {
  const file = options.file ?? '<memory>';
  const bindings = new Map();
  const diagnostics = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    const stripped = raw.replace(/\/\/.*$/, '').trim();
    if (!stripped) continue;
    const declaration = stripped.match(/^(?:let|const\s+|let\s+|const\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (!declaration) continue;
    const [, name, expression] = declaration;
    const inferred = literalType(expression);
    const current = bindings.get(name);
    if (!current) {
      bindings.set(name, { name, type: inferred ?? 'unknown', origin: { file, ...locationFor(raw, name, lineNumber) }, assignments: [{ file, ...locationFor(raw, expression, lineNumber), inferred: inferred ?? 'unknown' }] });
      continue;
    }
    current.assignments.push({ file, ...locationFor(raw, expression, lineNumber), inferred: inferred ?? 'unknown' });
    if (current.type !== 'unknown' && inferred && current.type !== inferred) {
      diagnostics.push({ code: 'NOVA-T1001', severity: 'error', message: `Conflicting inferred types for '${name}': ${current.type} then ${inferred}`, file, ...locationFor(raw, expression, lineNumber), origin: current.origin, notes: [`'${name}' was first inferred as ${current.type} at ${current.origin.file}:${current.origin.line}:${current.origin.column}`] });
    } else if (current.type === 'unknown' && inferred) current.type = inferred;
  }
  return { ok: diagnostics.length === 0, bindings: Object.fromEntries([...bindings.entries()].map(([name, value]) => [name, value])), diagnostics };
}

export function assertValid(source, options = {}) { const result = analyze(source, options); if (!result.ok) throw new NovaDiagnosticError(result.diagnostics); return result; }
export function formatDiagnostic(diagnostic, source) {
  const lines = source.split(/\r?\n/); const line = lines[diagnostic.line - 1] ?? '';
  const width = Math.max(1, (diagnostic.endColumn ?? diagnostic.column + 1) - diagnostic.column);
  const marker = `${' '.repeat(Math.max(0, diagnostic.column - 1))}${'^'.repeat(width)}`;
  const notes = (diagnostic.notes ?? []).map((note) => `note: ${note}`).join('\n');
  return `${diagnostic.code} — ${diagnostic.message}\n${diagnostic.file}:${diagnostic.line}:${diagnostic.column}\n\n${line}\n${marker}${notes ? `\n\n${notes}` : ''}`;
}

export * from './compiler.js';
export { ExactSourceMap, analyzeContracts, buildDebugMetadata, verifyDebugMetadata } from './contracts.js';
