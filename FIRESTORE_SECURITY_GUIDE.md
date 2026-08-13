# Firestore セキュリティルール設定ガイド

クラウド同期機能を安全に使用するためのFirestoreセキュリティルール設定手順です。

## ⚠️ 以前のルールを使っている場合は今すぐ更新してください

このガイドは以前、次のルールを案内していました。

```javascript
match /users/{userId} {
  allow read, write: if true;   // ← 危険
}
```

Firestore の `read` は「1件取得（get）」だけでなく **「コレクション列挙（list）」も含みます**。
そのため上記の設定では、**誰でも `users` コレクションを丸ごと列挙して、全ユーザーの同期コードと問題集データを取得・改ざん・削除できる**状態でした。6桁の同期コードは障壁として機能していません（総当りすら不要で、一覧が取れてしまうため）。

以前のルールを公開したままの場合は、下記の手順で更新してください。

---

## 📋 設定手順

### ステップ1: 匿名認証を有効化する（先に実施）

新しいルールは `request.auth != null` を要求します。**ルールより先に**認証を有効化してください。順序を逆にすると、既存の利用者が `permission-denied` になります。

1. [Firebase Console](https://console.firebase.google.com/) で QuizBook プロジェクトを開く
2. 左メニュー「構築」→「Authentication」→「始める」
3. 「Sign-in method」タブ →「匿名」を選択
4. 「有効にする」を ON にして「保存」

アプリ側（`index.html`）は既に匿名サインインを行うようになっています。有効化されていない場合は警告をコンソールに出して認証なしで続行するため、この手順を飛ばしても旧ルールのままなら動作はします（ただし危険な状態のままです）。

### ステップ2: セキュリティルールを公開する

1. 左メニュー「構築」→「Firestore Database」→ 上部タブ「ルール」
2. リポジトリの [`firestore.rules`](firestore.rules) の内容を貼り付け
3. 右上の「公開」をクリック

要点は次の2つです。

```javascript
match /users/{userId} {
  allow get, create, update, delete: if request.auth != null;
  allow list: if false;          // ← users コレクションの列挙を禁止

  match /meta/{documentId}       { allow read, write: if request.auth != null; }
  match /collections/{collectionId} { allow read, write: if request.auth != null; }
}
```

- `allow list: if false` により、同期コードを知らない第三者はドキュメントを見つけられません
- サブコレクション（`meta` / `collections`）はパスに userId を含むため、列挙するには同期コードを知っている必要があります

### ステップ3: 動作確認

ブラウザの開発者ツール（F12）のコンソールで:

```javascript
await window.firebaseSync.diagnose()
```

`permission-denied` が出る場合は、ステップ1の匿名認証が有効になっているか確認してください。

---

## 🔐 このルールで守られる範囲

| 脅威 | 対策後 |
|---|---|
| 第三者による全データの列挙・ダンプ | ✅ 防げる（`list` 禁止） |
| 未認証クライアントからの直接アクセス | ✅ 防げる（`request.auth != null`） |
| 同期コードを知っている人による読み書き | ❌ 防げない（仕様上、コード＝アクセス権） |
| 同期コードの総当り（32⁶ ≒ 10.7億通り） | ⚠️ 理論上は可能。App Check の併用を推奨 |

**同期コードは共有パスワードと同じもの**として扱ってください。人に見せる画面でコードを表示しない、SNS等に貼らない、といった運用が必要です。

---

## 🔒 より厳密な設定（機密データを扱う場合）

同期コードではなく認証 uid でデータを分離する方式です。

```javascript
match /users/{userId} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
  match /{document=**} {
    allow read, write: if request.auth != null && request.auth.uid == userId;
  }
}
```

この方式に移行する場合は、アプリ側も `firebase-sync.js` の `syncCodeToUserId()` を uid ベースに変更する必要があります（同期コードによる複数デバイス共有の仕組みを、アカウント共有または招待方式に作り替えることになります）。

さらに [Firebase App Check](https://firebase.google.com/docs/app-check) を有効にすると、正規のアプリ以外からのアクセスを弾けるため、総当り対策として有効です。

---

## 🔧 トラブルシューティング

### エラー: "Missing or insufficient permissions" / "PERMISSION_DENIED"

1. **匿名認証が有効か** — Authentication → Sign-in method →「匿名」が有効になっているか
2. **ルールが公開済みか** — Firestore Database → ルール で `firestore.rules` の内容になっているか
3. **テストモードの期限切れ** — 初期状態の30日間テストモードが終了した可能性があります

アプリには旧形式（`users/{userId}` 直下に全データを置く形式）へのフォールバックが実装されているため、`permission-denied` が出ても一部は動作します。ただし本来の差分同期は効かなくなるので、根本原因を解消してください。

### 認証は通るのにデータが見えない

同期コードが別のものになっている可能性があります。同期ボタンを右クリック（スマホは長押し）して、デバイス間でコードが一致しているか確認してください。

---

## 📚 参考リンク

- [Firestore セキュリティルール公式ドキュメント](https://firebase.google.com/docs/firestore/security/get-started)
- [ルールでの list と get の違い](https://firebase.google.com/docs/firestore/security/rules-structure#granular_operations)
- [Firebase Authentication 公式ドキュメント](https://firebase.google.com/docs/auth)
- [Firebase App Check](https://firebase.google.com/docs/app-check)
