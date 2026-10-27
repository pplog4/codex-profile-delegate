#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VALUE_OPTIONS = new Set([
  'config',
  'profile',
  'cd',
  'brief',
  'model',
  'effort',
  'sandbox',
  'output'
]);
const FLAG_OPTIONS = new Set(['dry-run', 'help']);
const SANDBOXES = new Set(['read-only', 'workspace-write']);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const PROHIBITED_ENVIRONMENT = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT'
]);

function usage() {
  return `Usage:
  node codex-profile-delegate.mjs --config FILE --profile NAME --cd DIR --brief FILE \\
    --model SLUG --effort LEVEL [--sandbox read-only|workspace-write] --output FILE [--dry-run]

Required:
  --config   登録済みプロファイルを記したJSON
  --profile  config内のプロファイル名
  --cd       子Codexの作業ディレクトリ
  --brief    子へstdinで渡す依頼ファイル。相対パスは--cd基準
  --model    利用者が確認した実在モデルslug
  --effort   minimal|low|medium|high|xhigh|max|ultra
  --output   最終回答の保存先。相対パスは--cd基準

Optional:
  --sandbox  read-only（既定）またはworkspace-write
  --dry-run  パスと設定だけを検証し、認証確認も子プロセス起動も行わない`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`位置引数は使えません: ${argument}`);
    }
    const name = argument.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      result[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      throw new Error(`未対応のオプションです: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} には値が必要です`);
    }
    result[name] = value;
    index += 1;
  }
  return result;
}

function assertRequiredOptions(options) {
  for (const name of ['config', 'profile', 'cd', 'brief', 'model', 'effort', 'output']) {
    if (!options[name]) throw new Error(`--${name} は必須です`);
  }
  if (!PROFILE_PATTERN.test(options.profile)) {
    throw new Error('--profile は英数字、ハイフン、アンダースコアだけで指定してください');
  }
  if (!MODEL_PATTERN.test(options.model)) {
    throw new Error('--model の形式が不正です。利用可能なモデルslugを指定してください');
  }
  if (!EFFORTS.has(options.effort)) {
    throw new Error(`--effort は ${[...EFFORTS].join(', ')} のいずれかです`);
  }
  options.sandbox ??= 'read-only';
  if (!SANDBOXES.has(options.sandbox)) {
    throw new Error('--sandbox は read-only または workspace-write だけを指定できます');
  }
}

function assertDelegationDepth(environment = process.env) {
  const raw = environment.CODEX_DELEGATION_DEPTH;
  if (raw !== undefined && raw !== '' && raw !== '0') {
    throw new Error('委譲済みの子から別のCodexは起動できません（CODEX_DELEGATION_DEPTH）');
  }
}

function readJson(file) {
  try {
    const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`設定JSONを読めません: ${error.message}`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} はオブジェクトで指定してください`);
  }
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} に未対応の項目があります: ${unknown.join(', ')}`);
}

function resolveFrom(base, value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} にはパス文字列が必要です`);
  }
  return path.resolve(base, value);
}

function assertFile(file, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} が見つかりません: ${file}`);
  }
  if (!stat.isFile()) throw new Error(`${label} はファイルではありません: ${file}`);
}

function assertDirectory(directory, label) {
  let stat;
  try {
    stat = fs.statSync(directory);
  } catch {
    throw new Error(`${label} が見つかりません: ${directory}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} はディレクトリではありません: ${directory}`);
}

function loadConfiguration(configFile, profileName) {
  const config = readJson(configFile);
  assertObject(config, '設定');
  assertKnownKeys(config, new Set(['version', 'launcher', 'profiles']), '設定');
  if (config.version !== 1) throw new Error('設定のversionは1を指定してください');

  assertObject(config.launcher, 'launcher');
  assertObject(config.profiles, 'profiles');
  const profile = config.profiles[profileName];
  if (!Object.hasOwn(config.profiles, profileName)) {
    throw new Error(`プロファイルが登録されていません: ${profileName}`);
  }
  assertObject(profile, `profiles.${profileName}`);
  assertKnownKeys(profile, new Set(['codexHome']), `profiles.${profileName}`);

  const base = path.dirname(configFile);
  const codexHome = resolveFrom(base, profile.codexHome, `profiles.${profileName}.codexHome`);
  assertDirectory(codexHome, 'CODEX_HOME');
  const launcher = resolveLauncher(config.launcher, base);
  return { codexHome, launcher };
}

function resolveLauncher(settings, base) {
  const type = settings.type;
  if (type === 'node') {
    assertKnownKeys(settings, new Set(['type', 'entry', 'node']), 'launcher');
    const entry = resolveFrom(base, settings.entry, 'launcher.entry');
    const node = settings.node ? resolveFrom(base, settings.node, 'launcher.node') : process.execPath;
    assertFile(entry, 'Codex CLIのJSエントリ');
    assertFile(node, 'Node実行ファイル');
    return { type, command: node, prefix: [entry], display: entry };
  }
  if (type === 'executable') {
    assertKnownKeys(settings, new Set(['type', 'command']), 'launcher');
    const command = resolveFrom(base, settings.command, 'launcher.command');
    if (/\.(cmd|bat|ps1)$/i.test(command)) {
      throw new Error('shell:falseで安全に起動するため、cmd/bat/ps1ではなくcodex.exeを指定してください');
    }
    assertFile(command, 'Codex実行ファイル');
    return { type, command, prefix: [], display: command };
  }
  throw new Error('launcher.type は node または executable を指定してください');
}

function resolveTaskPaths(options, invocationDirectory) {
  const workdir = path.resolve(invocationDirectory, options.cd);
  assertDirectory(workdir, '--cd');
  const canonicalWorkdir = fs.realpathSync(workdir);
  const brief = path.resolve(canonicalWorkdir, options.brief);
  const output = path.resolve(canonicalWorkdir, options.output);
  assertFile(brief, '--brief');
  const size = fs.statSync(brief).size;
  if (size > 1024 * 1024) throw new Error('--brief は1 MiB以下にしてください');
  if (path.resolve(brief) === path.resolve(output)) {
    throw new Error('--brief と --output に同じファイルは指定できません');
  }
  if (fs.existsSync(output)) throw new Error(`既存のoutputは上書きしません: ${output}`);
  return { workdir: canonicalWorkdir, brief, output };
}

function presentProhibitedEnvironment(environment) {
  return Object.entries(environment)
    .filter(([key, value]) => value && PROHIBITED_ENVIRONMENT.has(key.toUpperCase()))
    .map(([key]) => key)
    .sort();
}

function childEnvironment(codexHome) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (PROHIBITED_ENVIRONMENT.has(key.toUpperCase())) delete environment[key];
  }
  environment.CODEX_HOME = codexHome;
  environment.CODEX_DELEGATION_DEPTH = '1';
  delete environment.CODEX_SESSION_ID;
  delete environment.CODEX_THREAD_ID;
  delete environment.CODEX_APP_TOOLS_PIPE_PATH;
  delete environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return environment;
}

function runCaptured(launcher, args, { cwd, environment, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => (current + chunk).slice(-128 * 1024);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function verifyChatGptLogin(launcher, cwd, environment) {
  const args = [
    'login',
    'status',
    '--config',
    'forced_login_method="chatgpt"',
    '--config',
    'model_provider="openai"'
  ];
  const result = await runCaptured(launcher, args, { cwd, environment });
  const status = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  if (result.code !== 0 || !/logged in using chatgpt/i.test(status)) {
    throw new Error('選択したプロファイルのChatGPTログインを確認できません。ログイン操作は行わず停止しました');
  }
}

function canonicalKey(value) {
  const normalized = fs.realpathSync(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function gitWorktreeRoot(workdir) {
  let current = fs.realpathSync(workdir);
  while (true) {
    const marker = path.join(current, '.git');
    try {
      const stat = fs.statSync(marker);
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return fs.realpathSync(workdir);
    current = parent;
  }
}

function worktreeLockPath(workdir) {
  const digest = crypto.createHash('sha256').update(canonicalKey(gitWorktreeRoot(workdir))).digest('hex');
  return path.join(os.tmpdir(), 'codex-profile-delegate-locks', `${digest}.lock`);
}

function acquireLock(file, owner, label) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    fs.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error.code === 'EEXIST') {
      throw new Error(`${label} は使用中です。実行中の処理を確認してください: ${file}`);
    }
    throw error;
  }
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.nonce === owner.nonce) fs.unlinkSync(file);
    } catch {
      // 所有権を確認できないロックは削除しない。
    }
  };
}

function buildPrompt(brief, sandbox) {
  const writeScope = sandbox === 'read-only'
    ? 'この依頼はread-onlyです。ファイルの作成、変更、削除や書込みを伴う検証を行わないでください。'
    : '変更はbriefで許可された作業ディレクトリと範囲に限定してください。';
  return `あなたは親セッションから一段だけ委譲されたCodex実行者です。最寄りのAGENTS.mdに従ってください。CODEX_DELEGATION_DEPTH=1のため、別のCodexを起動したり再委譲したりしないでください。${writeScope} 公開、push、デプロイ、送信、購入、ログイン、アカウント切替は、briefで個別に許可されていない限り行わないでください。実施した検証と未解決事項を区別し、テストを実行していない場合は実行済みと書かないでください。\n\n# Brief\n\n${brief}`;
}

function buildExecArgs(options, taskPaths) {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--cd',
    taskPaths.workdir,
    '--sandbox',
    options.sandbox,
    '--config',
    'approval_policy="on-request"',
    '--config',
    'approvals_reviewer="auto_review"',
    '--config',
    'forced_login_method="chatgpt"',
    '--config',
    'model_provider="openai"',
    '--config',
    `model_reasoning_effort="${options.effort}"`,
    '--config',
    'service_tier="default"',
    '--config',
    'agents.max_threads=1',
    '--model',
    options.model,
    '--output-last-message',
    taskPaths.output,
    '-'
  ];
}

function dryRunView(options, configFile, configuration, taskPaths) {
  return {
    mode: 'dry-run',
    childProcessStarted: false,
    authenticationChecked: false,
    config: configFile,
    profile: options.profile,
    codexHome: configuration.codexHome,
    launcher: {
      type: configuration.launcher.type,
      path: configuration.launcher.display
    },
    cwd: taskPaths.workdir,
    brief: taskPaths.brief,
    model: options.model,
    effort: options.effort,
    sandbox: options.sandbox,
    output: taskPaths.output
  };
}

export async function main(argv = process.argv.slice(2), invocationDirectory = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  assertRequiredOptions(options);
  assertDelegationDepth();

  const configFile = path.resolve(invocationDirectory, options.config);
  assertFile(configFile, '--config');
  const configuration = loadConfiguration(configFile, options.profile);
  const taskPaths = resolveTaskPaths(options, invocationDirectory);

  if (options['dry-run']) {
    console.log(JSON.stringify(dryRunView(options, configFile, configuration, taskPaths), null, 2));
    return 0;
  }

  const prohibited = presentProhibitedEnvironment(process.env);
  if (prohibited.length) {
    throw new Error(`API認証やカスタム接続先を示す環境変数が設定されています: ${prohibited.join(', ')}`);
  }

  const environment = childEnvironment(configuration.codexHome);
  await verifyChatGptLogin(configuration.launcher, taskPaths.workdir, environment);

  if (fs.existsSync(taskPaths.output)) {
    throw new Error(`既存のoutputは上書きしません: ${taskPaths.output}`);
  }
  fs.mkdirSync(path.dirname(taskPaths.output), { recursive: true });

  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: taskPaths.workdir,
    profile: options.profile,
    nonce: crypto.randomUUID()
  };
  const releases = [];
  try {
    releases.push(acquireLock(worktreeLockPath(taskPaths.workdir), owner, '作業ツリー'));
    releases.push(acquireLock(`${taskPaths.output}.lock`, owner, 'output'));
    if (fs.existsSync(taskPaths.output)) {
      throw new Error(`既存のoutputは上書きしません: ${taskPaths.output}`);
    }

    const brief = fs.readFileSync(taskPaths.brief, 'utf8');
    const prompt = buildPrompt(brief, options.sandbox);
    const result = await runCaptured(
      configuration.launcher,
      buildExecArgs(options, taskPaths),
      { cwd: taskPaths.workdir, environment, input: prompt }
    );
    if (result.code !== 0) {
      throw new Error(`Codexは終了コード${result.code ?? 'unknown'}で停止しました。再送は行っていません`);
    }
    if (!fs.existsSync(taskPaths.output)) {
      throw new Error('Codexは正常終了しましたがoutputを作成しませんでした。再送は行っていません');
    }
    if (fs.readFileSync(taskPaths.output, 'utf8').trim() === '') {
      throw new Error('Codexは正常終了しましたがoutputの最終回答が空です。再送は行っていません');
    }
    console.log(`委譲が完了しました: ${taskPaths.output}`);
    return 0;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      console.error(`エラー: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

export {
  assertDelegationDepth,
  buildExecArgs,
  childEnvironment,
  gitWorktreeRoot,
  parseArgs,
  presentProhibitedEnvironment,
  worktreeLockPath
};
