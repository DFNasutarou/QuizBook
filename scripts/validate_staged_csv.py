#!/usr/bin/env python3
import csv
import io
import pathlib
import re
import subprocess
import sys


EXPECTED_HEADER = ["問題文", "答え", "メモ", "ジャンル", "難易度", "タグ"]
DIFFICULTY_PATTERN = re.compile(r"^(?:10|[1-9]|易|中|難)$")


def get_staged_csv_files():
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        check=True,
        capture_output=True,
        text=True,
    )
    files = []
    for line in result.stdout.splitlines():
        p = line.strip().replace("\\", "/")
        if not p:
            continue
        if not p.startswith("data/csv/"):
            continue
        if not p.lower().endswith(".csv"):
            continue
        if "/_backup/" in p:
            continue
        files.append(p)
    return files


def read_staged_text(path):
    show = subprocess.run(
        ["git", "show", f":{path}"],
        check=True,
        capture_output=True,
    )
    return show.stdout.decode("utf-8-sig")


def validate_csv(path):
    errors = []
    text = read_staged_text(path)

    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        errors.append(f"{path}: CSVが空です")
        return errors

    header = [col.strip() for col in rows[0]]
    if header != EXPECTED_HEADER:
        errors.append(
            f"{path}: ヘッダー不一致。期待={','.join(EXPECTED_HEADER)} 実際={','.join(header)}"
        )

    for i, row in enumerate(rows[1:], start=2):
        if len(row) < 6:
            errors.append(f"{path}: {i}行目の列数が不足しています")
            continue

        difficulty = row[4].strip()
        if not DIFFICULTY_PATTERN.match(difficulty):
            errors.append(
                f"{path}: {i}行目の難易度が不正です（{difficulty}）。1-10 または 易/中/難 を使用してください"
            )

    return errors


def main():
    staged = get_staged_csv_files()
    if not staged:
        return 0

    all_errors = []
    for p in staged:
        file_path = pathlib.Path(p)
        if not file_path.exists():
            # 削除やリネーム途中など。staged内容のみ検査するので存在しなくても継続。
            pass
        all_errors.extend(validate_csv(p))

    if all_errors:
        print("[pre-commit] CSV検証でエラーを検出しました:")
        for err in all_errors:
            print(f"- {err}")
        return 1

    print("[pre-commit] CSV検証を通過しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
