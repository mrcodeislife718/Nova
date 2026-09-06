#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { compile, structuredDiagnostics, analyzeContracts } from './index.js';

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const documents = new Map();
let buffer = Buffer.alloc(0);
let discardRemaining = 0;

stdin.on('data', (chunk) => {
  consumeChunk(Buffer.from(chunk));
});
stdin.on('error', (error) => {
  sendError(null, -32603, `Nova LSP input failed: ${error.message}`);
});

function consumeChunk(chunk) {
  if (discardRemaining > 0) {
    const discarded = Math.min(discardRemaining, chunk.length);
    discardRemaining -= discarded;
    chunk = chunk.subarray(discarded);
    if (!chunk.length) return;
  }
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  drain();
}

function drain() {
  while (true) {
    if (discardRemaining > 0) {
      const discarded = Math.min(discardRemaining, buffer.length);
      discardRemaining -= discarded;
      buffer = buffer.subarray(discarded);
      if (discardRemaining > 0 || !buffer.length) return;
    }

    const marker = buffer.indexOf('\r\n\r\n');
    if (marker < 0) {
      if (buffer.length > MAX_HEADER_BYTES) {
        buffer = Buffer.alloc(0);
        sendError(null, -32600, 'Nova LSP header exceeds maximum size');
      }
      return;
    }
    if (marker > MAX_HEADER_BYTES) {
      buffer = buffer.subarray(marker + 4);
      sendError(null, -32600, 'Nova LSP header exceeds maximum size');
      continue;
    }

    const header = buffer.subarray(0, marker).toString('ascii');
    const contentLengthHeaders = header.split(/\r\n/).filter((line) => /^Content-Length\s*:/i.test(line));
    if (contentLengthHeaders.length !== 1) {
      buffer = buffer.subarray(marker + 4);
      sendError(null, -32600, 'Nova LSP requires exactly one Content-Length header');
      continue;
    }
    const match = /^Content-Length\s*:\s*(\d+)\s*$/i.exec(contentLengthHeaders[0]);
    if (!match) {
      buffer = buffer.subarray(marker + 4);
      sendError(null, -32600, 'Nova LSP Content-Length is invalid');
      continue;
    }
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0) {
      buffer = buffer.subarray(marker + 4);
      sendError(null, -32600, 'Nova LSP Content-Length is invalid');
      continue;
    }

    buffer = buffer.subarray(marker + 4);
    if (length > MAX_MESSAGE_BYTES) {
      sendError(null, -32600, `Nova LSP message exceeds ${MAX_MESSAGE_BYTES} bytes`);
      const immediatelyDiscarded = Math.min(length, buffer.length);
      buffer = buffer.subarray(immediatelyDiscarded);
      discardRemaining = length - immediatelyDiscarded;
      if (discardRemaining > 0) return;
      continue;
    }
    if (buffer.length < length) {
      // Put a canonical header back so the next chunk can resume the same frame.
      const canonical = Buffer.from(`Content-Length: ${length}\r\n\r\n`, 'ascii');
      buffer = Buffer.concat([canonical, buffer]);
      return;
    }

    const body = buffer.subarray(0, length).toString('utf8');
    buffer = buffer.subarray(length);
    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      sendError(null, -32700, `Nova LSP received invalid JSON: ${error.message}`);
      continue;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendError(null, -32600, 'Nova LSP message must be a JSON object');
      continue;
    }
    try {
      handle(message);
    } catch (error) {
      if (message.id !== undefined) sendError(message.id, -32603, error?.message ?? String(error));
      else notify('window/logMessage', { type: 1, message: `Nova LSP request failed: ${error?.message ?? String(error)}` });
    }
  }
}

function send(message) {
  const json = JSON.stringify(message);
  stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
function response(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, code, message, data = undefined) { send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

function diagnostics(uri, text) {
  const compiled = compile(text, { file: uri });
  const base = structuredDiagnostics(compiled).map((d) => toLspDiagnostic(d));
  const contracts = analyzeContracts(text, { file: uri }).diagnostics.map((d) => ({
    range: { start: toLspPosition(d.span.start), end: toLspPosition(d.span.end) }, severity: 1, code: d.code, source: 'nova', message: d.message
  }));
  return [...base, ...contracts];
}
function toLspDiagnostic(d) {
  const start = d.start ?? { line: 1, column: 1 };
  const end = d.end ?? start;
  return { range: { start: toLspPosition(start), end: toLspPosition(end) }, severity: d.severity === 'warning' ? 2 : 1, code: d.code, source: 'nova', message: d.message };
}
function toLspPosition(position) { return { line: Math.max(0, (position.line ?? 1) - 1), character: Math.max(0, (position.column ?? 1) - 1) }; }
function symbols(uri, text) {
  const contracts = analyzeContracts(text, { file: uri });
  return Object.values(contracts.functions).map((fn) => ({ name: fn.name, kind: 12, range: { start: toLspPosition(fn.span.start), end: toLspPosition(fn.span.end) }, selectionRange: { start: toLspPosition(fn.span.start), end: toLspPosition(fn.span.start) }, detail: `${fn.async ? 'async ' : ''}fn effects=${fn.effects.join(',') || 'none'}` }));
}

function handle(message) {
  const { id, method, params = {} } = message;
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    if (id !== undefined) sendError(id, -32600, 'Invalid JSON-RPC request');
    return;
  }
  if (method === 'initialize') return response(id, { capabilities: { textDocumentSync: 1, documentSymbolProvider: true, hoverProvider: true }, serverInfo: { name: 'Nova', version: '0.1' } });
  if (method === 'initialized') return;
  if (method === 'shutdown') return response(id, null);
  if (method === 'exit') return process.exit(0);
  if (method === 'textDocument/didOpen') {
    documents.set(params.textDocument.uri, params.textDocument.text);
    notify('textDocument/publishDiagnostics', { uri: params.textDocument.uri, diagnostics: diagnostics(params.textDocument.uri, params.textDocument.text) });
    return;
  }
  if (method === 'textDocument/didChange') {
    const text = params.contentChanges?.at(-1)?.text ?? documents.get(params.textDocument.uri) ?? '';
    documents.set(params.textDocument.uri, text);
    notify('textDocument/publishDiagnostics', { uri: params.textDocument.uri, diagnostics: diagnostics(params.textDocument.uri, text) });
    return;
  }
  if (method === 'textDocument/diagnostic') {
    const uri = params.textDocument.uri;
    const text = params.text ?? documents.get(uri) ?? '';
    return response(id, { kind: 'full', items: diagnostics(uri, text) });
  }
  if (method === 'textDocument/documentSymbol') {
    const uri = params.textDocument.uri;
    const text = params.text ?? documents.get(uri) ?? '';
    return response(id, symbols(uri, text));
  }
  if (method === 'textDocument/hover') {
    const uri = params.textDocument.uri;
    const text = documents.get(uri) ?? params.text ?? '';
    const result = analyzeContracts(text, { file: uri });
    return response(id, { contents: { kind: 'markdown', value: `Nova: ${Object.keys(result.functions).length} functions, ${result.diagnostics.length} diagnostics` } });
  }
  if (id !== undefined) return sendError(id, -32601, `Method not found: ${method}`);
}
