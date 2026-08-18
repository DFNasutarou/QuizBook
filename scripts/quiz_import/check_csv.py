# -*- coding: utf-8 -*-
"""変換済みCSVを点検し、怪しいものを一覧にする。

使い方:
    python scripts/quiz_import/check_csv.py <CSVファイル または ディレクトリ>

出力:
    指定ディレクトリの _要確認リスト.csv
        どのファイルの何行目が、どういう理由で怪しいかを並べたもの。
        ツールに取り込んだあと、この一覧を見ながら直す・消すのに使う。

判定している「怪しさ」:
    列こぼれ  … 答えが語頭にありえない文字で始まる。または助詞で始まり、
                かつ問題文が途中で切れている（問題文の末尾が答え側へ流れた形）
    こぼれ(メモ) … メモが同じ形で始まる（答えの末尾がメモ側へ流れた形）
    括弧の不一致 … 答えやメモで括弧の開きと閉じの数が合わない
                   （答えが途中で切れてメモへ流れた行で起きやすい）
    問題文途中 … 問題文が疑問の形で終わっていない
    問題混在  … 問題文の中に問いの終わりが2つ以上ある（2問が繋がった形）
    答えが長い … 括弧の中を除いた答えが40字を超える（解説を巻き込んだ形）
    重複      … 同じ問題文が複数ある

「はなむけ」「にじさんじ」のように助詞で始まる答えや、
『CAN YOU CELEBRATE?』のように題名に「?」を含む問題文があるため、
文字の並びだけでは決められない。前後の状態と併せて判定する。
"""
import argparse
import csv
import re
import sys
from pathlib import Path

# 語頭にありえない文字で始まる = 問題文の続きが答え側へこぼれた形
BLEED_RE = re.compile(r'^[ょゃゅっーぁぃぅぇぉを、。」』）]')
# 語頭にもありうる助詞。問題文が途中で切れているときだけ、こぼれとみなす
#   （「はなむけ」「へそ天」「にじさんじ」などを拾わないため）
BLEED_WEAK_RE = re.compile(r'^[にはがのでともへや]')
# 「〜でしょう?」で終わらず、疑問の言葉で言い切る問題集もある。
#   例: 「〜のはどっち」「〜の祭典はなに」「〜建っているのは何区」
# 末尾で言い切っている形だけを通す。「〜でしょう?3」のように後ろに
# 別の問題の番号や解説が続く行は、途中として拾いたいため。
QUESTION_END_RE = re.compile(
    r'(?:[？?]|でしょう[かうっ]?|ですか|という|まで|答えなさい|お答えください|'
    r'なに|どっち|どちら|いくつ|いつ|だれ|誰|どこ|どれ|何[^。、？?\s]{0,10}'
    r')[\s。]*$'
)
# 括弧の開きと閉じの数が合わない = 語の途中で列をまたいで切れた形
BRACKETS = (('「', '」'), ('『', '』'), ('（', '）'), ('(', ')'),
            ('【', '】'), ('〈', '〉'), ('《', '》'))
# 読み・原題・別解などの括弧書き。答えの長さを見るときは中身を数えない
BRACKETED_RE = re.compile(r'[（(【〈《「『][^）)】〉》」』]*[）)】〉》」』]')
# 問いの終わり。題名の中の「?」と区別するため、言い回しごと見る
QUESTION_TAIL_RE = re.compile(
    r'(?:でしょう[かうっ]?|ですか|という|なに|どっち|どちら|いくつ|だれ|誰|どこ|'
    r'何[^\s？?]{0,4})[？?]'
)
CLOSING = '」』）)】〉》”"\''


def unbalanced(text):
    return any(text.count(open_) != text.count(close) for open_, close in BRACKETS)


def count_questions(question):
    """問題文の中に問いの終わりがいくつあるか。

    『CAN YOU CELEBRATE?』や「〜が好きですか?」という質問、のように
    題名や引用の中にある「?」は数えない。
    """
    count = 0
    for m in QUESTION_TAIL_RE.finditer(question):
        if question[m.end():m.end() + 1] in CLOSING:
            continue
        count += 1
    return count


def bare_length(answer):
    """読みや原題の括弧書きを除いた答えの長さ"""
    return len(BRACKETED_RE.sub('', answer))


def inspect(path):
    rows = list(csv.reader(open(path, encoding='utf-8-sig')))
    if not rows:
        return [], 0
    body = rows[1:]
    seen = {}
    issues = []

    for i, r in enumerate(body, start=2):   # ヘッダを1行目として数える
        if len(r) < 2:
            continue
        q, a = r[0], r[1]
        memo = r[2] if len(r) > 2 else ''
        reasons = []
        ends = bool(QUESTION_END_RE.search(q))
        if BLEED_RE.match(a) or (BLEED_WEAK_RE.match(a) and not ends):
            reasons.append('列こぼれ')
        if BLEED_RE.match(memo) or (BLEED_WEAK_RE.match(memo) and not ends):
            reasons.append('こぼれ(メモ)')
        if unbalanced(a) or unbalanced(memo):
            reasons.append('括弧の不一致')
        if not ends:
            reasons.append('問題文途中')
        if count_questions(q) >= 2:
            reasons.append('問題混在')
        if bare_length(a) > 40:
            reasons.append('答えが長い')
        if q in seen:
            reasons.append(f'重複(行{seen[q]})')
        else:
            seen[q] = i
        if reasons:
            issues.append([f'{path.parent.name}/{path.name}', i,
                           ' / '.join(reasons), q[:120], a[:60]])
    return issues, len(body)


def main():
    p = argparse.ArgumentParser(description='変換済みCSVを点検して怪しい行を一覧にする')
    p.add_argument('input', nargs='?', default='購入問題/csv',
                   help='CSVファイル、またはCSVの入ったディレクトリ（既定: 購入問題/csv）')
    p.add_argument('-o', '--out', help='一覧の出力先（既定: 入力ディレクトリの _要確認リスト.csv）')
    args = p.parse_args()

    target = Path(args.input)
    if not target.exists():
        sys.exit(f'見つかりません: {target}')

    if target.is_dir():
        # 元ファイルごとのサブフォルダに入っているので再帰的に探す
        files = [f for f in sorted(target.rglob('*.csv')) if not f.name.startswith('_')]
        report = Path(args.out) if args.out else target / '_要確認リスト.csv'
    else:
        files = [target]
        report = Path(args.out) if args.out else target.parent / '_要確認リスト.csv'

    all_issues, total = [], 0
    print(f"{'ファイル':<40}{'問数':>6}{'要確認':>7}")
    print('-' * 56)
    for path in files:
        issues, n = inspect(path)
        total += n
        all_issues.extend(issues)
        flag = '' if not issues else f'{len(issues) / n * 100:.0f}%'
        label = f'{path.parent.name}/{path.name}' if path.parent != target else path.name
        print(f'{label[:44]:<46}{n:>6}{len(issues):>7} {flag}')

    with open(report, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(['ファイル', '行', '理由', '問題文', '答え'])
        w.writerows(all_issues)

    print(f'\n全 {total} 問中 {len(all_issues)} 件を要確認として抽出しました')
    print(f'一覧: {report}')


if __name__ == '__main__':
    sys.exit(main())
