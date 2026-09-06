import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { compile, buildDebugMetadata, verifyDebugMetadata } from '../src/index.js';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function resign(metadata) {
  metadata.digest = crypto.createHash('sha256').update(canonical({
    compilerVersion: metadata.compilerVersion,
    irVersion: metadata.irVersion,
    irKind: metadata.irKind,
    mappings: metadata.mappings
  })).digest('hex');
  return metadata;
}

test('Nova debug verifier binds metadata to the supplied IR identity', () => {
  const compiled = compile('const x = 2 + 3\nreturn x', { file:'identity.cannon', target:'javascript' });
  const metadata = buildDebugMetadata(compiled.ir, { file:'identity.cannon', compilerVersion:'nova-test' });
  assert.equal(verifyDebugMetadata(metadata, compiled.ir, { file:'identity.cannon', compilerVersion:'nova-test' }).ok, true);

  const wrongVersion = resign(structuredClone(metadata));
  wrongVersion.irVersion = 'forged-ir-version';
  resign(wrongVersion);
  assert.equal(verifyDebugMetadata(wrongVersion, compiled.ir).reason, 'IR version mismatch');

  const wrongKind = structuredClone(metadata);
  wrongKind.irKind = 'forged-ir-kind';
  resign(wrongKind);
  assert.equal(verifyDebugMetadata(wrongKind, compiled.ir).reason, 'IR kind mismatch');
});

test('Nova rejects self-consistent metadata with forged mapping identity', () => {
  const compiled = compile('const answer = 42\nreturn answer', { file:'mapping.cannon', target:'javascript' });
  const metadata = buildDebugMetadata(compiled.ir, { file:'mapping.cannon', compilerVersion:'nova-test' });
  const forged = structuredClone(metadata);
  forged.mappings[0].id = '0'.repeat(24);
  resign(forged);
  assert.match(verifyDebugMetadata(forged, compiled.ir).reason, /mapping identity mismatch/);
});

test('Nova optionally binds debug metadata to expected source and compiler identity', () => {
  const compiled = compile('return 1', { file:'expected.cannon', target:'javascript' });
  const metadata = buildDebugMetadata(compiled.ir, { file:'expected.cannon', compilerVersion:'nova-expected' });
  assert.equal(verifyDebugMetadata(metadata, compiled.ir, { file:'other.cannon' }).reason, 'mapping file mismatch at 0');
  assert.equal(verifyDebugMetadata(metadata, compiled.ir, { compilerVersion:'nova-other' }).reason, 'compiler version mismatch');
});
