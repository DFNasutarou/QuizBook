# -*- coding: utf-8 -*-
"""クイズ問題集のPDFを QuizBook の CSV 形式へ変換する。

    python scripts/quiz_import/pdf_to_csv.py <PDFファイル または ディレクトリ>

出力形式: 問題文,答え,メモ,ジャンル,難易度,タグ
出力先  : 入力と同じ階層の csv/ （例 xxx/pdf/A.pdf -> xxx/csv/A.csv）

レイアウト（列の境界・問題番号の位置・ルビの有無）は自動で見つける。
うまくいかないときだけオプションで上書きする。

  # 変換する
  python pdf_to_csv.py 問題集.pdf

  # 何をどう認識したか確認する（CSVは書かない）
  python pdf_to_csv.py 問題集.pdf --analyze

  # 自動検出を上書きする
  python pdf_to_csv.py 問題集.pdf --x-split 468 --anchor above

  # 成績表など問題以外のページが混じる記録集を整理して取り込む
  python pdf_to_csv.py 記録集.pdf --require-answer-column --require-question-end

  # ディレクトリ内のPDFをまとめて変換する
  python pdf_to_csv.py pdf/

前提: PyMuPDF (pip install pymupdf)
      テキストが埋め込まれたPDFのみ。画像だけのスキャンPDFは変換できない。
"""
import argparse
import re
import unicodedata
import sys
from collections import Counter
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit('PyMuPDF が必要です:  pip install pymupdf')

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import section_kind, write_collections, dedupe, MAX_PER_COLLECTION

DEFAULT_GENRE = 'ノンジャンル'
DEFAULT_DIFFICULTY = 5

NUM_ONLY = re.compile(r'^\s*(\d{1,4})\s*[\.．、]?\s*$')
NUM_HEAD = re.compile(r'^\s*([0-9０-９]{1,4})\s*(?:[\.．、]\s*|\s+)(.*)$', re.S)
ZEN2HAN = str.maketrans('０１２３４５６７８９', '0123456789')

# 同じ行とみなすY座標の幅（pt）。PDFでは同一行でも左右で数値がわずかにずれる
LINE_TOLERANCE = 3

# 問題文らしい終わり方。レイアウト判定の採点にも使う
QUESTION_END_RE = re.compile(
    r'(?:[？?]|でしょう[かうっ]?|ですか|は何|は誰|はどこ|という|どれ|まで|'
    r'答えなさい|お答えください)[\s。]*$'
)
# 答えの末尾に付く判定や注記（記録集でよくある）
JUDGE_TAIL_RE = re.compile(r'[\[【][^\[\]【】]{0,40}[\]】]\s*$')

# 答えが助詞や拗音で始まる = 問題文の末尾が答え側へこぼれた形
BLEED_RE = re.compile(r'^[ょゃゅっーぁぃぅぇぉをにはがのでともへや、。」』）]')

# 表のヘッダや章見出しが1問目に混ざるのを取り除く
HEADING_RE = re.compile(
    r'^(?:目次|はじめに|問題文|答え?|解答|別解|備考|解説|'
    r'読み上げ問題\d*問?|早押しクイズ(?:（\d+問）)?|第\d+セット|[●○■]\s*\d*[RＲ][^。]{0,20})+'
)


def to_int(text):
    try:
        return int(text.translate(ZEN2HAN))
    except ValueError:
        return 0


# ------------------------------------------------------------------ 文字の取り出し
def page_items(page):
    """文字片を、文字単位の座標つきで取り出す"""
    items = []
    for block in page.get_text('rawdict')['blocks']:
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                chars = [c for c in span.get('chars', []) if c['c'].strip()]
                if not chars:
                    continue
                items.append({
                    'x0': span['bbox'][0], 'x1': span['bbox'][2],
                    'y0': span['bbox'][1], 'y1': span['bbox'][3],
                    'size': round(span['size'], 1),
                    'text': ''.join(c['c'] for c in chars),
                    'chars': chars,
                })
    return items


def body_size(items):
    counts = Counter()
    for it in items:
        counts[it['size']] += len(it['text'])
    return counts.most_common(1)[0][0] if counts else 0


def sample_pages(doc, count=12):
    """文書全体からまんべんなくページを選ぶ（検出と採点用）"""
    n = doc.page_count
    if n <= count:
        return list(range(n))
    step = n / count
    # 表紙・目次を避けて中盤以降を厚めに見る
    return sorted({min(n - 1, int(step * i) + n // 12) for i in range(count)})


# ------------------------------------------------------------------ レイアウトの自動検出
def detect_layout(doc):
    """PDFを覗いて、列の境界・番号の位置・ルビの有無を見つける"""
    pages = sample_pages(doc)
    width = doc[0].rect.width

    all_items, sizes = [], Counter()
    for pi in pages:
        items = page_items(doc[pi])
        all_items.append(items)
        for it in items:
            sizes[it['size']] += len(it['text'])
    if not sizes:
        return None

    body = sizes.most_common(1)[0][0]
    flat = [it for items in all_items for it in items]
    big = [it for it in flat if it['size'] >= body * 0.8]
    small = [it for it in flat if it['size'] < body * 0.8]

    layout = {'body_size': body, 'page_width': width}

    # --- 列の境界を探す ---
    #     列の境界とは「多くの行で文字が無く、かつその右にはまだ内容がある」位置。
    #     列の開始位置が揃っているとは限らない（答えが中央寄せの作りもある）ので、
    #     開始位置ではなく“縦に空いている帯”を手掛かりにする。
    by_line = {}
    for it in big:
        by_line.setdefault(round((it['y0'] + it['y1']) / 2 / LINE_TOLERANCE), []).append(it)
    lines = [sorted(v, key=lambda it: it['x0']) for v in by_line.values()]

    def boundary_score(x):
        empty = right = 0
        for items in lines:
            if any(it['x0'] - 1 <= x <= it['x1'] + 1 for it in items):
                continue                       # その行はここに文字がある
            empty += 1
            if any(it['x0'] > x for it in items):
                right += 1                     # 右にまだ内容がある
        if not lines:
            return 0, 0
        return (empty / len(lines)) * (right / len(lines)), right

    step = 2
    candidates = []
    for x in range(int(width * 0.25), int(width * 0.95), step):
        s, right = boundary_score(x)
        if right >= max(4, len(lines) * 0.15):
            candidates.append((s, x))

    layout['answer_x0'] = None
    if candidates:
        best = max(candidates)[0]
        # 帯が複数あるとき（答えの右にさらに備考の列がある等）は、
        # いちばん左の帯が問題文と答えの境界にあたる
        good = sorted(x for s, x in candidates if s >= best * 0.75)
        first = good[0]
        band = [x for x in good if x <= first + 20]     # 同じ帯の中の位置をまとめる
        layout['x_split'] = round(sum(band) / len(band))
        # 答えの列の左端（境界のすぐ右で文字が始まる位置）
        after = [it['x0'] for it in big if it['x0'] > layout['x_split']]
        if after:
            layout['answer_x0'] = round(min(after))
        # さらに右に別の帯があれば、そこから先は備考とみなす
        far = [x for s, x in candidates if x >= layout['x_split'] + 50 and s >= best * 0.5]
        if far:
            layout['memo_x'] = min(far)
    else:
        layout['x_split'] = round(width * 0.62)

    # --- 問題文の列の左端（幅のある片が繰り返し始まる位置）---
    wide = Counter(round(it['x0']) for it in big
                   if it['x1'] - it['x0'] > 50 and it['x0'] < layout['x_split'])
    q_left = wide.most_common(1)[0][0] if wide else 0
    layout['q_left'] = q_left

    # --- 問題番号の列 ---
    #     数字だけの短い片が、決まった位置に繰り返し現れる場所を探す。
    #     番号は問題文より左にあるとは限らず、右へ字下げされている作りもある。
    #     桁数で左端がずれるので、揃いやすい右端（x1）でまとめる。
    nums = [it for it in big
            if NUM_ONLY.match(it['text'])
            and it['x1'] < layout['x_split'] and it['x1'] - it['x0'] < 30]
    layout['num_min'], layout['num_max'] = 0, 0
    if nums:
        edges = Counter(round(it['x1']) for it in nums)
        edge, cnt = edges.most_common(1)[0]
        group = [it for it in nums if abs(it['x1'] - edge) <= 5]
        if len(group) >= max(3, len(pages)):
            layout['num_min'] = max(0, round(min(it['x0'] for it in group) - 3))
            layout['num_max'] = round(max(it['x1'] for it in group) + 3)

    # --- ぶら下げインデント（1行目だけ左へ飛び出す形）---
    #     続きの行が最も多く現れる開始位置を基準に、それより左から始まる行を探す
    left = Counter(round(it['x0']) for it in big if it['x0'] < layout['x_split'])
    if left:
        main, main_n = left.most_common(1)[0]
        outer = [(x, n) for x, n in left.items() if x < main - 3]
        if outer:
            first, first_n = max(outer, key=lambda t: t[1])
            if first_n >= main_n * 0.1 and main - first <= 40:
                layout['q_indent'] = round((first + main) / 2)

    # --- ルビか、右側の補足か ---
    layout['small_as'] = 'body'
    if small:
        above = 0
        for s in small:
            for b in big:
                if (-b['size'] * 0.3 <= b['y0'] - s['y1'] <= b['size'] * 1.2
                        and min(b['x1'], s['x1']) - max(b['x0'], s['x0']) > 0):
                    above += 1
                    break
        right = sum(1 for s in small if s['x0'] >= layout['x_split'])
        if above >= len(small) * 0.5:
            layout['small_as'] = 'ruby'
        elif right >= len(small) * 0.5:
            layout['small_as'] = 'memo'
    return layout


def score(rows):
    """抽出結果の確からしさ。レイアウト候補を選ぶのに使う"""
    if not rows:
        return 0.0
    n = len(rows)
    ends = sum(1 for r in rows if QUESTION_END_RE.search(r[0])) / n
    bleed = sum(1 for r in rows if BLEED_RE.match(r[1])) / n
    short = sum(1 for r in rows if len(r[1]) <= 40) / n
    return ends * 0.7 + short * 0.3 - bleed * 0.5


def tune(doc, layout, pages, fixed=()):
    """候補をいくつか試して、いちばん結果の良い設定を選ぶ。

    fixed に入っている項目はコマンドラインで指定されたものなので動かさない。
    """
    best, best_score = dict(layout), -1

    if 'anchor_source' in fixed:
        sources = [layout['anchor_source']]
    else:
        # auto は「番号の列 → ぶら下げ → 行頭埋め込み」を併用する
        sources = ['auto', 'numcol', 'indent', 'head']
        if not layout.get('num_max'):
            sources.remove('numcol')
        if not layout.get('q_indent'):
            sources.remove('indent')

    modes = [layout['anchor_mode']] if 'anchor_mode' in fixed else ['nearest', 'above']

    if 'small_as' in fixed:
        smalls = [layout['small_as']]
    elif layout['small_as'] in ('ruby', 'memo'):
        smalls = ['ruby', 'memo']
    else:
        smalls = [layout['small_as']]

    for source in sources:
        for mode in modes:
          for small in smalls:
            cand = dict(layout, anchor_source=source, anchor_mode=mode, small_as=small)
            rows, _ = to_rows(extract(doc, cand, pages), cand)
            rows = [r for rs in rows.values() for r in rs]
            if not rows:
                continue
            # 少数だけ拾えた設定が高得点になるのを防ぐため、
            # 「1ページあたり何問取れたか」で割り引く
            coverage = min(1.0, len(rows) / max(1, len(pages) * 1.5))
            s = score(rows) * coverage
            # 僅差ならルビを本文へ戻す設定を選ぶ（読みが残るほうが役に立つ）
            if small == 'ruby':
                s += 0.02
            if s > best_score:
                best, best_score = cand, s
    return best, best_score


# ------------------------------------------------------------------ 表の組み立て
def clean(text):
    # 康熙部首（⼈ ⼤ など漢字に似た別文字）や全角英数が混じるPDFがあるため揃える
    text = unicodedata.normalize('NFKC', text)
    text = text.replace('／', '').replace('/', '').replace('⁄', '')
    text = re.sub(r'[ \t　]+', ' ', text)
    text = re.sub(r' +([、。？！」』）])', r'\1', text)
    return text.strip()


def strip_heading(text):
    prev = None
    while prev != text:
        prev = text
        text = HEADING_RE.sub('', text).lstrip('　 ・:：')
    return text


def column_of_x(cx, cfg, x_split=None, memo_x=None):
    """X座標がどの列（問題文/答え/備考）に属するかを返す"""
    if memo_x is None:
        memo_x = cfg.get('memo_x')
    if memo_x and cx >= memo_x:
        return 'm'
    if cx >= (cfg['x_split'] if x_split is None else x_split):
        return 'a'
    if cx < cfg.get('q_min', 0):
        return 'x'          # 問題文列より左（作問者名など）は取り込まない
    return 'q'


def is_number_cell(item, cfg):
    """その文字片が「行の目印になる問題番号」かどうか。

    番号の列は問題文の列と横位置が重なることがあるため、X座標だけでは判定できない。
    「数字だけで出来ていて、番号の列の範囲に収まっている塊」を番号とみなす。
    """
    if not cfg.get('num_max') or not NUM_ONLY.match(item['text']):
        return False
    return cfg.get('num_min', 0) <= item['x0'] and item['x1'] <= cfg['num_max']


def line_boundary(line_items, cfg):
    """1行の中で、問題文と答えの間にある実際の空白から境界Xを求める。

    境界をファイル全体で固定にすると、その行だけ問題文が長かったときに
    末尾の数文字が答え側へこぼれる。行ごとに空白を探せばこれを防げる。
    """
    base = cfg['x_split']
    lo, hi = base - cfg.get('boundary_window', 60), base + cfg.get('boundary_window', 60)
    # 答えの列の左端が分かっているなら、その手前で始まる空白は問題文の内部の
    # 隙間なので採用しない（問題文の途中で切ってしまわないため）
    ans_x0 = cfg.get('answer_x0')

    spans = sorted((c['bbox'][0], c['bbox'][2])
                   for it in line_items for c in it['chars'] if c['c'].strip())
    if not spans:
        return base

    best_gap, best_x, prev_end = 0, None, None
    for x0, x1 in spans:
        if prev_end is not None and x0 - prev_end >= 6:
            mid = (prev_end + x0) / 2
            usable = lo <= mid <= hi and (ans_x0 is None or x0 >= ans_x0 - 3)
            if usable and x0 - prev_end > best_gap:
                best_gap, best_x = x0 - prev_end, mid
        prev_end = max(prev_end or x1, x1)
    return best_x if best_x is not None else base


def text_runs(line_items, x_from, gap_tol=4):
    """1行の文字を、途切れの無い塊（run）にまとめて [(左, 右), ...] で返す"""
    spans = sorted((c['bbox'][0], c['bbox'][2])
                   for it in line_items for c in it['chars']
                   if c['c'].strip() and (c['bbox'][0] + c['bbox'][2]) / 2 >= x_from)
    runs = []
    for x0, x1 in spans:
        if runs and x0 - runs[-1][1] < gap_tol:
            runs[-1][1] = max(runs[-1][1], x1)
        else:
            runs.append([x0, x1])
    return runs


def line_memo_boundary(line_items, cfg, x_split):
    """1行の中の、答えと備考（解答者名など）の境界Xを求める。

    答えの長さは行ごとに違うので、境界をファイル全体で固定にすると
    長い答えの後半が備考側へこぼれる。
      誤: 答え「トレーニン」  備考「グパンツ スルー」
      正: 答え「トレーニングパンツ」  備考「スルー」

    固定の境界が文字の途中に落ちた行だけを直す。空白の位置で切り直すと、
    ルビで字間が空いた答え（渡辺(わたなべ)太(ふとし)）まで割れてしまう。
    """
    base = cfg.get('memo_x')
    if not base:
        return None

    runs = text_runs(line_items, x_split)
    for i, (x0, x1) in enumerate(runs):
        if not x0 < base <= x1:
            continue
        # この塊は途中で切ってはいけない。次の空白まで境界を送る
        following = runs[i + 1][0] if i + 1 < len(runs) else None
        return (x1 + following) / 2 if following else x1 + 1
    return base


def split_by_column(item, cfg, x_split=None, memo_x=None):
    """1つの文字片を、文字ごとのX座標で列へ切り分ける。

    問題文と答えが同じ文字片にまとめられているPDFがあるため、
    片の左端だけで判定すると列がずれる。
    """
    buckets = {'n': [], 'q': [], 'a': [], 'm': [], 'x': []}

    # ルビ差し込み済みの片は文字数が合わないので、その場合は列を分けない
    if len(item['text']) != len(item['chars']):
        key = column_of_x((item['x0'] + item['x1']) / 2, cfg, x_split, memo_x)
        return {k: (item['text'] if k == key else '') for k in buckets}

    # 文字は左から右へ並ぶので、列は切り替わったら戻らないものとして扱う。
    # 1文字ずつ独立に判定すると、拗音など字形の狭い文字の中心座標が
    # わずかに境界を越えたときに、その1文字だけ別の列へ飛んでしまう。
    order = ['x', 'q', 'a', 'm']
    rank = -1
    for ch in item['chars']:
        key = column_of_x((ch['bbox'][0] + ch['bbox'][2]) / 2, cfg, x_split, memo_x)
        idx = order.index(key)
        if idx < rank:
            key = order[rank]
        else:
            rank = idx
        buckets[key].append(ch['c'])
    return {k: ''.join(v) for k, v in buckets.items()}


def attach_ruby(bases, rubies):
    """ルビ片を、真下の本文の該当文字の直後へ 漢字(かんじ) の形で差し込む"""
    inserts = {}
    for r in rubies:
        target, best = None, None
        for i, b in enumerate(bases):
            gap = b['y0'] - r['y1']
            if not (-b['size'] * 0.3 <= gap <= b['size'] * 1.2):
                continue
            if min(b['x1'], r['x1']) - max(b['x0'], r['x0']) <= 0:
                continue
            if best is None or gap < best:
                best, target = gap, i
        if target is None:
            continue
        pos = None
        for idx, c in enumerate(bases[target]['chars']):
            if min(c['bbox'][2], r['x1']) - max(c['bbox'][0], r['x0']) > 0:
                pos = idx + 1
        if pos is not None:
            inserts.setdefault(target, []).append((pos, r['text'].strip()))

    out = []
    for i, b in enumerate(bases):
        if i not in inserts:
            out.append(b)
            continue
        chars = [c['c'] for c in b['chars']]
        for pos, reading in sorted(inserts[i], reverse=True):
            chars.insert(pos, f'({reading})')
        out.append(dict(b, text=''.join(chars)))
    return out


def extract(doc, cfg, pages=None):
    """PDFから (区分, 問題文, 答え, メモ) のレコード列を作る"""
    small_as = cfg.get('small_as', 'body')
    records = []
    section = '早押し'

    for pi in (pages if pages is not None else range(doc.page_count)):
        page = doc[pi]
        items = page_items(page)
        if not items:
            continue
        bsize = body_size(items)

        # 大きい文字や記号付きの短い行は区分の見出し（●1R筆記クイズ など）
        for it in items:
            text = it['text'].strip()
            if len(text) <= 40 and (it['size'] >= bsize * 1.15 or re.match(r'^[●○■◆【]', text)):
                kind = section_kind(text)
                if kind:
                    section = kind

        # 答えの列が空のページ（問題だけを全幅に流し込んだ読み上げ用ページなど）は飛ばす。
        # そういうページを列で切ると、問題文の途中が答え側へ流れてしまう。
        # 答えの列があると分かっている文書に限り、自動で判定する。
        skip_empty_answer = cfg.get('require_answer_column') or (
            cfg.get('answer_x0') is not None and not cfg.get('keep_all_pages')
        )
        if skip_empty_answer and sum(1 for it in items if it['x0'] >= cfg['x_split']) < 3:
            continue

        threshold = bsize * cfg.get('small_ratio', 0.8)
        bases = [it for it in items if it['size'] >= threshold]
        smalls = [it for it in items if it['size'] < threshold]

        if small_as == 'ruby':
            bases = attach_ruby(bases, smalls)
        elif small_as == 'body':
            bases = bases + smalls

        number_items = [it for it in bases if is_number_cell(it, cfg)]
        bases = [it for it in bases if it not in number_items]

        # 同じ行の文字片をまとめ、行ごとに列の境界を決める
        lines = {}
        for it in bases:
            lines.setdefault(round((it['y0'] + it['y1']) / 2 / LINE_TOLERANCE), []).append(it)
        boundary = {k: line_boundary(v, cfg) for k, v in lines.items()}
        memo_bound = {k: line_memo_boundary(v, cfg, boundary[k]) for k, v in lines.items()}

        cells = []
        for it in number_items:
            cells.append({'key': 'n', 'y': (it['y0'] + it['y1']) / 2,
                          'x': it['x0'], 'text': it['text']})
        for it in bases:
            yc = (it['y0'] + it['y1']) / 2
            line_key = round(yc / LINE_TOLERANCE)
            for key, text in split_by_column(it, cfg, boundary[line_key],
                                             memo_bound[line_key]).items():
                if key != 'x' and text.strip():
                    cells.append({'key': key, 'y': yc, 'x': it['x0'], 'text': text})

        if small_as == 'memo':
            for it in smalls:
                yc = (it['y0'] + it['y1']) / 2
                line_key = round(yc / LINE_TOLERANCE)
                if column_of_x((it['x0'] + it['x1']) / 2, cfg, boundary.get(line_key),
                               memo_bound.get(line_key)) in ('a', 'm'):
                    cells.append({'key': 'm', 'y': yc, 'x': it['x0'], 'text': it['text']})

        # --- 行の目印になる問題番号を集める ---
        #     numcol : 番号が独立した列にある   indent : 1行目だけ左へ飛び出す
        #     head   : 番号が問題文の行頭に埋まっている
        source = cfg.get('anchor_source', 'auto')
        anchors = []
        if source in ('auto', 'numcol'):
            anchors = [{'no': int(NUM_ONLY.match(c['text']).group(1)), 'yc': c['y'],
                        'q': [], 'a': [], 'm': []}
                       for c in cells if c['key'] == 'n' and NUM_ONLY.match(c['text'])]

        # 1行目だけ左へ飛び出す形（番号と本文の間に空白が無く文字では切れない）
        q_indent = cfg.get('q_indent') if source in ('auto', 'indent') else None
        if q_indent:
            for c in sorted([c for c in cells if c['key'] == 'q'], key=lambda c: (c['y'], c['x'])):
                if c['x'] >= q_indent:
                    continue
                m = re.match(r'^\s*([0-9０-９]{1,4})\s*[\.．、]?\s*(.*)$', c['text'], re.S)
                if m and len(m.group(2).strip()) > 3:
                    if any(abs(a['yc'] - c['y']) < 6 for a in anchors):
                        continue
                    anchors.append({'no': to_int(m.group(1)), 'yc': c['y'],
                                    'q': [], 'a': [], 'm': []})
                    c['text'] = m.group(2)

        # 番号が問題文の行頭に埋まっている形
        if not anchors and source in ('auto', 'head'):
            for c in sorted([c for c in cells if c['key'] == 'q'], key=lambda c: (c['y'], c['x'])):
                m = NUM_HEAD.match(c['text'])
                if m and len(m.group(2).strip()) > 3:
                    anchors.append({'no': to_int(m.group(1)), 'yc': c['y'],
                                    'q': [], 'a': [], 'm': []})
                    c['text'] = m.group(2)

        if not anchors:
            continue
        anchors.sort(key=lambda a: a['yc'])

        # 各文字片を目印の行へ割り当てる
        #   nearest : 番号が行の中央にある形（最も近い番号に属する）
        #   above   : 番号が問題のかたまりの先頭上部にある形（直前の番号に属する）
        mode = cfg.get('anchor_mode', 'nearest')
        for c in cells:
            if c['key'] == 'n':
                continue
            if mode == 'above':
                prev = [a for a in anchors if a['yc'] <= c['y'] + 2]
                if not prev:
                    continue
                target = prev[-1]
            else:
                target = min(anchors, key=lambda a: abs(a['yc'] - c['y']))
                if abs(target['yc'] - c['y']) > 60:
                    continue
            target[c['key']].append(c)

        for a in anchors:
            # 同じ行でも左右で数値がわずかにずれることがあるため、
            # まず行にまとめてから左→右に並べる。
            # （Y座標をそのまま使うと、右側の断片が先に来て文が入れ替わる）
            for key in ('q', 'a', 'm'):
                a[key].sort(key=lambda c: (round(c['y'] / LINE_TOLERANCE), c['x']))

            # 右列に答えと判定・解説が混在する形では、
            # 判定記号（[◯◯○] など）から後ろをメモへ回す
            stop_re = cfg.get('answer_stop_re')
            if stop_re and a['a']:
                cut = len(a['a'])
                for i, c in enumerate(a['a']):
                    if re.match(stop_re, c['text'].strip()):
                        cut = i
                        break
                a['m'] = a['a'][cut:] + a['m']
                a['a'] = a['a'][:cut]

            records.append({
                'section': section,
                'q': clean(''.join(c['text'] for c in a['q'])),
                # 答えは行またぎで分かれることがある。日本語なので空白を入れずに繋ぐ
                'a': clean(''.join(c['text'] for c in a['a'])),
                'm': clean(' '.join(c['text'] for c in a['m'])),
            })
    return records


def to_rows(records, cfg):
    """区分（ペーパー/早押し）ごとに行をまとめる"""
    min_len = cfg.get('min_len', 15)
    tag = cfg.get('tag', '')
    by_section, dropped = {}, 0
    for r in records:
        q = strip_heading(r['q'])
        a = strip_heading(r['a'])
        memo = r['m']

        # 答えの末尾に付く判定や注記（[飼い主○]【スルー】など）はメモへ回す
        while True:
            m = JUDGE_TAIL_RE.search(a)
            if not m or not a[:m.start()].strip():
                break
            memo = f'{m.group(0)} {memo}'.strip()
            a = a[:m.start()].strip()

        if len(q) < min_len or not a:
            dropped += 1
            continue
        if cfg.get('require_question_end') and not QUESTION_END_RE.search(q):
            dropped += 1
            continue
        by_section.setdefault(r['section'], []).append(
            [q, a, memo, DEFAULT_GENRE, DEFAULT_DIFFICULTY,
             f"{tag}, {r['section']}" if tag else r['section']])
    return by_section, dropped


# ------------------------------------------------------------------ 実行
def build_config(doc, args):
    layout = detect_layout(doc)
    if layout is None:
        return None, 0.0

    # コマンドラインの指定は自動検出より優先し、その値を固定したまま残りを調整する
    fixed = set()
    if args.x_split is not None:
        layout['x_split'] = args.x_split
        layout['answer_x0'] = None      # 手動指定なら空白位置の推定に頼らない
    if args.num_range:
        lo, hi = (int(v) for v in args.num_range.split(','))
        layout['num_min'], layout['num_max'] = lo, hi
    if args.q_indent is not None:
        layout['q_indent'] = args.q_indent
    if args.q_min is not None:
        layout['q_min'] = args.q_min
    if args.memo_x is not None:
        layout['memo_x'] = args.memo_x
    if args.anchor:
        layout['anchor_mode'] = args.anchor
        fixed.add('anchor_mode')
    if args.anchor_source:
        layout['anchor_source'] = args.anchor_source
        fixed.add('anchor_source')
    if args.small:
        layout['small_as'] = args.small
        fixed.add('small_as')
    if args.small_ratio is not None:
        layout['small_ratio'] = args.small_ratio
    if args.answer_stop:
        layout['answer_stop_re'] = args.answer_stop
    if args.require_answer_column:
        layout['require_answer_column'] = True
    if args.keep_all_pages:
        layout['keep_all_pages'] = True
    if args.require_question_end:
        layout['require_question_end'] = True

    pages = sample_pages(doc)
    cfg, sc = tune(doc, layout, pages, fixed)

    # 成績表や講評など、問題以外の記述が多く混じる記録集では、
    # 疑問の形で終わらないものを捨てたほうが結果が良くなる。
    # 取りこぼしが一定を超えたら自動で有効にする（--keep-all で無効化）。
    if not args.keep_all and not cfg.get('require_question_end'):
        rows, _ = to_rows(extract(doc, cfg, pages), cfg)
        rows = [r for rs in rows.values() for r in rs]
        if rows:
            ok = sum(1 for r in rows if QUESTION_END_RE.search(r[0])) / len(rows)
            if ok < 0.75:
                cfg['require_question_end'] = True
    return cfg, sc


def convert(path, args):
    doc = fitz.open(path)
    cfg, sc = build_config(doc, args)
    if cfg is None:
        print(f'✗ {path.name}: テキストが取り出せません（画像のみのPDF？）')
        return 0

    cfg['tag'] = args.tag or path.stem
    by_section, dropped = to_rows(extract(doc, cfg), cfg)
    by_section, duplicated = dedupe(by_section)
    rows = [r for rs in by_section.values() for r in rs]

    if args.analyze:
        print(f'\n=== {path.name} ({doc.page_count}ページ) ===')
        print('  検出したレイアウト:')
        for key in ('body_size', 'x_split', 'answer_x0', 'memo_x', 'num_min', 'num_max',
                    'q_indent', 'q_min', 'small_as', 'anchor_source', 'anchor_mode'):
            if cfg.get(key) is not None:
                print(f'    {key:<14}= {cfg[key]}')
        print(f'  抽出: {len(rows)}問（除外 {dropped} / 重複 {duplicated}）'
              f' / 確からしさ {score(rows) * 100:.0f}点')
        for row in rows[:3]:
            print(f'\n    問題: {row[0][:100]}')
            print(f'    答え: {row[1][:50]}')
            if row[2]:
                print(f'    メモ: {row[2][:50]}')
        doc.close()
        return 0

    doc.close()
    if not rows:
        print(f'✗ {path.name}: 問題を抽出できませんでした（--analyze で確認してください）')
        return 0

    out_dir = Path(args.outdir) if args.outdir else path.parent.parent / 'csv'
    written = write_collections(by_section, out_dir, args.out or path.stem, args.limit)
    for name, n in written:
        print(f'✓ {name:<50}{n:>5}問')
    note = []
    if dropped:
        note.append(f'除外 {dropped}')
    if duplicated:
        note.append(f'重複 {duplicated}')
    if note:
        print(f"    （{path.stem}: {' / '.join(note)}）")
    return len(rows)


def main():
    p = argparse.ArgumentParser(
        description='クイズ問題集のPDFを QuizBook の CSV へ変換する',
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('input', help='PDFファイル、またはPDFの入ったディレクトリ')
    p.add_argument('--analyze', action='store_true', help='認識結果だけ表示（CSVは書かない）')
    p.add_argument('-o', '--out', help='出力ファイル名の基準（既定: 入力ファイル名）')
    p.add_argument('--outdir', help='出力先ディレクトリ（既定: 入力の隣の csv/）')
    p.add_argument('--tag', help='CSVのタグ欄に入れる文字列（既定: 入力ファイル名）')
    p.add_argument('--limit', type=int, default=MAX_PER_COLLECTION,
                   help=f'1ファイルあたりの問数（既定 {MAX_PER_COLLECTION}）')

    g = p.add_argument_group('レイアウトの上書き（既定は自動検出）')
    g.add_argument('--x-split', type=int, help='問題文と答えの境界X')
    g.add_argument('--num-range', help='問題番号の列のX範囲（例 0,48）')
    g.add_argument('--q-indent', type=int, help='問題1行目の左端X（ぶら下げインデント）')
    g.add_argument('--q-min', type=int, help='これより左は取り込まない')
    g.add_argument('--memo-x', type=int, help='備考列の左端X')
    g.add_argument('--anchor', choices=['nearest', 'above'], help='問題番号と本文の位置関係')
    g.add_argument('--anchor-source', choices=['auto', 'numcol', 'indent', 'head'],
                   help='問題番号の見つけ方（列/ぶら下げインデント/行頭埋め込み）')
    g.add_argument('--small', choices=['ruby', 'memo', 'body', 'drop'],
                   help='本文より小さい文字の扱い')
    g.add_argument('--small-ratio', type=float, help='小さい文字とみなす比率（既定 0.8）')
    g.add_argument('--answer-stop', help='この正規表現に合う行から後ろをメモへ回す')
    g.add_argument('--require-answer-column', action='store_true',
                   help='答えの列が無いページを飛ばす')
    g.add_argument('--require-question-end', action='store_true',
                   help='疑問の形で終わらない問題を捨てる（既定: 取りこぼしが多いと自動で有効）')
    g.add_argument('--keep-all', action='store_true',
                   help='疑問の形で終わらないものも残す（自動有効化をやめる）')
    g.add_argument('--keep-all-pages', action='store_true',
                   help='答えの列が無いページも読む（既定: 自動で飛ばす）')

    args = p.parse_args()
    target = Path(args.input)
    if not target.exists():
        sys.exit(f'見つかりません: {target}')

    files = sorted(target.glob('*.pdf')) if target.is_dir() else [target]
    if not files:
        sys.exit(f'PDFがありません: {target}')

    total = sum(convert(f, args) for f in files)
    if not args.analyze:
        print(f'\n合計 {total} 問  ※1ファイルあたり最大 {args.limit} 問で分割')


if __name__ == '__main__':
    main()
