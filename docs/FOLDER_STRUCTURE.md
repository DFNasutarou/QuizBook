# フォルダ構成

```
02_output/
├── src/                          # ソースコード
│   └── quiz_manager.py          # メインアプリケーション
│
├── scripts/                     # 実行スクリプト
│   ├── build_exe.bat           # Windows用EXE化スクリプト
│   ├── build_exe.sh            # Linux/Mac用実行ファイル化スクリプト
│   └── format_existing_data.py # データ整形スクリプト
│
├── data/                       # データファイル
│   ├── original/               # 元のCSVファイル
│   │   ├── ベタ問の森_utf8.csv
│   │   └── 自作問題_utf8.csv
│   │
│   ├── formatted/              # 整形済みデータ
│   │   ├── quiz_collections_formatted.json  # 統合問題集
│   │   ├── ベタ問の森_整形済み.json
│   │   └── 自作問題_整形済み.json
│   │
│   └── samples/                # サンプルファイル
│       └── sample_quiz_format.csv  # CSVフォーマット例
│
└── docs/                       # ドキュメント
    ├── README.md               # 使用方法詳細
    └── FOLDER_STRUCTURE.md     # このファイル
```

## 各フォルダの説明

### src/
メインのソースコードが格納されています。
- `quiz_manager.py`: クイズ管理ツールのメインアプリケーション

### scripts/
各種スクリプトが格納されています。
- `build_exe.bat`: Windows環境でEXEファイルを作成するスクリプト
- `build_exe.sh`: Linux/Mac環境で実行ファイルを作成するスクリプト
- `format_existing_data.py`: 既存のCSVデータを整形するスクリプト

### data/
データファイルが種類別に整理されています。

#### data/original/
元の生データ（文字化け修正済み）
- UTF-8エンコーディングに変換済み
- タブ区切り形式

#### data/formatted/
整形済みデータ
- JSON形式
- タグ・難易度・ジャンル情報付加済み
- アプリケーションで直接利用可能

#### data/samples/
サンプル・テンプレートファイル
- CSVインポート時のフォーマット例

### docs/
ドキュメント類
- 使用方法、インストール方法などの詳細説明

## 使用方法

### 開発・テスト実行
```bash
cd src
python3 quiz_manager.py
```

### データ整形（既存CSVファイルがある場合）
```bash
cd scripts
python3 format_existing_data.py
```

### 実行ファイル作成
```bash
cd scripts
# Windows
build_exe.bat

# Linux/Mac
./build_exe.sh
```

このフォルダ構成により、ソースコード、データ、スクリプト、ドキュメントが適切に分離され、管理しやすくなっています。