import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function frame(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

function parseFrames(buffer) {
  const messages = [];
  let rest = buffer;
  while (true) {
    const marker = rest.indexOf('\r\n\r\n');
    if (marker < 0) break;
    const header = rest.slice(0, marker);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const start = marker + 4;
    if (Buffer.byteLength(rest.slice(start)) < length) break;
    const bodyBuffer = Buffer.from(rest.slice(start));
    const body = bodyBuffer.subarray(0, length).toString('utf8');
    messages.push(JSON.parse(body));
    rest = bodyBuffer.subarray(length).toString('utf8');
  }
  return messages;
}

async function runConversation(writes) {
  const child = spawn(process.execPath, ['src/lsp-stdio.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const write of writes) child.stdin.write(write);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Nova LSP test timed out')); }, 3000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  return { messages: parseFrames(stdout), stderr };
}

test('Nova LSP reports malformed JSON and continues serving later requests', async () => {
  const { messages, stderr } = await runConversation([
    frame('{bad json'),
    frame({ jsonrpc:'2.0', id:1, method:'initialize', params:{} }),
    frame({ jsonrpc:'2.0', id:2, method:'shutdown', params:{} }),
    frame({ jsonrpc:'2.0', method:'exit', params:{} })
  ]);
  assert.equal(stderr, '');
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages.find((message) => message.id === 1)?.result.serverInfo.name, 'Nova');
  assert.equal(messages.find((message) => message.id === 2)?.result, null);
});

test('Nova LSP returns Method not found for unknown requests', async () => {
  const { messages } = await runConversation([
    frame({ jsonrpc:'2.0', id:9, method:'nova/unknown', params:{} }),
    frame({ jsonrpc:'2.0', method:'exit', params:{} })
  ]);
  const response = messages.find((message) => message.id === 9);
  assert.equal(response.error.code, -32601);
});

test('Nova LSP rejects oversized frames without buffering their body forever', async () => {
  const declared = 8 * 1024 * 1024 + 1;
  const oversizedHeader = `Content-Length: ${declared}\r\n\r\n`;
  const body = Buffer.alloc(declared, 0x20);
  const initialize = frame({ jsonrpc:'2.0', id:3, method:'initialize', params:{} });
  const exit = frame({ jsonrpc:'2.0', method:'exit', params:{} });
  const { messages } = await runConversation([oversizedHeader, body, initialize, exit]);
  assert.equal(messages[0].error.code, -32600);
  assert.equal(messages.find((message) => message.id === 3)?.result.serverInfo.name, 'Nova');
});
