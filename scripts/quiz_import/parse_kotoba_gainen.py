# -*- coding: utf-8 -*-
"""ことば・概念オープン 記録集PDF (pdftotext -table出力) を QuizBook CSV に変換する。
CSVフォーマット: 問題文,答え,メモ,ジャンル,難易度,タグ
"""
import re, csv, sys

SRC = "pdf/_table_all.txt"
CREATORS = {"西村", "桑波田", "藤原", "吉川"}
GENRE = "ことば・概念"
DIFFICULTY = "中"

with open(SRC, encoding="utf-8") as f:
    lines = [l.rstrip("\n") for l in f]

def split_cols(line):
    return [c for c in re.split(r"[ 　]{2,}", line.strip()) if c != ""]

def is_qstart(line):
    s = line.strip()
    m = re.match(r"^(\d+)\s+(\S.*)$", s)
    if not m:
        return None
    # 先頭が番号 + 全角/日本語などの本文（点数行 "3×7=21" や名簿を除外）
    rest = m.group(2)
    if re.match(r"^[\d×=＝]+$", rest):
        return None
    return int(m.group(1)), rest

def clean_q(text):
    # スラッシュ（読み上げ到達点マーカー）を除去
    text = text.replace("/", "").replace("⁄", "")
    text = re.sub(r"[ 　]+", "", text)  # 日本語本文の余分な空白を詰める
    return text.strip()

# セクション境界を検出
section_markers = []
for i, l in enumerate(lines):
    s = l.strip()
    if s.startswith("1st Round"): section_markers.append((i, "paper", "ペーパー"))
    elif s.startswith("２nd Round") or s.startswith("2nd Round"): section_markers.append((i, "buzz", "2R"))
    elif s.startswith("３ｒd Round") or s.startswith("3rd Round") or s.startswith("３rd Round"): section_markers.append((i, "buzz", "3R"))
    elif s.startswith("Final"): section_markers.append((i, "buzz", "決勝"))
    elif s.startswith("未使用問題"): section_markers.append((i, "buzz", "未使用"))

# 各セクションの開始行を確定
bounds = []
for idx, (ln, kind, label) in enumerate(section_markers):
    end = section_markers[idx+1][0] if idx+1 < len(section_markers) else len(lines)
    bounds.append((ln, end, kind, label))

def is_skip(line):
    s = line.strip()
    if s == "": return True
    if s in ("A", "B"): return True
    if s.startswith("【Set"): return True
    if s.startswith("【問題】") or s.startswith("【解答】"): return True
    if s.startswith("No.") and "問題文" in s: return True
    if re.match(r"^[\d　\sｐｔpt×=＝\-－]+$", s): return True  # 点数のみの行
    return False

def is_roster(line):
    # 名簿行: 2+空白区切りで全フィールドが人名らしい（番号無し・本文無し）
    cols = split_cols(line)
    if len(cols) < 3: return False
    # 数字や「？」を含まず、各列が短い（名前）
    for c in cols:
        if "？" in c or "?" in c or "でしょう" in c or len(c) > 6:
            return False
        if re.search(r"\d", c):
            return False
    return True

quizzes = []  # dict: num, q, a, creator, judges, count, section

for start, end, kind, label in bounds:
    # paperは【解答】以降のみ対象
    region_start = start
    if kind == "paper":
        for i in range(start, end):
            if lines[i].strip().startswith("【解答】"):
                region_start = i+1
                break
    cur = None
    for i in range(region_start, end):
        line = lines[i]
        # ペーパーは【得点】（スコア表・少数正解表）の手前で打ち切る
        if kind == "paper" and line.strip().startswith(("【得点】", "【少数正解")):
            break
        qs = is_qstart(line)
        if qs is not None:
            if cur: quizzes.append(cur)
            num, rest = qs
            # 番号は除去済みのrestを列分割（番号と本文が1スペースでも安全）
            cols = split_cols(rest)
            qtext = cols[0] if len(cols) > 0 else ""
            answer = ""; creator = ""; count = ""
            tail = cols[1:]
            if kind == "paper":
                # [答え, 正解数, 作成者] の順（一部欠けることあり）
                if len(tail) >= 1: answer = tail[0]
                if len(tail) >= 2 and re.match(r"^\d+$", tail[1]): count = tail[1]
                if len(tail) >= 3: creator = tail[2]
                elif len(tail) == 2 and not re.match(r"^\d+$", tail[1]): creator = tail[1]
            else:
                # [答え, 作成者] 答えが【で始まることはない
                t = [x for x in tail if not x.startswith("【")]
                if len(t) >= 1: answer = t[0]
                if len(t) >= 2: creator = t[1]
            cur = dict(num=num, q=qtext, a=answer, creator=creator, count=count,
                       judges=[], section=label, kind=kind, qdone=qtext.rstrip().endswith(("？","?","。")))
            continue
        if cur is None:
            continue
        if is_skip(line):
            # 点数/Set境界などに当たったら現在の問題を確定して終了扱い
            if line.strip() == "" :
                continue
            quizzes.append(cur); cur = None
            continue
        if is_roster(line):
            quizzes.append(cur); cur = None
            continue
        # 継続行: 先頭列のみ問題文の続き、それ以降は答え列/作成者/判定
        cols = split_cols(line)
        for idx, c in enumerate(cols):
            if c.startswith("【"):
                cur["judges"].append(c)
            elif idx == 0 and not cur["qdone"]:
                cur["q"] += c
                if cur["q"].rstrip().endswith(("？", "?", "。")):
                    cur["qdone"] = True
            else:
                # 答えの折り返し / 作成者繰り返し / 点数ノイズ
                if c in CREATORS:
                    if not cur["creator"]: cur["creator"] = c
                elif re.match(r"^[\dｐｔpt×=＝\-－]+$", c):
                    pass
                elif len(c) <= 16 and cur["a"] and not re.search(r"でしょう|ですか", c):
                    cur["a"] += c
    if cur: quizzes.append(cur); cur = None

# 出力
print(f"総抽出数: {len(quizzes)}")
from collections import Counter
print("セクション別:", dict(Counter(q["section"] for q in quizzes)))

# 異常検出
print("\n--- 短い答え(<=1字) ---")
for q in quizzes:
    if len(q["a"].strip()) <= 1:
        print(q["section"], q["num"], repr(q["a"]), "|", q["q"][:30])
print("\n--- 答え空 ---")
for q in quizzes:
    if not q["a"].strip():
        print(q["section"], q["num"], "|", q["q"][:40])

# デバッグ全件ダンプ
with open("pdf/_debug.txt", "w", encoding="utf-8") as f:
    for q in quizzes:
        f.write(f"[{q['section']}#{q['num']}] 作={q['creator']} 数={q['count']} 判={'/'.join(q['judges'])}\n")
        f.write(f"  Q: {clean_q(q['q'])}\n")
        f.write(f"  A: {q['a']}\n")

# 作成者欠落チェック
miss = [q for q in quizzes if not q['creator'].strip()]
print(f"\n作成者欠落: {len(miss)}件", [(q['section'], q['num']) for q in miss][:20])

# ---- CSV出力 ----
import os
OUT = "pdf/out"
os.makedirs(OUT, exist_ok=True)
GENRE = "ノンジャンル"
THEME_TAG = "ことば・概念オープン"

def build_memo(q):
    parts = []
    if q["creator"].strip():
        parts.append(f"作成者:{q['creator'].strip()}")
    if q["kind"] == "paper" and q["count"].strip():
        parts.append(f"正解数:{q['count'].strip()}")
    if q["judges"]:
        parts.append("判定:" + "".join(q["judges"]))
    return " / ".join(parts)

def build_row(q):
    tags = f"{THEME_TAG}, {q['section']}"
    return [clean_q(q["q"]), q["a"].strip(), build_memo(q), GENRE, DIFFICULTY, tags]

HEADER = ["問題文", "答え", "メモ", "ジャンル", "難易度", "タグ"]

def write_csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(HEADER)
        for r in rows:
            w.writerow(r)

# セクション別ファイル
SEC_FILE = {"ペーパー": "ペーパー50問", "2R": "2R早押し", "3R": "3R早押し",
            "決勝": "決勝7by7", "未使用": "未使用問題"}
from collections import defaultdict
by_sec = defaultdict(list)
for q in quizzes:
    by_sec[q["section"]].append(q)

for sec, qs in by_sec.items():
    fname = f"{OUT}/ことば概念オープン_{SEC_FILE.get(sec, sec)}.csv"
    write_csv(fname, [build_row(q) for q in qs])
    print(f"書出: {fname} ({len(qs)}問)")

# 全問結合ファイル
write_csv(f"{OUT}/ことば概念オープン_全問.csv", [build_row(q) for q in quizzes])
print(f"書出: {OUT}/ことば概念オープン_全問.csv ({len(quizzes)}問)")
