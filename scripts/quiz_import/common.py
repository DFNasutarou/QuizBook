# -*- coding: utf-8 -*-
"""変換スクリプト共通の処理。"""
import csv
import re

# QuizBook の1問題集あたりの上限（app.js の limits.maxQuizzesPerCollection と揃える）
MAX_PER_COLLECTION = 500

CSV_HEADER = ['問題文', '答え', 'メモ', 'ジャンル', '難易度', 'タグ']

# 見出しから形式を判定する
PAPER_RE = re.compile(r'ペーパー|筆記|予選\s*ペーパー')
BUZZER_RE = re.compile(r'早押し|通過|[0-9０-９]+\s*[RＲ]|セット|○[×✕]|コース')


def section_kind(heading):
    """見出しの文字列から「ペーパー」か「早押し」かを判定する"""
    if not heading:
        return None
    if PAPER_RE.search(heading):
        return 'ペーパー'
    if BUZZER_RE.search(heading):
        return '早押し'
    return None


def dedupe(rows_by_section):
    """同じ問題文が複数回出てきたら最初の1件だけ残す。

    記録集は同じ問題を「一覧」と「各ラウンドの詳細」に重ねて載せることが多く、
    そのまま取り込むと出題時に同じ問題が何度も出てしまう。
    """
    seen = set()
    result = {}
    removed = 0
    for name, rows in rows_by_section.items():
        kept = []
        for r in rows:
            key = re.sub(r'\s+', '', r[0])
            if key in seen:
                removed += 1
                continue
            seen.add(key)
            kept.append(r)
        result[name] = kept
    return result, removed


def safe_name(name):
    """フォルダ名・ファイル名に使えない文字を落とす"""
    return re.sub(r'[\\/:*?"<>|]', '', name).strip() or 'quiz'


def write_collections(rows_by_section, out_dir, base_name, limit=MAX_PER_COLLECTION,
                      folder_name=None):
    """形式ごとに分け、さらに上限問数で分割してCSVを書き出す。

    元ファイル1つにつき1つのフォルダを作り、その中へ入れる。
    ツール側で「フォルダごと読み込み」したときに、元の問題集の単位で
    まとまって取り込めるようにするため。

    戻り値: [(フォルダからの相対パス, 問数), ...]
    """
    out_dir = out_dir / safe_name(folder_name or base_name)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []

    # 中身のある区分だけを対象にする
    sections = [(name, rows) for name, rows in rows_by_section.items() if rows]
    single_section = len(sections) == 1

    for name, rows in sections:
        stem = safe_name(base_name if single_section else f'{base_name}_{name}')
        chunks = [rows[i:i + limit] for i in range(0, len(rows), limit)] or [[]]
        for idx, chunk in enumerate(chunks, 1):
            suffix = '' if len(chunks) == 1 else f'_{idx}'
            path = out_dir / f'{stem}{suffix}.csv'
            try:
                f = open(path, 'w', encoding='utf-8-sig', newline='')
            except PermissionError:
                raise SystemExit(
                    f'書き込めません: {path}\n'
                    'このファイルを Excel などで開いていないか確認してください。'
                )
            with f:
                w = csv.writer(f, quoting=csv.QUOTE_ALL)
                w.writerow(CSV_HEADER)
                w.writerows(chunk)
            written.append((f'{out_dir.name}/{path.name}', len(chunk)))
    return written
