#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
既存の問題集データを整形してタグと難易度を追加するスクリプト
"""

import csv
import json
import re
import random
from datetime import datetime
from pathlib import Path


def process_ruby_text(text: str) -> str:
    """括弧のふりがなを適切に処理"""
    if not text:
        return text
    
    # 漢字(ひらがな) の形式を検出
    pattern = r'([一-龯々]+)\(([ひらがな-ゞ゛゜]+)\)'
    
    def replace_ruby(match):
        kanji = match.group(1)
        hiragana = match.group(2)
        return f"{kanji}({hiragana})"
    
    return re.sub(pattern, replace_ruby, text)


def estimate_difficulty(question: str, answer: str) -> float:
    """問題文と答えから難易度を推定 (1.0-5.0の範囲)"""
    # 簡単な難易度推定ルール
    difficulty_keywords = {
        1.5: ["何", "だれ", "どこ", "いつ", "基本", "有名", "一般的", "簡単"],
        2.5: ["よく知られた", "代表的", "主要な", "基礎的"],
        3.0: [],  # デフォルト
        4.0: ["専門", "詳細", "高度", "複雑", "学術的"],
        4.5: ["正式名", "別名", "詳しく", "具体的に", "厳密に"]
    }
    
    text = question + answer
    
    # キーワードに基づいて難易度を決定
    for difficulty_level in sorted(difficulty_keywords.keys(), reverse=True):
        for keyword in difficulty_keywords[difficulty_level]:
            if keyword in text:
                return difficulty_level
    
    # デフォルトは3.0
    return 3.0


def assign_genre(question: str, answer: str, memo: str, existing_genre: str) -> str:
    """問題文、答え、メモから適切なジャンルを推定"""
    if existing_genre and existing_genre.strip():
        return existing_genre.strip()
    
    # 新しいジャンル判定キーワード
    genre_keywords = {
        "アニメ&ゲーム": ["アニメ", "漫画", "ゲーム", "キャラクター", "声優", "作者", "連載", "ジャンプ", "マガジン", "RPG", "アクション", "パズル", "シューティング", "Nintendo", "Vtuber"],
        "スポーツ": ["選手", "競技", "オリンピック", "チーム", "試合", "記録", "野球", "サッカー", "テニス", "バスケ", "陸上", "水泳", "体操", "柔道"],
        "芸能": ["映画", "監督", "俳優", "女優", "番組", "テレビ", "ドラマ", "シリーズ", "歌手", "音楽", "演奏", "作曲", "オーケストラ", "交響曲", "オペラ", "ピアノ", "芸人", "タレント"],
        "ライフスタイル": ["料理", "食べ物", "レシピ", "材料", "調理", "グルメ", "レストラン", "味", "生活", "暮らし", "健康", "美容", "ファッション"],
        "社会": ["政治", "経済", "首相", "大統領", "政党", "選挙", "法律", "条約", "市場", "社会", "企業", "会社", "組織", "国際", "世界"],
        "文系学問": ["文学", "歴史", "哲学", "心理学", "社会学", "小説", "作家", "詩", "俳句", "短歌", "物語", "書籍", "本", "著者", "年", "時代", "戦争", "王", "皇帝", "革命", "古代", "中世", "近世", "明治", "大正", "昭和", "言葉", "語源", "英語", "フランス語", "ドイツ語", "中国語", "翻訳", "意味"],
        "理系学問": ["科学", "元素", "化学", "物理", "生物", "医学", "実験", "理論", "細胞", "DNA", "原子", "分子", "数学", "計算", "方程式", "定理", "公式", "幾何", "代数", "統計", "確率", "工学", "技術"],
    }
    
    text = (question + answer + memo).lower()
    
    # 各ジャンルのキーワードマッチング
    genre_scores = {}
    for genre, keywords in genre_keywords.items():
        score = sum(1 for keyword in keywords if keyword in text)
        if score > 0:
            genre_scores[genre] = score
    
    if genre_scores:
        # 最もスコアの高いジャンルを返す
        return max(genre_scores, key=genre_scores.get)
    
    return "ノンジャンル"


def generate_tags(question: str, answer: str, memo: str, genre: str) -> list:
    """問題から適切なタグを生成"""
    tags = []
    
    # ジャンルをタグに追加
    if genre and genre != "ノンジャンル":
        tags.append(genre)
    
    # 特定のキーワードからタグを生成
    tag_keywords = {
        "ベタ問": ["有名", "基本", "定番", "よく出る", "頻出"],
        "人名": ["さん", "氏", "先生", "博士", "教授", "作家", "画家", "選手"],
        "地名": ["県", "市", "町", "村", "国", "州", "島", "山", "川", "湖"],
        "年号": ["年", "世紀", "時代"],
        "作品名": ["作品", "小説", "映画", "楽曲", "絵画", "彫刻"],
        "専門用語": ["用語", "概念", "理論", "法則", "現象"],
        "数字": ["数", "番目", "第", "回", "個", "人", "年"],
        "色": ["赤", "青", "黄", "緑", "白", "黒", "紫", "橙", "茶", "灰"]
    }
    
    text = question + answer + memo
    
    for tag, keywords in tag_keywords.items():
        if any(keyword in text for keyword in keywords):
            tags.append(tag)
    
    # 重複を削除
    tags = list(set(tags))
    
    # タグが多すぎる場合は制限
    if len(tags) > 5:
        tags = tags[:5]
    
    return tags


def process_csv_file(input_path: str, output_name: str) -> dict:
    """CSVファイルを処理して整形済みデータを作成"""
    quizzes = []
    
    try:
        with open(input_path, 'r', encoding='utf-8') as f:
            reader = csv.reader(f, delimiter='\t')  # タブ区切りを明示的に指定
            header = next(reader)  # ヘッダーをスキップ
            
            for row_num, row in enumerate(reader, 2):
                if len(row) >= 2 and row[0].strip() and row[1].strip():
                    # 空の行や不完全な行をスキップ
                    if not row[0].strip() or not row[1].strip():
                        continue
                    question = process_ruby_text(row[0].strip())
                    answer = process_ruby_text(row[1].strip())
                    memo = process_ruby_text(row[2].strip()) if len(row) > 2 else ""
                    existing_genre = row[3].strip() if len(row) > 3 else ""
                    
                    # ジャンルを推定
                    genre = assign_genre(question, answer, memo, existing_genre)
                    
                    # 難易度を推定
                    difficulty = estimate_difficulty(question, answer)
                    
                    # タグを生成
                    tags = generate_tags(question, answer, memo, genre)
                    
                    quiz = {
                        'question': question,
                        'answer': answer,
                        'tags': tags,
                        'difficulty': difficulty,
                        'genre': genre,
                        'memo': memo,
                        'created_at': datetime.now().isoformat()
                    }
                    
                    quizzes.append(quiz)
    
    except Exception as e:
        print(f"エラー: {input_path}の処理中にエラーが発生しました: {e}")
        return None
    
    return {
        'name': output_name,
        'quizzes': quizzes,
        'created_at': datetime.now().isoformat()
    }


def main():
    """メイン処理"""
    # 入力ファイルパス
    input_files = [
        ("ベタ問の森_utf8.csv", "ベタ問の森（整形済み）"),
        ("自作問題_utf8.csv", "自作問題（整形済み）")
    ]
    
    base_path = Path("../data/original")
    
    all_collections = []
    
    for input_file, output_name in input_files:
        input_path = base_path / input_file
        
        if not input_path.exists():
            print(f"警告: {input_path} が見つかりません")
            continue
        
        print(f"処理中: {input_file}")
        collection_data = process_csv_file(str(input_path), output_name)
        
        if collection_data:
            all_collections.append(collection_data)
            
            # 個別ファイルとして保存
            output_file = Path("../data/formatted") / f"{output_name.replace('（', '_').replace('）', '')}.json"
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(collection_data, f, ensure_ascii=False, indent=2)
            
            print(f"✓ {output_name}: {len(collection_data['quizzes'])}問を処理しました")
            print(f"  保存先: {output_file}")
        else:
            print(f"✗ {input_file}の処理に失敗しました")
    
    # 全ての問題集を統合したファイルも作成
    if all_collections:
        combined_data = {
            'collections': all_collections,
            'saved_at': datetime.now().isoformat()
        }
        
        combined_file = Path("../data/formatted/quiz_collections_formatted.json")
        with open(combined_file, 'w', encoding='utf-8') as f:
            json.dump(combined_data, f, ensure_ascii=False, indent=2)
        
        print(f"\n統合ファイルを作成しました: {combined_file}")
        print(f"総問題数: {sum(len(col['quizzes']) for col in all_collections)}問")
    
    # サンプルCSVファイルも作成（ツール用フォーマット）
    sample_csv = Path("../data/samples/sample_quiz_format.csv")
    with open(sample_csv, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['問題文', '答え', 'メモ', 'ジャンル', '難易度', 'タグ'])
        writer.writerow([
            '日本の首都はどこでしょう？',
            '東京',
            '基本的な地理問題です',
            '地理',
            '易',
            '地理, ベタ問, 基本'
        ])
        writer.writerow([
            '「吾輩は猫である」の作者は誰でしょう？',
            '夏目漱石(なつめそうせき)',
            '明治時代の代表的作家',
            '文学',
            '中',
            '文学, 作品名, 人名'
        ])
    
    print(f"\nサンプルCSVファイルを作成しました: {sample_csv}")
    print("\n処理完了！")


if __name__ == "__main__":
    main()