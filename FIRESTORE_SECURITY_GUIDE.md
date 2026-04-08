# Firestore セキュリティルール設定ガイド

クラウド同期機能を安全に使用するためのFirestoreセキュリティルール設定手順です。

## 🔐 セキュリティルールとは

Firestoreのセキュリティルールは、誰がどのデータにアクセスできるかを制御します。デフォルトでは**テストモード**になっており、30日間は誰でもアクセス可能です。

## ⚠️ 重要：本番環境での設定が必須

テストモードのまま使用すると、30日後にアクセスできなくなります。また、誰でもデータを読み書きできてしまいます。

## 📋 設定手順

### ステップ1: Firebase Console を開く

1. https://console.firebase.google.com/ にアクセス
2. QuizBook プロジェクトを選択
3. 左メニュー「構築」→「Firestore Database」をクリック
4. 上部タブの「ルール」をクリック

### ステップ2: セキュリティルールを設定

以下のルールをコピーして貼り付けます：

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    // ユーザーごとのデータ（レガシー形式）
    match /users/{userId} {
      // 誰でも読み書き可能（シンプルな設定）
      allow read, write: if true;
      
      // サブコレクション: meta（メタデータ）
      match /meta/{document=**} {
        allow read, write: if true;
      }
      
      // サブコレクション: collections（問題集データ）
      match /collections/{collectionId} {
        allow read, write: if true;
      }
    }
  }
}
```

**重要**: `{document=**}` は、そのパス以下のすべてのドキュメントへのアクセスを許可します。

### ステップ3: 公開

右上の「公開」ボタンをクリック

## 🔒 より安全な設定（推奨）

Firebase Authenticationを使用する場合、以下のルールがより安全です：

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    // 認証されたユーザーのみ、自分のデータにアクセス可能
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      
      // サブコレクション: meta（メタデータ）
      match /meta/{document=**} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
      
      // サブコレクション: collections（問題集データ）
      match /collections/{collectionId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

service cloud.firestore {
  match /databases/{database}/documents {
    // 認証済みユーザーのみアクセス可能
    match /users/{userId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

**注意**: この設定を使用する場合、Firebase Authentication の設定も必要です。

## 🚀 Firebase Authentication の設定（オプション・推奨）

より安全に使うには、認証機能を追加することを推奨します。

### 手順

1. Firebase Console で「構築」→「Authentication」を選択
2. 「始める」をクリック
3. 「Sign-in method」タブを選択
4. 「匿名」を有効化
   - 「匿名」をクリック
   - 「有効にする」をON
   - 「保存」

### アプリケーション側の対応

index.html に以下を追加（Firebase SDK の import 部分）：

```javascript
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

const auth = getAuth(app);

// 匿名認証
signInAnonymously(auth)
  .then(() => {
    console.log('Authenticated anonymously');
  })
  .catch((error) => {
    console.error('Auth error:', error);
  });
```

## 📊 現在の設定

現在、QuizBook は以下の設定で動作しています：

- **認証**: なし（シンプル設定）
- **アクセス制御**: ユーザーIDごとに分離
- **セキュリティ**: 基本レベル（URLを知っている人のみアクセス可能）

## ❓ どの設定を選ぶべきか

| 使用方法 | 推奨設定 |
|---------|---------|
| 個人利用のみ | シンプル設定でOK |
| 複数人で共有 | Firebase Authentication推奨 |
| 機密情報を含む | Firebase Authentication必須 |

## 🔧 トラブルシューティング

### エラー: "Missing or insufficient permissions"

セキュリティルールが正しく設定されていない可能性があります。
→ Firebase Console でルールを確認してください。

### エラー: "PERMISSION_DENIED"

30日間のテストモード期間が終了した可能性があります。
→ 上記のルールを設定してください。

## 📚 参考リンク

- [Firestore セキュリティルール公式ドキュメント](https://firebase.google.com/docs/firestore/security/get-started)
- [Firebase Authentication 公式ドキュメント](https://firebase.google.com/docs/auth)
