---
name: codex-profile-delegate
description: Delegate one bounded task to Codex through an explicitly registered, existing ChatGPT-login CODEX_HOME. Use when a parent Codex or Claude session should run one child with a chosen model, effort, sandbox, and output path. Do not use for login, profile creation, quota discovery, API-key billing, or automatic account fallback.
---

# Codex Profile Delegate

既存のChatGPTログイン済み `CODEX_HOME` をプロファイル名で選び、Codexへ一段だけ委譲する。ランナーはNode.jsの組み込み機能だけで動く。

## 前提

- 利用者が委譲、対象プロファイル、作業ディレクトリ、モデルを明示していることを確認する。
- モデルには、その利用者のCodexで現在使える実在のslugを指定する。スキル側で旧モデル名を固定しない。
- プロファイルは設定ファイルへ事前登録された既存ディレクトリだけを使う。ログイン、認証ファイルのコピー、プロファイルの自動作成は行わない。
- 実行はChatGPTログインの利用枠を消費する。ランナーは残量を取得しないため、必要なら利用者が実行前に公式の表示で確認する。

初回設定では [config.example.json](config.example.json) を参照する。設定ファイル、brief、出力先を公開リポジトリへコミットしない。

## 委譲手順

1. 依頼の目的、変更範囲、完了条件、必要な検証を短いbriefへ書く。会話全文や認証情報は入れない。
2. `--dry-run` を付けて、解決後のパス、モデル、sandboxを確認する。dry-runは認証確認と子プロセス起動を行わない。
3. 利用者が許可した範囲でのみ `--dry-run` を外す。書き込みが必要な依頼だけ `--sandbox workspace-write` を明示する。
4. 終了後に指定したoutputと作業ツリーを確認する。失敗時は一度で停止するため、変更の有無を確認してから新しいoutput名で再開を判断する。

```powershell
node <skill-directory>\scripts\codex-profile-delegate.mjs `
  --config <private-config.json> `
  --profile work `
  --cd <worktree> `
  --brief <brief.md> `
  --model <available-model-slug> `
  --effort high `
  --sandbox read-only `
  --output <report.md> `
  --dry-run
```

`--config` と `--cd` の相対パスは呼出し元を基準にする。`--brief` と `--output` は解決後の `--cd` を基準にする。設定内のパスは設定ファイルのあるディレクトリを基準にする。

## 守る条件

- `CODEX_DELEGATION_DEPTH` がすでに1以上なら起動しない。子には1を渡し、再委譲を禁止する。
- `OPENAI_API_KEY` などのAPI認証・カスタム接続先を示す環境変数があれば停止する。子にはChatGPTログインとOpenAI providerを強制し、ユーザー設定によるprovider変更を読み込ませない。
- 認証状態は `codex login status` の結果だけで確認し、認証ファイルを読まない。認証値は表示しない。
- 同じ作業ツリーでこのランナーを同時実行しない。既存outputは上書きしない。
- エラー、未ログイン、利用上限、モデル不一致のいずれでも、別プロファイルや別モデルへ自動再送しない。
- 公開、push、送信、購入、ログイン、アカウント切替は、依頼で個別に許可されていない限り子にも行わせない。

