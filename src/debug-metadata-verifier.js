import crypto from 'node:crypto';

export function verifyDebugMetadata(metadata, ir, { file = null, compilerVersion = null } = {}) {
  if (metadata?.protocol !== 'nova-debug/1') return fail('unsupported debug metadata protocol');
  if (!ir || !Array.isArray(ir.instructions)) return fail('Cannon IR with instructions is required');
  if (!Array.isArray(metadata.mappings)) return fail('debug mappings are required');
  if (metadata.irVersion !== (ir.version ?? null)) return fail('IR version mismatch');
  if (metadata.irKind !== (ir.kind ?? null)) return fail('IR kind mismatch');
  if (compilerVersion != null && metadata.compilerVersion !== compilerVersion) return fail('compiler version mismatch');
  if (metadata.mappings.length !== (ir.sourceMap ?? []).length) return fail('mapping count mismatch');

  for (let index = 0; index < metadata.mappings.length; index++) {
    const mapping = metadata.mappings[index];
    const expected = ir.sourceMap[index];
    if (!mapping || mapping.ir !== expected.ir || canonical(mapping.span) !== canonical(expected.span)) return fail(`mapping mismatch at ${index}`);
    if (file != null && mapping.file !== file) return fail(`mapping file mismatch at ${index}`);
    if (typeof mapping.file !== 'string' || !mapping.file) return fail(`mapping file missing at ${index}`);
    const expectedId = mappingId(mapping.ir, mapping.file, mapping.span);
    if (mapping.id !== expectedId) return fail(`mapping identity mismatch at ${index}`);
  }

  const recalculated = digestMetadata(metadata);
  if (!constantTimeHexEqual(recalculated, metadata.digest)) return fail('digest mismatch');
  return { ok: true, reason: null };
}

function mappingId(ir, file, span) {
  const stable = JSON.stringify({
    ir,
    file,
    start: span?.start?.offset ?? null,
    end: span?.end?.offset ?? null
  });
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

function digestMetadata(metadata) {
  return crypto.createHash('sha256').update(canonical({
    compilerVersion: metadata.compilerVersion,
    irVersion: metadata.irVersion,
    irKind: metadata.irKind,
    mappings: metadata.mappings
  })).digest('hex');
}

function constantTimeHexEqual(actual, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fail(reason) {
  return { ok: false, reason };
}
