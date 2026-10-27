import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(testDirectory, '..');
const runner = path.join(repository, 'skills', 'codex-profile-delegate', 'scripts', 'codex-profile-delegate.mjs');
const fakeCodex = path.join(testDirectory, 'fixtures', 'fake-codex.mjs');
const prohibitedNames = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'CODEX_DELEGATION_DEPTH'
];

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const name of prohibitedNames) delete environment[name];
  return { ...environment, ...extra };
}

function createFixture(label = '通常') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-profile-delegate-${label}-`));
  const workspace = path.join(root, '作業 tree');
  const home = path.join(root, '既存 profile');
  const configDirectory = path.join(root, 'private config');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(configDirectory, { recursive: true });
  const brief = path.join(workspace, '依頼 文.md');
  const output = path.join(workspace, '結果 レポート.md');
  const log = path.join(root, 'fake calls.jsonl');
  fs.writeFileSync(brief, '# 依頼\n\n日本語と空白を保って確認する。\n', 'utf8');
  const config = path.join(configDirectory, 'profiles.json');
  fs.writeFileSync(config, JSON.stringify({
    version: 1,
    launcher: {
      type: 'node',
      entry: path.relative(configDirectory, fakeCodex)
    },
    profiles: {
      work: {
        codexHome: path.relative(configDirectory, home)
      }
    }
  }, null, 2), 'utf8');
  return { root, workspace, home, brief, output, log, config };
}

function baseArgs(fixture) {
  return [
    runner,
    '--config', fixture.config,
    '--profile', 'work',
    '--cd', fixture.workspace,
    '--brief', path.basename(fixture.brief),
    '--model', 'example-model-2026',
    '--effort', 'high',
    '--output', path.basename(fixture.output)
  ];
}

function run(fixture, { args = baseArgs(fixture), environment = {}, cwd = fixture.root } = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    env: cleanEnvironment({
      FAKE_CODEX_LOG: fixture.log,
      FAKE_AUTH_MODE: 'chatgpt',
      ...environment
    }),
    encoding: 'utf8',
    timeout: 15_000
  });
}

function calls(fixture) {
  if (!fs.existsSync(fixture.log)) return [];
  return fs.readFileSync(fixture.log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

test('空白と日本語を含む引数をshellなしで子へ渡す', () => {
  const fixture = createFixture('日本語');
  const result = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(fixture.output), true);
  const records = calls(fixture);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'status');
  assert.equal(records[1].kind, 'exec');
  assert.equal(records[1].cwd, fs.realpathSync(fixture.workspace));
  assert.equal(records[1].codexHome, fixture.home);
  assert.equal(records[1].depth, '1');
  assert.match(records[1].prompt, /日本語と空白を保って確認する/);
  const cdIndex = records[1].args.indexOf('--cd');
  assert.equal(records[1].args[cdIndex + 1], fs.realpathSync(fixture.workspace));
});

test('未ログインならexecを起動しない', () => {
  const fixture = createFixture('未ログイン');
  const result = run(fixture, { environment: { FAKE_AUTH_MODE: 'logged-out' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ChatGPTログインを確認できません/);
  assert.deepEqual(calls(fixture).map(record => record.kind), ['status']);
});

test('API認証なら値を表示せず拒否する', () => {
  const fixture = createFixture('API認証');
  const secret = 'secret-value-must-not-appear';
  const result = run(fixture, {
    environment: { FAKE_AUTH_MODE: 'api', FAKE_STATUS_SECRET: secret }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ChatGPTログインを確認できません/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
  assert.deepEqual(calls(fixture).map(record => record.kind), ['status']);
});

test('APIキー環境があれば子を一つも起動しない', () => {
  const fixture = createFixture('API環境');
  const result = run(fixture, { environment: { OPENAI_API_KEY: 'not-a-real-key' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY/);
  assert.equal(calls(fixture).length, 0);
});

test('委譲深さが1なら起動前に停止する', () => {
  const fixture = createFixture('深さ');
  const result = run(fixture, { environment: { CODEX_DELEGATION_DEPTH: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CODEX_DELEGATION_DEPTH/);
  assert.equal(calls(fixture).length, 0);
});

test('既存outputを上書きせず子を起動しない', () => {
  const fixture = createFixture('衝突');
  fs.writeFileSync(fixture.output, '既存', 'utf8');
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /既存のoutputは上書きしません/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), '既存');
  assert.equal(calls(fixture).length, 0);
});

test('dry-runは認証確認を含む子プロセスを起動しない', () => {
  const fixture = createFixture('dryrun');
  const result = run(fixture, { args: [...baseArgs(fixture), '--dry-run'] });
  assert.equal(result.status, 0, result.stderr);
  const view = JSON.parse(result.stdout);
  assert.equal(view.childProcessStarted, false);
  assert.equal(view.authenticationChecked, false);
  assert.equal(calls(fixture).length, 0);
  assert.equal(fs.existsSync(fixture.output), false);
});

test('PowerShell 5.1形式のUTF-8 BOM付き設定をdry-runで読み込める', () => {
  const fixture = createFixture('BOM設定');
  const content = fs.readFileSync(fixture.config, 'utf8');
  fs.writeFileSync(fixture.config, `\uFEFF${content}`, 'utf8');
  const result = run(fixture, { args: [...baseArgs(fixture), '--dry-run'] });
  assert.equal(result.status, 0, result.stderr);
  const view = JSON.parse(result.stdout);
  assert.equal(view.profile, 'work');
  assert.equal(view.codexHome, fs.realpathSync(fixture.home));
  assert.equal(view.childProcessStarted, false);
});

test('exec失敗後に再送しない', () => {
  const fixture = createFixture('一度');
  const result = run(fixture, { environment: { FAKE_EXEC_MODE: 'fail' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /再送は行っていません/);
  const records = calls(fixture);
  assert.equal(records.filter(record => record.kind === 'status').length, 1);
  assert.equal(records.filter(record => record.kind === 'exec').length, 1);
});

for (const [mode, label] of [['empty', '空'], ['whitespace', '空白のみ']]) {
  test(`最終回答が${label}なら失敗にする`, () => {
    const fixture = createFixture(`output-${mode}`);
    const result = run(fixture, { environment: { FAKE_EXEC_MODE: mode } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outputの最終回答が空/);
    assert.equal(calls(fixture).filter(record => record.kind === 'exec').length, 1);
  });
}

test('作業ツリーの既存ロックがあればexecを起動しない', () => {
  const fixture = createFixture('ロック');
  fs.mkdirSync(path.join(fixture.workspace, '.git'));
  const subdirectory = path.join(fixture.workspace, 'packages', 'app');
  fs.mkdirSync(subdirectory, { recursive: true });
  const canonical = fs.realpathSync(fixture.workspace).replaceAll('\\', '/');
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  const lock = path.join(os.tmpdir(), 'codex-profile-delegate-locks', `${digest}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '{"nonce":"existing"}\n', 'utf8');
  try {
    const args = baseArgs(fixture);
    args[args.indexOf('--cd') + 1] = subdirectory;
    args[args.indexOf('--brief') + 1] = path.relative(subdirectory, fixture.brief);
    args[args.indexOf('--output') + 1] = path.relative(subdirectory, fixture.output);
    const result = run(fixture, { args });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /作業ツリー.*使用中/);
    assert.equal(calls(fixture).filter(record => record.kind === 'exec').length, 0);
  } finally {
    fs.unlinkSync(lock);
  }
});

test('.gitファイルを持つ別worktreeは別のロックを使う', async () => {
  const { worktreeLockPath } = await import('../skills/codex-profile-delegate/scripts/codex-profile-delegate.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-delegate-worktrees-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const firstSubdirectory = path.join(first, 'src');
  const secondSubdirectory = path.join(second, 'src');
  for (const directory of [first, second]) {
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ../metadata\n', 'utf8');
  }
  assert.equal(worktreeLockPath(first), worktreeLockPath(firstSubdirectory));
  assert.equal(worktreeLockPath(second), worktreeLockPath(secondSubdirectory));
  assert.notEqual(worktreeLockPath(first), worktreeLockPath(second));
});
