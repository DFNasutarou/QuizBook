# 早押しクイズ管理ツール（QuizBook）

友達に早押しクイズを出題するためのWebアプリケーションです。ブラウザで動作し、インストール不要で使えます。

## 🌐 オンラインデモ

**[👉 今すぐ使う（GitHub Pages）](https://dfnasutarou.github.io/QuizBook/)**

**[👁 閲覧モードで開く](https://dfnasutarou.github.io/QuizBook/?view)**（データを端末に残さない・編集不可）

ブラウザから直接アクセスして、すぐに使い始められます！

## ✨ 機能

### 基本機能
- ✅ クイズ問題の新規作成・編集・削除
- ✅ 問題集の管理（複数の問題集を作成・管理可能）
- ✅ 問題文・答えの色付け機能
- ✅ ふりがな機能（漢字の読み方を括弧で表示）
- ✅ ジャンル・難易度・タグによる問題の分類
- ✅ 全体のフォントサイズ調整機能

### クラウド同期機能 ☁️ NEW!
- ✅ **複数PC・ブラウザで自動同期**
- ✅ リアルタイム更新（別のPCで変更すると即座に反映）
- ✅ 自動バックアップ
- ✅ オフライン対応（接続が戻ったら自動同期）
- ✅ **完全無料**（Firebase無料枠で十分）

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
- [クラウド同期機能の使い方](#-クラウド同期の使い方)
- [クラウド同期デバッグガイド](SYNC_DEBUG_GUIDE.md)（同期エラーが出る場合）
- [Firestoreセキュリティルール設定](FIRESTORE_SECURITY_GUIDE.md)（クラウド同期を使う場合は必読）
- [事実確認機能の使い方](FACT_CHECK_GUIDE.md)
- [Chrome拡張機能のインストールガイド](chrome-extension/README.md)
- [フォルダ構成](docs/FOLDER_STRUCTURE.md)

## ☁️ クラウド同期の使い方

### 初回設定（1回だけ）

クラウド同期を使う前に、Firestoreのセキュリティルールを設定する必要があります。

👉 **[Firestoreセキュリティルール設定ガイド](FIRESTORE_SECURITY_GUIDE.md)を参照してください**

**重要**: サブコレクション（`meta/summary`、`collections/{id}`）へのアクセス権限も必要です。

### 🔧 トラブルシューティング

#### 同期エラーが発生する場合

1. **開発者ツールのコンソールを開く**（F12キー）
2. **診断コマンドを実行**:
   ```javascript
   await window.firebaseSync.diagnose()
   ```
3. **出力を確認**:
   - `permission-denied`エラー → セキュリティルールを確認
   - ドキュメントが存在しない → データ保存を実行
   - タイムアウト → ネットワーク接続を確認

#### セキュリティルールの確認

[Firebase Console](https://console.firebase.google.com/) で以下を確認：
- Firestore Database → ルール
- サブコレクションへのアクセスが許可されているか
- 詳細は[FIRESTORE_SECURITY_GUIDE.md](FIRESTORE_SECURITY_GUIDE.md)を参照

### 🔑 同期コードで複数デバイスを接続

#### 1台目（PCなど）

1. アプリを開く
2. ヘッダーの **☁️ 同期OFF** ボタンをクリック
3. 「**OK**（新しいコードを生成）」を選択
4. **6桁の同期コード**が表示されます（例: `ABC123`）
5. このコードをメモまたはコピー

#### 2台目以降（スマホなど）

1. 同じURLを開く
2. **☁️ 同期OFF** ボタンをクリック
3. 「**キャンセル**（既存のコードを入力）」を選択
4. 1台目で生成した**6桁のコード**を入力
5. 自動的にデータが同期されます！

### 💡 同期コードの確認方法

- **同期ボタンを右クリック**（PC）
- **同期ボタンを長押し**（スマホ）
- ボタンに表示される文字列（例: `同期ON (ABC123)`）

### 📱 複数デバイスでの使用

すべてのデバイスで**同じ同期コード**を使用すれば、自動的にデータが同期されます。

- PC、スマホ、タブレットなど、何台でもOK
- 問題を追加・編集すると即座に全デバイスに反映
- インターネット接続があれば自動同期

### よくある質問

**Q: 同期コードを忘れてしまいました**  
A: すでに同期ONのデバイスで、同期ボタンを右クリック（または長押し）すると確認できます。

**Q: データはどこに保存されますか？**  
A: Google Firebase（Googleのクラウドサービス）に保存されます。

**Q: 他の人に見られませんか？**  
A: 同期コード（6桁）を知っている人だけがアクセスできます。コードを他人に教えなければ安全です。より詳しくは[Firestoreセキュリティガイド](FIRESTORE_SECURITY_GUIDE.md)を参照してください。

**Q: 同期コードを変更できますか？**  
A: はい。同期をOFFにしてから、再度ONにする際に新しいコードを生成または入力できます。

**Q: 本当に無料ですか？**  
A: はい、Firebaseの無料枠（1GB、50,000回/日の読み取り）で十分使えます。

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
