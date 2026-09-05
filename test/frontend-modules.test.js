import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { compileFrontendArtifact, lowerFrontendArtifact } from '../src/index.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
  return value;
}
function artifact(ast) {
  const body = { protocol:'cannon-frontend/1', frontendVersion:'cannon/0.1', file:'main.cannon', sourceDigest:crypto.createHash('sha256').update('module-fixture').digest('hex'), ast };
  return { ...body, artifactDigest:crypto.createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex') };
}

test('Nova preserves Cannon module dependencies in canonical IR', () => {
  const input = artifact({ type:'Program', body:[
    { type:'ImportDeclaration', source:'./math.mjs', specifiers:[{type:'ImportSpecifier',imported:'add',local:'sum'}] },
    { type:'ExportNamedDeclaration', source:'./constants.mjs', declaration:null, specifiers:[{local:'pi',exported:'PI'}] },
    { type:'ExportNamedDeclaration', source:null, specifiers:[], declaration:{ type:'VariableDeclaration', kind:'const', name:'answer', value:{type:'CallExpression',callee:{type:'Identifier',name:'sum'},arguments:[{type:'Literal',value:20},{type:'Literal',value:22}]} } }
  ] });
  const ir = lowerFrontendArtifact(input);
  assert.deepEqual(ir.dependencies, ['./constants.mjs','./math.mjs']);
  assert.equal(ir.body[0].op, 'import');
  assert.equal(ir.body[2].op, 'export-named');
});

test('Nova emits standards-compatible ESM from Cannon module IR', () => {
  const input = artifact({ type:'Program', body:[
    { type:'ImportDeclaration', source:'./dep.mjs', specifiers:[{type:'ImportDefaultSpecifier',local:'base'},{type:'ImportSpecifier',imported:'add',local:'sum'}] },
    { type:'ExportNamedDeclaration', source:null, specifiers:[], declaration:{ type:'VariableDeclaration', kind:'const', name:'answer', value:{type:'CallExpression',callee:{type:'Identifier',name:'sum'},arguments:[{type:'Identifier',name:'base'},{type:'Literal',value:2}]} } },
    { type:'ExportDefaultDeclaration', declaration:{type:'Identifier',name:'answer'} }
  ] });
  const compiled = compileFrontendArtifact(input);
  assert.equal(compiled.ok, true);
  assert.match(compiled.output.code, /import base, \{ add as sum \} from "\.\/dep\.mjs";/);
  assert.match(compiled.output.code, /export const answer = sum\(base, 2\);/);
  assert.match(compiled.output.code, /export default answer;/);
});
