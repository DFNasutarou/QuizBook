# -*- coding: utf-8 -*-
"""変換と点検の判定が壊れていないか確かめる。

実行:
    python scripts/quiz_import/test_quiz_import.py

PDFは使わず、文字片の座標を組み立てて判定だけを試す。
過去に直した不具合をそのまま残してあるので、
レイアウト判定を触ったときはここが通るか確認する。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_csv
import pdf_to_csv


def item(text, x0, x1, y0=100.0, size=10.0):
    """文字片を1つ作る。文字は x0〜x1 に等間隔で並べる"""
    width = (x1 - x0) / max(1, len(text))
    chars = [{'c': ch, 'bbox': (x0 + i * width, y0, x0 + (i + 1) * width, y0 + size)}
             for i, ch in enumerate(text)]
    return {'x0': x0, 'x1': x1, 'y0': y0, 'y1': y0 + size,
            'size': size, 'text': text, 'chars': chars}


class TestColumnBoundary(unittest.TestCase):
    """問題文と答えの境界（行ごとに空白を探す）"""

    cfg = {'x_split': 392, 'answer_x0': 397, 'body_size': 9.0}

    def test_空白があればそこで切る(self):
        line = [item('日本の首都はどこでしょう?', 52, 380), item('東京', 397, 420)]
        self.assertTrue(380 < pdf_to_csv.line_boundary(line, self.cfg) < 397)

    def test_全幅の行は切らない(self):
        # 解説などが全幅に流し込まれた行。固定の境界で切ると
        # 文の途中が答え側へ流れる
        line = [item('二〇一〇年シシャパンマに登頂し、八〇〇〇メートル峰全一四座の', 43, 473)]
        self.assertGreater(pdf_to_csv.line_boundary(line, self.cfg), 473)

    def test_列の隙間が狭くても答えを飲み込まない(self):
        # 問題文が392で終わり、答えが394から始まる（隙間2pt）作り
        cfg = {'x_split': 393, 'answer_x0': 394, 'body_size': 9.9}
        line = [item('栃木県日光市にある落差約', 84, 392), item('華厳の滝', 394, 434)]
        self.assertLessEqual(pdf_to_csv.line_boundary(line, cfg), 394)


class TestMemoBoundary(unittest.TestCase):
    """答えと備考（解答者名など）の境界"""

    cfg = {'x_split': 392, 'answer_x0': 397, 'memo_x': 442, 'body_size': 9.0}

    def test_長い答えを途中で切らない(self):
        # 「トレーニン」＋「グパンツ スルー」に割れていた行
        line = [item('問題文', 20, 380),
                item('トレーニングパンツ', 399, 476),
                item('スルー', 506, 534)]
        boundary = pdf_to_csv.line_memo_boundary(line, self.cfg, 392)
        self.assertTrue(476 < boundary <= 506)

    def test_備考が無い行は答えを全部残す(self):
        line = [item('問題文', 20, 380), item('サンドウィッチマン', 399, 470)]
        self.assertGreater(pdf_to_csv.line_memo_boundary(line, self.cfg, 392), 470)

    def test_境界の近くに空白があればそこで切る(self):
        line = [item('問題文', 20, 380), item('答え', 399, 436), item('解説', 447, 492)]
        boundary = pdf_to_csv.line_memo_boundary(line, self.cfg, 392)
        self.assertTrue(436 < boundary <= 447)


class TestAnswerColumn(unittest.TestCase):
    """そのページに答えの列があるか"""

    cfg = {'x_split': 364, 'answer_x0': 365}

    def test_答えの列があるページ(self):
        items = [item('問題文が続きます', 43, 340, y0=100),
                 item('答え', 379, 420, y0=100),
                 item('次の問題文です', 43, 330, y0=120),
                 item('答え2', 379, 425, y0=120)]
        self.assertTrue(pdf_to_csv.has_answer_column(items, self.cfg, 9.0))

    def test_全幅の解説ページ(self):
        # 片が途中で切れているだけで、境界に空白は無い
        items = [item('解説の一行目がここまで続き', 43, 371, y0=100),
                 item('さらに右へ続きます', 375, 474, y0=100),
                 item('解説の二行目です', 43, 470, y0=120)]
        self.assertFalse(pdf_to_csv.has_answer_column(items, self.cfg, 9.0))


class TestQuestionTail(unittest.TestCase):
    """問題文の後ろに紛れ込んだ解説・番号を切り離す"""

    def test_解説を切り離す(self):
        q, tail = pdf_to_csv.split_question_tail(
            '「何スコア」というでしょう?Eスコアは「実施点」')
        self.assertEqual(q, '「何スコア」というでしょう?')
        self.assertEqual(tail, 'Eスコアは「実施点」')

    def test_次の問題の番号を切り離す(self):
        q, tail = pdf_to_csv.split_question_tail('プロ雀士は誰でしょう?3')
        self.assertEqual(q, 'プロ雀士は誰でしょう?')
        self.assertEqual(tail, '3')

    def test_題名の中の疑問符では切らない(self):
        text = '『どうする?』のCMで知られる、この会社はどこでしょう?'
        q, tail = pdf_to_csv.split_question_tail(text)
        self.assertEqual(q, text)
        self.assertEqual(tail, '')

    def test_余りが無ければそのまま(self):
        text = '日本の首都はどこでしょう?'
        self.assertEqual(pdf_to_csv.split_question_tail(text), (text, ''))


class TestRuby(unittest.TestCase):
    """ルビの差し込み"""

    def test_括弧付きのルビに括弧を重ねない(self):
        base = item('日光菩薩', 100, 140, y0=110)
        ruby = item('（にっこうぼさつ）', 100, 140, y0=100, size=5.0)
        out = pdf_to_csv.attach_ruby([base], [ruby])
        self.assertEqual(out[0]['text'], '日光菩薩(にっこうぼさつ)')


class TestCheckRules(unittest.TestCase):
    """点検の判定"""

    def test_問題文の終わり方(self):
        ok = ['日本の首都はどこでしょう?', 'ビールの祭典はなに', '封をするのはどっち',
              '建っているのは何区', '最後の皇帝といえば誰']
        ng = ['開催しているキャンペ', 'B級映画から『アメリ』などの', 'プロ雀士は誰でしょう?3']
        for t in ok:
            self.assertTrue(check_csv.QUESTION_END_RE.search(t), t)
        for t in ng:
            self.assertFalse(check_csv.QUESTION_END_RE.search(t), t)

    def test_問いの数え方(self):
        # 題名や引用の中の「?」は数えない
        self.assertEqual(check_csv.count_questions(
            '『CAN YOU CELEBRATE?』で知られる歌手は誰でしょう?'), 1)
        self.assertEqual(check_csv.count_questions(
            '「好きですか?」と聞いた俳優は誰?'), 1)
        self.assertEqual(check_csv.count_questions(
            '一問目は何でしょう?二問目は誰でしょう?'), 2)

    def test_答えの長さは括弧の中を数えない(self):
        long_answer = '『グロス・クリニック』(TheGrossClinicTheClinicofDrGrossPortrait)'
        self.assertGreater(len(long_answer), 40)
        self.assertLessEqual(check_csv.bare_length(long_answer), 40)

    def test_列こぼれ(self):
        # 語頭にありえない文字は、問題文が正しくても拾う
        self.assertTrue(check_csv.BLEED_RE.match('ょうがない'))
        self.assertTrue(check_csv.BLEED_RE.match('」という'))
        # 助詞と同じ字で始まる普通の答えは拾わない
        for word in ('はなむけ', 'へそ天', 'にじさんじ', 'もっこり', 'がりがり'):
            self.assertFalse(check_csv.BLEED_RE.match(word), word)
            self.assertTrue(check_csv.BLEED_WEAK_RE.match(word), word)

    def test_括弧の不一致(self):
        self.assertTrue(check_csv.unbalanced('『ワンパンマ'))
        self.assertTrue(check_csv.unbalanced('破袋(やぶれぶくろ)】大ひびきれ○'))
        self.assertFalse(check_csv.unbalanced('『ワンパンマン』'))
        self.assertFalse(check_csv.unbalanced('大黒屋光太夫'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
