#!/usr/bin/env python3
"""
Quiz CSV batch tool

Purpose:
- Keep a source CSV with stable question IDs for safe additions.
- Append up to 20 questions per set (セット).
- Export app-import CSV (6 columns) from source CSV.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import shutil
import sys
from pathlib import Path
from typing import Dict, List

SOURCE_HEADERS = [
    "問題ID",
    "問題文",
    "答え",
    "メモ",
    "ジャンル",
    "難易度",
    "タグ",
    "状態",
    "更新日時",
]

BATCH_HEADERS = ["問題文", "答え", "メモ", "ジャンル", "難易度", "タグ"]
APP_HEADERS = ["問題文", "答え", "メモ", "ジャンル", "難易度", "タグ"]

ACTIVE_STATE = "active"
INACTIVE_STATE = "inactive"


def now_iso() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def read_rows(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader)


def write_rows(path: Path, headers: List[str], rows: List[Dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow({h: row.get(h, "") for h in headers})


def validate_headers(path: Path, expected: List[str]) -> None:
    if not path.exists():
        raise FileNotFoundError(f"ファイルが見つかりません: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
    if header is None:
        raise ValueError(f"ヘッダー行がありません: {path}")
    if [h.strip() for h in header] != expected:
        raise ValueError(
            "ヘッダー不一致: "
            f"期待={expected} / 実際={[h.strip() for h in header]}"
        )


def make_backup(path: Path) -> Path:
    ts = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = path.parent / "_backup"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}_{ts}{path.suffix}"
    shutil.copy2(path, backup_path)
    return backup_path


def ensure_source(path: Path) -> None:
    if not path.exists():
        write_rows(path, SOURCE_HEADERS, [])
        return
    validate_headers(path, SOURCE_HEADERS)


def next_id(existing: List[Dict[str, str]]) -> str:
    max_num = 0
    for row in existing:
        qid = (row.get("問題ID") or "").strip()
        if qid.startswith("Q"):
            num_part = qid[1:]
            if num_part.isdigit():
                max_num = max(max_num, int(num_part))
    return f"Q{max_num + 1:06d}"


def parse_batch_rows(batch_path: Path) -> List[Dict[str, str]]:
    validate_headers(batch_path, BATCH_HEADERS)
    rows = read_rows(batch_path)
    cleaned = []
    for row in rows:
        question = (row.get("問題文") or "").strip()
        answer = (row.get("答え") or "").strip()
        if not question or not answer:
            continue
        cleaned.append(
            {
                "問題文": row.get("問題文", ""),
                "答え": row.get("答え", ""),
                "メモ": row.get("メモ", ""),
                "ジャンル": row.get("ジャンル", "ノンジャンル") or "ノンジャンル",
                "難易度": row.get("難易度", "中") or "中",
                "タグ": row.get("タグ", ""),
            }
        )
    return cleaned


def cmd_init(args: argparse.Namespace) -> int:
    source = Path(args.source)
    if source.exists():
        validate_headers(source, SOURCE_HEADERS)
        print(f"既存sourceを確認しました: {source}")
        return 0

    write_rows(source, SOURCE_HEADERS, [])
    print(f"sourceを作成しました: {source}")
    return 0


def cmd_add(args: argparse.Namespace) -> int:
    source = Path(args.source)
    batch = Path(args.batch)

    ensure_source(source)
    batch_rows = parse_batch_rows(batch)

    if not batch_rows:
        print("追加対象がありません（問題文・答えが空の行は無視されます）")
        return 1

    if len(batch_rows) > args.max_questions:
        print(
            f"1セットの上限を超えています: {len(batch_rows)}問 > {args.max_questions}問"
        )
        return 1

    rows = read_rows(source)
    backup = make_backup(source)

    for item in batch_rows:
        qid = next_id(rows)
        rows.append(
            {
                "問題ID": qid,
                "問題文": item["問題文"],
                "答え": item["答え"],
                "メモ": item["メモ"],
                "ジャンル": item["ジャンル"],
                "難易度": item["難易度"],
                "タグ": item["タグ"],
                "状態": ACTIVE_STATE,
                "更新日時": now_iso(),
            }
        )

    write_rows(source, SOURCE_HEADERS, rows)
    print(f"{len(batch_rows)}問を追加しました: {source}")
    print(f"バックアップ: {backup}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    source = Path(args.source)
    out = Path(args.out)

    ensure_source(source)
    rows = read_rows(source)

    exported: List[Dict[str, str]] = []
    for row in rows:
        state = (row.get("状態") or ACTIVE_STATE).strip() or ACTIVE_STATE
        if args.only_active and state != ACTIVE_STATE:
            continue
        exported.append(
            {
                "問題文": row.get("問題文", ""),
                "答え": row.get("答え", ""),
                "メモ": row.get("メモ", ""),
                "ジャンル": row.get("ジャンル", "ノンジャンル") or "ノンジャンル",
                "難易度": row.get("難易度", "中") or "中",
                "タグ": row.get("タグ", ""),
            }
        )

    write_rows(out, APP_HEADERS, exported)
    print(f"{len(exported)}問を出力しました: {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Quiz CSV batch tool")
    sub = p.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="ID付きsource CSVを初期化")
    p_init.add_argument("--source", required=True, help="source CSV path")
    p_init.set_defaults(func=cmd_init)

    p_add = sub.add_parser("add", help="問題セット(最大20問)を追加")
    p_add.add_argument("--source", required=True, help="source CSV path")
    p_add.add_argument("--batch", required=True, help="追加する問題CSV path")
    p_add.add_argument("--max-questions", type=int, default=20, help="1セットの上限")
    p_add.set_defaults(func=cmd_add)

    p_export = sub.add_parser("export", help="source CSVからアプリ取込CSVへ出力")
    p_export.add_argument("--source", required=True, help="source CSV path")
    p_export.add_argument("--out", required=True, help="app import CSV path")
    p_export.add_argument(
        "--only-active",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="activeのみ出力するか",
    )
    p_export.set_defaults(func=cmd_export)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
