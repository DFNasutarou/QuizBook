# Quiz Generator Skill

このSkillは、早押しクイズ作成エージェント（オーケストレーター・ライター・レビュワー・フォーマッター）が共通で参照する運用ルールを定義する。

## 適用範囲
- `.github/agents/quiz_orchestrator.md`
- `.github/agents/quiz_writer.md`
- `.github/agents/quiz_reviewer_fact.md`
- `.github/agents/quiz_reviewer_language.md`
- `.github/agents/quiz_reviewer_player.md`
- `.github/agents/quiz_formatter.md`

## 共通ルール
- 問題文は「段階的情報開示（難 -> 中 -> 易）」を満たす。
- 問題文に答え語（複合語を含む）を含めない。
- 答えは一意に定まること。別解がある場合はメモに明示する。
- 読み上げ問題として自然な日本語にする（名詞の羅列、指示語の多用を避ける）。
- 「何を答えるか（人物/作品/地名など）」を冒頭から中盤で示す。

## 難易度ルール
- 標準は `1` から `10` の整数。
- デフォルト難易度は `3`。
- 後方互換として `易`/`中`/`難` も許容する（取り込み時に数値へ正規化可）。

## CSVルール
- ヘッダーは次を厳守する。

```csv
問題文,答え,メモ,ジャンル,難易度,タグ
```

- 出力文字コードは `utf-8-sig`（BOM付きUTF-8）。
- 複数タグはダブルクォートで囲む。

## ファイル運用
- 最終CSVは `data/csv/<テーマ>_<YYYY-MM-DD>.csv` に保存する。
- `_source_` で始まる中間CSVは最終CSV生成後に削除する。
- テーマ固有知識は `.github/skills/quiz-generator/knowledge/` 配下を参照する。
