# 早押しクイズ管理ツール（QuizBook）

友達に早押しクイズを出題するためのWebアプリケーションです。ブラウザで動作し、インストール不要で使えます。

## 🌐 オンラインデモ

**[👉 今すぐ使う（GitHub Pages）](https://dfnasutarou.github.io/QuizBook/)**

ブラウザから直接アクセスして、すぐに使い始められます！

## ✨ 機能

### 基本機能
- ✅ クイズ問題の新規作成・編集・削除
- ✅ 問題集の管理（複数の問題集を作成・管理可能）
- ✅ 問題文・答えの色付け機能
- ✅ ふりがな機能（漢字の読み方を括弧で表示）
- ✅ ジャンル・難易度・タグによる問題の分類
- ✅ 全体のフォントサイズ調整機能

### 出題機能
- ✅ ランダム出題機能
- ✅ 前の問題・次の問題への移動
- ✅ 答えの表示・非表示切り替え
- ✅ 複数問題集の組み合わせ出題
- ✅ ジャンル・タグ・難易度によるフィルター機能

### データ管理機能
- ✅ JSON形式での問題集保存・読み込み
- ✅ CSV形式でのインポート・エクスポート
- ✅ 既存問題集の自動整形機能

### 事実確認機能
- ✅ Claude.aiとの連携で問題の事実確認
- ✅ Chrome拡張機能で自動入力・送信（詳細は[FACT_CHECK_GUIDE.md](FACT_CHECK_GUIDE.md)を参照）

## 🚀 使い方

### オンラインで使う（推奨）

**[GitHub Pages版を開く](https://dfnasutarou.github.io/QuizBook/)**

インストール不要で、すぐに使えます！

### ローカルで使う

1. リポジトリをクローン
```bash
git clone https://github.com/DFNasutarou/QuizBook.git
cd QuizBook
```

2. `index.html` をブラウザで開く
   - ファイルをダブルクリック、または
   - ブラウザにドラッグ&ドロップ

### ローカルサーバーで実行（オプション）

```bash
# Pythonの簡易サーバーを使う場合
python -m http.server 8000

# ブラウザで http://localhost:8000 を開く
```

## 📚 ドキュメント

- [詳細な使用方法](docs/README.md)
- [事実確認機能の使い方](FACT_CHECK_GUIDE.md)
- [Chrome拡張機能のインストールガイド](chrome-extension/README.md)
- [フォルダ構成](docs/FOLDER_STRUCTURE.md)

## 🌐 推奨ブラウザ

- Google Chrome (推奨)
- Microsoft Edge
- Firefox
- Safari

## 📁 プロジェクト構成

```
QuizBook/
├── index.html                          # メインHTML
├── app.js                              # JavaScriptアプリケーション
├── styles.css                          # スタイルシート
├── quiz_collections_complete.json      # 統合問題集データ
│
├── chrome-extension/                   # Chrome拡張機能
│   ├── manifest.json
│   ├── content.js
│   ├── background.js
│   └── README.md
│
├── data/                               # データファイル
│   ├── original/                       # 元のCSVファイル
│   ├── formatted/                      # 整形済みJSON
│   └── samples/                        # サンプルファイル
│
├── scripts/                            # ユーティリティスクリプト
│   └── format_existing_data.py         # データ整形スクリプト
│
└── docs/                               # ドキュメント
    ├── README.md                       # 詳細使用方法
    └── FOLDER_STRUCTURE.md             # フォルダ構成
```

## 🛠️ 開発

### データ整形（既存CSVファイルがある場合）

```bash
cd scripts
python format_existing_data.py
```

## 💡 特徴

- **完全クライアントサイド**: サーバー不要、ブラウザだけで動作
- **データ永続化**: ローカルストレージに自動保存
- **オフライン対応**: インターネット接続不要
- **クロスプラットフォーム**: Windows, Mac, Linux対応

## 📄 ライセンス

このプロジェクトは個人利用向けに作成されています。

## 🤝 貢献

バグ報告や機能提案は Issue でお願いします。

---

作成者: [@DFNasutarou](https://github.com/DFNasutarou)
