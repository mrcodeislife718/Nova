import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { compileFrontendArtifact, verifyCannonFrontendArtifact } from '../src/index.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalize(value[key])]));
  return value;
}
function artifact(ast) {
  const body = { protocol:'cannon-frontend/1', frontendVersion:'cannon/0.1', file:'main.cannon', sourceDigest:crypto.createHash('sha256').update('fixture').digest('hex'), ast };
  return { ...body, artifactDigest:crypto.createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex') };
}

test('Nova compiles full canonical Cannon AST without reparsing source', async () => {
  const input = artifact({ type:'Program', body:[
    { type:'FunctionDeclaration', name:'classify', params:['value'], body:{ type:'BlockStatement', body:[
      { type:'IfStatement', test:{ type:'BinaryExpression', operator:'>', left:{type:'Identifier',name:'value'}, right:{type:'Literal',value:10} }, consequent:{ type:'BlockStatement', body:[{ type:'ReturnStatement', value:{ type:'ObjectExpression', properties:[{key:'kind',value:{type:'Literal',value:'large'}},{key:'value',value:{type:'Identifier',name:'value'}}] } }] }, alternate:null },
      { type:'ReturnStatement', value:{ type:'ObjectExpression', properties:[{key:'kind',value:{type:'Literal',value:'small'}},{key:'value',value:{type:'Identifier',name:'value'}}] } }
    ] } },
    { type:'AssignmentStatement', target:{type:'Identifier',name:'result'}, name:'result', value:{type:'CallExpression',callee:{type:'Identifier',name:'classify'},arguments:[{type:'Literal',value:12}]} },
    { type:'ExpressionStatement', expression:{type:'CallExpression',callee:{type:'Identifier',name:'print'},arguments:[{type:'MemberExpression',object:{type:'Identifier',name:'result'},property:{type:'Identifier',name:'kind'},computed:false}]} }
  ] });
  assert.equal(verifyCannonFrontendArtifact(input).ok, true);
  const compiled = compileFrontendArtifact(input);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.ir.version, 2);
  assert.match(compiled.output.code, /function classify\(value\)/);
  assert.match(compiled.output.code, /console\.log\(result\.kind\)/);
  const messages = [];
  const original = console.log;
  console.log = (value) => messages.push(value);
  try { await import(`data:text/javascript,${encodeURIComponent(compiled.output.code)}#${Date.now()}`); }
  finally { console.log = original; }
  assert.deepEqual(messages, ['large']);
});

test('Nova rejects tampered frontend artifacts before compilation', () => {
  const input = artifact({ type:'Program', body:[] });
  input.ast.body.push({ type:'ExpressionStatement', expression:{ type:'Literal', value:1 } });
  assert.equal(verifyCannonFrontendArtifact(input).ok, false);
  assert.throws(() => compileFrontendArtifact(input), /digest mismatch/);
});

test('Nova constant-folds canonical AST expressions in IR', () => {
  const input = artifact({ type:'Program', body:[{ type:'AssignmentStatement', target:{type:'Identifier',name:'answer'}, name:'answer', value:{type:'BinaryExpression',operator:'*',left:{type:'Literal',value:6},right:{type:'Literal',value:7}} }] });
  const compiled = compileFrontendArtifact(input);
  assert.deepEqual(compiled.ir.body[0].value, { kind:'literal', value:42 });
  assert.match(compiled.output.code, /let answer = 42/);
});
