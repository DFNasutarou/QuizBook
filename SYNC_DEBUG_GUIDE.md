# 🔧 クラウド同期デバッグガイド

メタデータ取得エラーが発生している場合のトラブルシューティングガイドです。

## 🔍 問題の診断

### ステップ1: 開発者ツールを開く

1. ブラウザで **F12キー** を押す
2. **Console** タブを選択

### ステップ2: 診断コマンドを実行

コンソールに以下を入力して **Enter** を押す：

```javascript
await window.firebaseSync.diagnose()
```

### ステップ3: 出力を確認

診断結果から問題を特定します。

## ❌ よくあるエラーと解決策

### 1. `permission-denied` エラー

**症状**:
```
❌ サマリー取得エラー: permission-denied
❌ 問題集コレクション取得エラー: permission-denied
```

**原因**: Firestoreセキュリティルールがサブコレクションへのアクセスを許可していない

**解決策**:

1. [Firebase Console](https://console.firebase.google.com/) を開く
2. プロジェクトを選択
3. **Firestore Database** → **ルール** タブ
4. 以下のルールに置き換える：

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if true;
      
      // サブコレクション: meta
      match /meta/{document=**} {
        allow read, write: if true;
      }
      
      // サブコレクション: collections
      match /collections/{collectionId} {
        allow read, write: if true;
      }
    }
  }
}
```

5. **公開** ボタンをクリック
6. ブラウザをリロード（Ctrl+R または F5）

詳細は [FIRESTORE_SECURITY_GUIDE.md](FIRESTORE_SECURITY_GUIDE.md) を参照。

---

### 2. タイムアウトエラー

**症状**:
```
⚠️ 同期起動時のメタデータ取得に失敗（ローカル継続）: Error: 問題集一覧の取得がタイムアウトしました
```

**原因**: ネットワーク遅延またはFirestoreへの接続問題

**解決策**:

1. **インターネット接続を確認**
2. **Firebaseの状態を確認**: [Firebase Status Dashboard](https://status.firebase.google.com/)
3. **再読み込み**: ブラウザをリロード（Ctrl+R または F5）
4. **時間をおいて再試行**

---

### 3. ドキュメントが存在しない

**症状**: 診断結果で「ドキュメントは存在しません」と表示される

**原因**: データがまだクラウドに保存されていない

**解決策**:

1. アプリで **問題集を編集** または **新規作成**
2. 自動保存を待つ（約15秒）
3. または **手動で同期ボタンをクリック**
4. 再度診断コマンドを実行

---

### 4. WebChannel Listen エラー (404)

**症状**:
```
GET https://firestore.googleapis.com/.../Listen/channel?... 404 (Not Found)
WebChannelConnection RPC 'Listen' stream ... transport errored
```

**原因**: Firestoreのリアルタイム同期がセキュリティルールで拒否されている

**解決策**:

**解決策1** と同じ（セキュリティルールを修正）

---

## ✅ 正常な診断結果の例

```
🔍 ========== Firestore診断開始 ==========
ユーザーID: sync_ABC123
同期コード: ABC123
同期有効: true

📋 1. レガシーデータ (users/{userId}) の確認...
ℹ️ レガシードキュメントは存在しません

📋 2. サマリー (users/{userId}/meta/summary) の確認...
✅ サマリードキュメントが存在します
   - schemaVersion: 2
   - totalCollections: 18
   - totalQuizzes: 1178
   - collections: 18
   - updatedAt: 2026-04-08T10:00:00.000Z

📋 3. フォルダ設定 (users/{userId}/meta/folders) の確認...
✅ フォルダドキュメントが存在します
   - folders: 1
   - updatedAt: 2026-04-08T10:00:00.000Z

📋 4. 問題集コレクション (users/{userId}/collections) の確認...
✅ 問題集ドキュメント数: 18
   1. col_001
      - name: ベタ問の森
      - quizzes: 100問
      - folder: 未分類
   ... (以下略)

🔍 ========== 診断完了 ==========
```

---

## 🆘 それでも解決しない場合

1. **ブラウザのキャッシュをクリア**
2. **シークレットモードで試す**
3. **別のブラウザで試す**
4. **Firebase Console でデータを直接確認**:
   - Firestore Database → データ タブ
   - `users/{あなたのユーザーID}` を確認

---

## 💡 デバッグログの見方

コンソールに表示される `🔍 [DEBUG]` ログで、保存・取得の詳細を確認できます：

- `🔍 [DEBUG] サマリー保存を試行` → 保存開始
- `🔍 [DEBUG] サマリー保存成功` → 保存完了
- `🔍 [DEBUG] サマリー取得を試行` → 取得開始
- `🔍 [DEBUG] サマリー取得成功` → 取得完了

エラーが出ている場所とエラーコードを確認してください。

---

## 📚 関連ドキュメント

- [FIRESTORE_SECURITY_GUIDE.md](FIRESTORE_SECURITY_GUIDE.md) - セキュリティルール設定の詳細
- [README.md](README.md) - クラウド同期の基本的な使い方
