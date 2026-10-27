#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const logFile = process.env.FAKE_CODEX_LOG;

async function readStdin() {
  let content = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) content += chunk;
  return content;
}

function appendLog(record) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
}

if (args[0] === 'login' && args[1] === 'status') {
  appendLog({
    kind: 'status',
    args,
    cwd: process.cwd(),
    codexHome: process.env.CODEX_HOME,
    depth: process.env.CODEX_DELEGATION_DEPTH
  });
  const mode = process.env.FAKE_AUTH_MODE || 'chatgpt';
  if (mode === 'chatgpt') {
    console.log('Logged in using ChatGPT');
    process.exit(0);
  }
  if (mode === 'api') {
    console.log('Logged in using an API key');
    if (process.env.FAKE_STATUS_SECRET) console.error(process.env.FAKE_STATUS_SECRET);
    process.exit(0);
  }
  console.error('Not logged in');
  process.exit(1);
}

if (args[0] === 'exec') {
  const prompt = await readStdin();
  appendLog({
    kind: 'exec',
    args,
    cwd: process.cwd(),
    codexHome: process.env.CODEX_HOME,
    depth: process.env.CODEX_DELEGATION_DEPTH,
    prompt
  });
  if (process.env.FAKE_EXEC_MODE === 'fail') {
    console.error('fake execution failed');
    process.exit(23);
  }
  const outputIndex = args.indexOf('--output-last-message');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!output) process.exit(24);
  const outputContent = process.env.FAKE_EXEC_MODE === 'empty'
    ? ''
    : process.env.FAKE_EXEC_MODE === 'whitespace'
      ? ' \r\n\t\n'
      : '# Fake Codex report\n\n完了しました。\n';
  fs.writeFileSync(output, outputContent, 'utf8');
  console.log(JSON.stringify({ type: 'turn.completed' }));
  process.exit(0);
}

appendLog({ kind: 'unknown', args });
process.exit(25);
