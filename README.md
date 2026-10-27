# codex-profile-delegate

`codex-profile-delegate` は、利用者が登録した既存の `CODEX_HOME` を名前で選び、Codex CLIへ一段だけ作業を委譲するスキルです。認証ファイルをコピーせず、子プロセスにだけ選択した `CODEX_HOME` を渡します。

このリポジトリは記事本文を含みません。ランナーはNode.jsの組み込み機能だけを使い、npm依存パッケージのインストールも不要です。

## 動作条件

- Node.js 18以上
- 公式のCodex CLI npmパッケージ、または直接起動できる `codex.exe`
- ChatGPTでログイン済みの既存 `CODEX_HOME`
- 利用するアカウントで実在するモデルslug

CLI引数と設定項目はCodex CLI 0.154.0で検証しています。2026年10月27日、Windowsの既存ChatGPTログイン済みプロファイルを使い、read-onlyで短い回答を生成・保存する受入確認も成功しました。ファイル変更を伴う実作業や、他のOSでの動作は未確認です。

ランナーはログイン、プロファイル作成、認証ファイルのコピーを行いません。残量の自動取得機能もありません。必要なら実行前に公式の画面や利用者の環境で確認してください。

## スキルの導入

PowerShellでは、リポジトリのルートで次を実行します。`CODEX_HOME` が未設定なら、通常の `%USERPROFILE%\.codex` を使います。

```powershell
$SkillBase = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $env:USERPROFILE '.codex\skills' }
$SkillTarget = Join-Path $SkillBase 'codex-profile-delegate'
New-Item -ItemType Directory -Force -Path $SkillBase | Out-Null
if (Test-Path -LiteralPath $SkillTarget) { throw '同名スキルが存在します。差分を確認してから更新してください' }
Copy-Item -Recurse '.\skills\codex-profile-delegate' $SkillTarget
```

既存の同名スキルがある場合、この例は上書きせず停止します。内容を比較してから必要なファイルだけを更新してください。

## 1プロファイルの設定

設定は公開リポジトリに置かず、`.local.json` という名前でローカルに保存します。次の例では `C:\path\to\existing\codex-home` を、すでにChatGPTでログイン済みの `CODEX_HOME` に置き換えてください。

公式npmパッケージのJSエントリを使うPowerShell例です。`codex.cmd` や `codex.ps1` は起動しません。

```powershell
$ExistingCodexHome = 'C:\path\to\existing\codex-home'
$CodexJs = Join-Path (npm root -g) '@openai\codex\bin\codex.js'
if (-not (Test-Path -LiteralPath $ExistingCodexHome -PathType Container)) { throw '既存のCODEX_HOMEを指定してください' }
if (-not (Test-Path -LiteralPath $CodexJs -PathType Leaf)) { throw '公式Codex CLIのJSエントリが見つかりません' }
$Config = @{
  version = 1
  launcher = @{
    type = 'node'
    entry = $CodexJs
  }
  profiles = @{
    work = @{
      codexHome = $ExistingCodexHome
    }
  }
}
$Config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '.\codex-profile-delegate.local.json' -Encoding utf8
```

`launcher.type` に `executable` を指定する場合は、`command` に `codex.exe` のパスを設定します。Windowsの `.cmd`、`.bat`、`.ps1` は指定できません。ランナーは `shell: false` で起動するため、シェルによる引数の再解釈を避けられます。

```json
{
  "version": 1,
  "launcher": {
    "type": "executable",
    "command": "C:/path/to/codex.exe"
  },
  "profiles": {
    "work": {
      "codexHome": "C:/path/to/existing/codex-home"
    }
  }
}
```

設定内の相対パスは、設定JSONのあるディレクトリを基準に解決します。配布物に含まれる [config.example.json](skills/codex-profile-delegate/config.example.json) は架空の相対パスを使っています。

## briefとdry-run

次のPowerShell例は、briefを作り、認証や推論を使わずに設定を確認します。`<available-model-slug>` は、利用者の環境で現在使えるモデルslugへ置き換えてください。

```powershell
@'
# 依頼

対象と変更範囲を短く書く。
必要な検証と完了条件を書く。
公開、push、送信は行わない。
'@ | Set-Content -LiteralPath '.\delegate-brief.local.md' -Encoding utf8

node '.\skills\codex-profile-delegate\scripts\codex-profile-delegate.mjs' `
  --config '.\codex-profile-delegate.local.json' `
  --profile work `
  --cd '.' `
  --brief '.\delegate-brief.local.md' `
  --model '<available-model-slug>' `
  --effort high `
  --sandbox read-only `
  --output '.\delegate-report.local.md' `
  --dry-run
```

`--config` と `--cd` の相対パスは、ランナーを呼び出したディレクトリを基準にします。`--brief` と `--output` の相対パスは、解決後の `--cd` を基準にします。空白や日本語を含むパスも、1つの引数として渡せば利用できます。

## 実行

dry-runの表示を確認した後、同じコマンドから `--dry-run` を外します。省略時のsandboxは `read-only` です。ファイルを変更する委譲だけ、許可範囲を確認して `--sandbox workspace-write` を指定してください。

実行前に次の環境変数が設定されていると、ランナーは子を起動せず停止します。

- `OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN`
- `OPENAI_BASE_URL`、`OPENAI_API_BASE`
- Azure OpenAIのAPIキーと接続先
- API利用先を限定するOpenAIのorganization、project設定

ランナーはCodex CLIへ `forced_login_method="chatgpt"` と `model_provider="openai"` を渡し、ユーザーの `config.toml` を読み込ませません。実行前には、選択した `CODEX_HOME` で `codex login status` を一度だけ実行します。結果からChatGPTログインを確認できなければ停止し、認証値やstatusの生出力は表示しません。

利用するCodex CLIには、READMEで使っているオプションと設定項目への対応が必要です。CLIの変更などでChatGPTログインを明確に確認できない場合は、安全のため実行を止めます。別の認証方式へ切り替えるfallbackはありません。

プロンプトはコマンド引数ではなくstdinから渡します。子には `CODEX_DELEGATION_DEPTH=1` を設定するため、このランナーを使った再委譲は止まります。

## 失敗時の再開

失敗時は別プロファイルや別モデルへ自動再送しません。次の順で状態を確認します。

1. 作業ツリーに変更があるか確認する。
2. outputが作成されていれば内容を確認する。
3. 認証、利用上限、モデルslug、sandboxのどこで止まったかを利用者が判断する。
4. 続行する場合は既存変更を引き継ぐbriefを作り、新しいoutput名を指定して一度だけ実行する。

既存outputは上書きしません。同じ作業ツリーで同時に動かせるのも、このランナーの1プロセスだけです。強制終了でロックが残った場合は、表示されたロックファイルのPIDと実行中プロセスを確認してから、利用者がロックを削除します。

作業ツリーのロックは、同じOSユーザーがこのランナーを使った場合にだけ機能します。別のランナーや手動で起動したCodexまでは検出できません。

## CLI

```text
--config FILE       プロファイル設定JSON。必須
--profile NAME      登録済みプロファイル名。必須
--cd DIR            作業ディレクトリ。必須
--brief FILE        stdinへ渡すbrief。必須
--model SLUG        利用可能な実在モデルslug。必須
--effort LEVEL      minimal/low/medium/high/xhigh/max/ultra。必須
--sandbox MODE      read-onlyまたはworkspace-write。既定はread-only
--output FILE       最終回答の保存先。必須、上書き不可
--dry-run           子プロセスを起動せず設定だけを表示
```

## テスト

テストは偽のCodex CLIを子プロセスとして起動します。本物の認証や推論は使いません。

```powershell
npm test
```

空白と日本語を含む引数、PowerShell 5.1が作るUTF-8 BOM付き設定、未ログインとAPI認証の拒否、委譲深さ、output衝突、空または空白だけの最終回答、dry-run、失敗時の単発停止、同一Git worktree内の作業ツリーロックを確認します。
