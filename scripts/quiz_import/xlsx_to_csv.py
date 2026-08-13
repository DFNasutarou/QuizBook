# -*- coding: utf-8 -*-
"""クイズ問題集の Excel を QuizBook の CSV 形式へ変換する。

    python scripts/quiz_import/xlsx_to_csv.py <xlsxファイル または ディレクトリ>

出力形式: 問題文,答え,メモ,ジャンル,難易度,タグ
出力先  : 入力と同じ階層の csv/ （例 xxx/xlsx/A.xlsx -> xxx/csv/A.csv）

どのシートのどの列が問題文・答えかは自動で見つける。
見出し行があれば列名から、無ければ「文字数がいちばん多い列＝問題文」として判断する。

  # 変換する（複数シートはシートごとにCSVを分ける）
  python xlsx_to_csv.py 問題集.xlsx

  # 何をどう認識したか確認する
  python xlsx_to_csv.py 問題集.xlsx --analyze

  # シートや列を明示する
  python xlsx_to_csv.py 問題集.xlsx --sheet 早押し --question B --answer C --memo D

  # ディレクトリ内をまとめて変換する
  python xlsx_to_csv.py xlsx/

標準ライブラリのみで動作する（openpyxl 不要）。
Excel の「ふりがな」(rPh) は自動生成のカタカナが全漢字に付くため使わない。
"""
import argparse
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import section_kind, write_collections, MAX_PER_COLLECTION

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
NS_R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
NS_PR = '{http://schemas.openxmlformats.org/package/2006/relationships}'

DEFAULT_GENRE = 'ノンジャンル'
DEFAULT_DIFFICULTY = 5   # QuizBook の難易度は 1〜10

# 見出し行の列名
Q_WORDS = ('問題文', '問題', '問い', '問')
A_WORDS = ('答え', '解答', '答', '正解')
M_WORDS = ('別解', '備考', '解説', '判定', 'メモ', '注')
D_WORDS = ('難易度', 'レベル')


# ---------------------------------------------------------------- xlsx 読み取り
def read_shared_strings(z):
    """共有文字列を読む。rPh（ふりがな）は本文ではないので除外する。"""
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    result = []
    for si in root.findall(NS + 'si'):
        runs = [t.text or '' for r in si.findall(NS + 'r') for t in r.findall(NS + 't')]
        result.append(''.join(runs) if runs
                      else ''.join(t.text or '' for t in si.findall(NS + 't')))
    return result


def sheet_paths(z):
    """シート名 -> シートXMLのパス（並び順を保つ）"""
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    target = {r.get('Id'): r.get('Target') for r in rels.findall(NS_PR + 'Relationship')}

    mapping = {}
    for sheet in wb.iter(NS + 'sheet'):
        path = (target.get(sheet.get(NS_R + 'id'), '') or '').lstrip('/')
        if not path.startswith('xl/'):
            path = 'xl/' + path
        mapping[sheet.get('name')] = path
    return mapping


def column_of(ref):
    m = re.match(r'([A-Z]+)', ref or '')
    return m.group(1) if m else ''


def read_rows(z, path, shared):
    """行ごとに {列記号: 値} を返す"""
    ws = ET.fromstring(z.read(path))
    for row in ws.iter(NS + 'row'):
        cells = {}
        for c in row.findall(NS + 'c'):
            kind = c.get('t')
            if kind == 'inlineStr':
                el = c.find(NS + 'is')
                value = ''.join(t.text or '' for t in el.iter(NS + 't')) if el is not None else ''
            else:
                v = c.find(NS + 'v')
                if v is None:
                    continue
                value = shared[int(v.text)] if kind == 's' else (v.text or '')
            if value:
                cells[column_of(c.get('r'))] = value
        if cells:
            yield cells


# ---------------------------------------------------------------- 列の自動判定
def detect_columns(rows):
    """どの列が問題文・答え・メモ・難易度かを見つける"""
    if not rows:
        return None

    head = rows[0]
    found = {}
    # 見出し行がある場合は列名から決める
    for col, text in head.items():
        t = str(text)
        if 'q' not in found and any(w in t for w in Q_WORDS):
            found['q'] = col
        elif 'a' not in found and any(w in t for w in A_WORDS):
            found['a'] = col
        elif 'memo' not in found and any(w in t for w in M_WORDS):
            found['memo'] = col
        elif 'diff' not in found and any(w in t for w in D_WORDS):
            found['diff'] = col
    if 'q' in found and 'a' in found:
        found['header_rows'] = 1
        return found

    # 見出しが無い場合は、文字数がいちばん多い列を問題文とみなす
    body = rows[:200]
    length, filled = {}, {}
    for r in body:
        for col, val in r.items():
            length[col] = length.get(col, 0) + len(str(val))
            filled[col] = filled.get(col, 0) + 1
    if not length:
        return None
    solid = [c for c in length if filled[c] >= len(body) * 0.5] or list(length)
    q = max(solid, key=lambda c: length[c])
    right = sorted(c for c in solid if len(c) > len(q) or (len(c) == len(q) and c > q))
    if not right:
        return None
    found = {'q': q, 'a': right[0], 'header_rows': 0}
    if len(right) > 1:
        found['memo'] = right[1]
    return found


def looks_like_quiz(rows, cols):
    """そのシートが問題集かどうか（説明用シートなどを除く）"""
    if not cols or len(rows) < 5:
        return False
    body = rows[cols['header_rows']:]
    pairs = sum(1 for r in body if r.get(cols['q']) and r.get(cols['a']))
    return pairs >= max(3, len(body) * 0.5)


# ---------------------------------------------------------------- 整形
def clean_text(text):
    if not text:
        return ''
    # 「/」は読み上げ到達点のマーカーなので除去する
    text = str(text).replace('／', '').replace('/', '').replace('⁄', '')
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    text = re.sub(r'[ \t　]*\n[ \t　]*', ' ', text)
    return re.sub(r'[ \t　]{2,}', ' ', text).strip()


def map_difficulty(raw, diff_max):
    """出典の難易度（1〜diff_max）を QuizBook の 1〜10 へ写す"""
    try:
        level = int(float(raw))
    except (TypeError, ValueError):
        return DEFAULT_DIFFICULTY
    if not diff_max or diff_max < 1:
        return DEFAULT_DIFFICULTY
    return max(1, min(10, round(max(1, min(diff_max, level)) * 10 / diff_max)))


def convert_sheet(rows, cols, tag, section):
    diff_col = cols.get('diff')
    diff_max = 0
    if diff_col:
        for r in rows[cols['header_rows']:]:
            try:
                diff_max = max(diff_max, int(float(r.get(diff_col, 0))))
            except (TypeError, ValueError):
                pass

    out, skipped = [], 0
    for r in rows[cols['header_rows']:]:
        q = clean_text(r.get(cols['q'], ''))
        a = clean_text(r.get(cols['a'], ''))
        if not q or not a:
            skipped += 1
            continue
        memo = clean_text(r.get(cols['memo'], '')) if cols.get('memo') else ''
        diff = map_difficulty(r.get(diff_col), diff_max) if diff_col else DEFAULT_DIFFICULTY
        out.append([q, a, memo, DEFAULT_GENRE, diff,
                    f'{tag}, {section}' if section else tag])
    return out, skipped


def convert(path, args):
    z = zipfile.ZipFile(path)
    shared = read_shared_strings(z)
    sheets = sheet_paths(z)
    if args.sheet:
        sheets = {k: v for k, v in sheets.items() if k == args.sheet}
        if not sheets:
            print(f'✗ {path.name}: シートが見つかりません: {args.sheet}')
            return 0

    tag = args.tag or path.stem
    out_dir = Path(args.outdir) if args.outdir else path.parent.parent / 'csv'
    total = 0

    for name, sheet_path in sheets.items():
        rows = list(read_rows(z, sheet_path, shared))
        cols = detect_columns(rows)
        if args.question:
            cols = dict(cols or {}, q=args.question, a=args.answer or 'C',
                        header_rows=args.header_rows)
            if args.memo:
                cols['memo'] = args.memo
        if not looks_like_quiz(rows, cols):
            if args.analyze:
                print(f'  シート[{name}] … 問題集ではなさそうなので飛ばす（{len(rows)}行）')
            continue

        section = section_kind(name) or ''
        records, skipped = convert_sheet(rows, cols, tag, section)

        if args.analyze:
            print(f'  シート[{name}] {len(records)}問  列: '
                  f"問題={cols['q']} 答え={cols['a']}"
                  f"{' メモ=' + cols['memo'] if cols.get('memo') else ''}"
                  f"{' 難易度=' + cols['diff'] if cols.get('diff') else ''}"
                  f"{' 見出し行あり' if cols['header_rows'] else ''}"
                  f"{' / 区分:' + section if section else ''}")
            for r in records[:2]:
                print(f'      問題: {r[0][:70]}\n      答え: {r[1][:40]}')
            total += len(records)
            continue

        base = args.out or path.stem
        if len(sheets) > 1:
            base = f'{base}_{re.sub(r"[\\\\/:*?<>|]", "", name)[:24]}'
        for fname, n in write_collections({section or 'all': records}, out_dir, base, args.limit):
            print(f'✓ {fname:<44}{n:>5}問')
        total += len(records)
    return total


def main():
    p = argparse.ArgumentParser(description='クイズ問題集の Excel を QuizBook の CSV へ変換する')
    p.add_argument('input', help='xlsxファイル、またはxlsxの入ったディレクトリ')
    p.add_argument('--analyze', action='store_true', help='認識結果だけ表示（CSVは書かない）')
    p.add_argument('-o', '--out', help='出力ファイル名の基準（既定: 入力ファイル名）')
    p.add_argument('--outdir', help='出力先ディレクトリ（既定: 入力の隣の csv/）')
    p.add_argument('--tag', help='CSVのタグ欄に入れる文字列（既定: 入力ファイル名）')
    p.add_argument('--sheet', help='このシートだけ変換する')
    p.add_argument('--limit', type=int, default=MAX_PER_COLLECTION,
                   help=f'1ファイルあたりの問数（既定 {MAX_PER_COLLECTION}）')

    g = p.add_argument_group('列の上書き（既定は自動判定）')
    g.add_argument('--question', help='問題文の列（例 B）')
    g.add_argument('--answer', help='答えの列（例 C）')
    g.add_argument('--memo', help='メモの列（例 D）')
    g.add_argument('--header-rows', type=int, default=1, help='読み飛ばす見出し行数')

    args = p.parse_args()
    target = Path(args.input)
    if not target.exists():
        sys.exit(f'見つかりません: {target}')

    files = sorted(target.glob('*.xlsx')) if target.is_dir() else [target]
    files = [f for f in files if not f.name.startswith('~$')]
    if not files:
        sys.exit(f'xlsxがありません: {target}')

    total = 0
    for f in files:
        if args.analyze:
            print(f'\n=== {f.name} ===')
        total += convert(f, args)
    if not args.analyze:
        print(f'\n合計 {total} 問  ※1ファイルあたり最大 {args.limit} 問で分割')


if __name__ == '__main__':
    sys.exit(main())
