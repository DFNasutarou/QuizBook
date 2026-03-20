// 早押しクイズ管理ツール - JavaScript

class QuizManager {
    constructor() {
        this.isViewMode = new URLSearchParams(window.location.search).has('view');
        this.collections = [];
        this.currentCollection = null;
        this.currentQuiz = null;
        this.candidates = [];  // 候補リスト
        this.editHistory = [];  // 編集履歴（保存した問題のIDを記録）
        this.quizMode = {
            active: false,
            quizzes: [],
            currentIndex: 0,
            answerVisible: true  // デフォルトで答えを表示
        };
        this.settings = {
            fontSize: 14,
            quizFontSize: 20
        };
        this.syncEnabled = false;  // 同期状態
        this.isLoadingFromFirestore = false;  // Firestoreからの読み込み中フラグ

        this.init();
    }

    async init() {
        console.log('🚀 QuizBook を初期化中...');
        
        // Firebase初期化
        if (window.firebaseSync) {
            await window.firebaseSync.initialize();
            console.log('✅ Firebase初期化完了');
        } else {
            console.log('⚠️ Firebase Syncが利用できません（オフラインモード）');
        }

        this.loadFromLocalStorage();
        this.setupEventListeners();
        this.setupKeyboardShortcuts();
        this.updateUI();
        this.applySettings();
        if (this.isViewMode) this.applyViewMode();
        
        console.log('✅ QuizBook の初期化完了');
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // 出題モード中のみキーボードショートカットを有効化
            if (!this.quizMode.active) return;

            // 入力フィールドにフォーカスがある場合は無効化
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch(e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    this.previousQuiz();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.nextQuiz();
                    break;
            }
        });
    }

    // ================== イベントリスナー設定 ==================
    setupEventListeners() {
        // タブ切り替え
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // ファイル操作
        document.getElementById('saveBtn').addEventListener('click', () => this.saveToFile());
        document.getElementById('loadBtn').addEventListener('click', () => this.loadFromFile());
        document.getElementById('importCsvBtn').addEventListener('click', () => this.importCsv());
        document.getElementById('exportCsvBtn').addEventListener('click', () => this.exportCsv());

        // クラウド同期
        document.getElementById('syncToggleBtn').addEventListener('click', () => this.toggleSync());
        document.getElementById('cloudDownloadBtn').addEventListener('click', () => this.downloadFromCloud());
        
        // 同期コード表示（右クリック or 長押し）
        const syncBtn = document.getElementById('syncToggleBtn');
        let longPressTimer;
        
        syncBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showSyncCode();
        });
        
        syncBtn.addEventListener('touchstart', () => {
            longPressTimer = setTimeout(() => {
                this.showSyncCode();
            }, 800);
        });
        
        syncBtn.addEventListener('touchend', () => {
            clearTimeout(longPressTimer);
        });
        
        syncBtn.addEventListener('touchmove', () => {
            clearTimeout(longPressTimer);
        });

        // 問題集管理
        document.getElementById('newCollectionBtn').addEventListener('click', () => this.newCollection());
        document.getElementById('renameCollectionBtn').addEventListener('click', () => this.renameCollection());
        document.getElementById('deleteCollectionBtn').addEventListener('click', () => this.deleteCollection());
        document.getElementById('collectionList').addEventListener('change', (e) => this.selectCollection(e.target.value));
        document.getElementById('collectionList').addEventListener('dblclick', (e) => this.startQuizFromCollection());

        // 問題管理
        document.getElementById('newQuizBtn').addEventListener('click', () => this.newQuiz());
        document.getElementById('deleteQuizBtn').addEventListener('click', () => this.deleteQuiz());

        // 問題編集
        document.getElementById('saveQuizBtn').addEventListener('click', () => this.saveQuiz());
        document.getElementById('cancelEditBtn').addEventListener('click', () => this.cancelEdit());
        document.getElementById('addRubyBtn').addEventListener('click', () => this.addRuby());
        document.getElementById('addColorBtn').addEventListener('click', () => this.addColor());
        document.getElementById('prevQuizEditBtn').addEventListener('click', () => this.navigateToPreviousQuiz());
        document.getElementById('nextQuizEditBtn').addEventListener('click', () => this.navigateToNextQuiz());

        // フィルター
        document.getElementById('searchBox').addEventListener('input', () => this.filterQuizzes());
        document.getElementById('genreFilter').addEventListener('change', () => this.filterQuizzes());
        document.getElementById('difficultyFilter').addEventListener('change', () => this.filterQuizzes());

        // 出題機能
        document.getElementById('startQuizBtn').addEventListener('click', () => this.startQuizMode());
        document.getElementById('endQuizBtn').addEventListener('click', () => this.endQuizMode());
        document.getElementById('prevQuizBtn').addEventListener('click', () => this.previousQuiz());
        document.getElementById('nextQuizBtn').addEventListener('click', () => this.nextQuiz());
        document.getElementById('randomQuizBtn').addEventListener('click', () => this.randomQuiz());
        document.getElementById('toggleAnswerBtn').addEventListener('click', () => this.toggleAnswer());

        // 候補リスト
        document.getElementById('addCandidateBtn').addEventListener('click', () => this.addCandidate());
        document.getElementById('newCandidateInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('candidateMemoInput').focus();
            }
        });
        document.getElementById('candidateMemoInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addCandidate();
            }
        });
        document.getElementById('clearCandidatesBtn').addEventListener('click', () => this.clearCandidates());
        document.getElementById('showCandidatesBtn').addEventListener('click', () => this.toggleCandidatesSidebar());
        document.getElementById('closeCandidatesBtn').addEventListener('click', () => this.toggleCandidatesSidebar());

        // 設定
        document.getElementById('fontSizeSlider').addEventListener('input', (e) => {
            this.settings.fontSize = parseInt(e.target.value);
            this.applySettings();
        });
        document.getElementById('quizFontSizeSlider').addEventListener('input', (e) => {
            this.settings.quizFontSize = parseInt(e.target.value);
            this.applySettings();
        });
        document.getElementById('clearDataBtn').addEventListener('click', () => this.clearAllData());

        // 事実確認
        document.getElementById('factCheckClaudeWebBtn').addEventListener('click', () => this.openClaudeWebForFactCheck());

        // ファイル入力
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileLoad(e));
        document.getElementById('csvFileInput').addEventListener('change', (e) => this.handleCsvImport(e));

        // 問題移動タブ
        document.getElementById('moveSourceCollection').addEventListener('change', (e) => this.onMoveCollectionChange('source', e.target.value));
        document.getElementById('moveDestCollection').addEventListener('change', (e) => this.onMoveCollectionChange('dest', e.target.value));
        document.getElementById('moveSourceSearch').addEventListener('input', () => this.renderMoveList('source'));
        document.getElementById('moveDestSearch').addEventListener('input', () => this.renderMoveList('dest'));
        document.getElementById('moveRightBtn').addEventListener('click', () => this.moveQuizzes('source', 'dest'));
        document.getElementById('moveLeftBtn').addEventListener('click', () => this.moveQuizzes('dest', 'source'));
        document.getElementById('copyRightBtn').addEventListener('click', () => this.copyQuizzes('source', 'dest'));
        document.getElementById('copyLeftBtn').addEventListener('click', () => this.copyQuizzes('dest', 'source'));
    }

    // ================== タブ切り替え ==================
    switchTab(tabName) {
        // 閲覧モードでは編集・候補リスト・移動タブへの遷移をブロック
        if (this.isViewMode && (tabName === 'edit' || tabName === 'candidates' || tabName === 'move')) return;

        // タブボタンの切り替え
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // コンテンツの切り替え
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`${tabName}-tab`).classList.add('active');
    }

    // ================== 問題集管理 ==================
    newCollection() {
        const name = prompt('新しい問題集の名前を入力してください:');
        if (!name) return;

        const collection = {
            id: Date.now().toString(),
            name: name,
            quizzes: [],
            created_at: new Date().toISOString()
        };

        this.collections.push(collection);
        this.currentCollection = collection;
        
        console.log(`📁 新規問題集を作成: "${name}" (ID: ${collection.id})`);
        
        this.updateUI();
        this.saveToLocalStorage();
    }

    renameCollection() {
        if (!this.currentCollection) {
            alert('名前を変更する問題集を選択してください');
            return;
        }

        const oldName = this.currentCollection.name;
        const newName = prompt('新しい名前を入力してください:', oldName);
        
        if (!newName || newName === oldName) return;

        this.currentCollection.name = newName;
        
        console.log(`✏️ 問題集の名前を変更: "${oldName}" → "${newName}"`);
        
        this.updateUI();
        this.saveToLocalStorage();
    }

    deleteCollection() {
        if (!this.currentCollection) {
            alert('削除する問題集を選択してください');
            return;
        }

        if (!confirm(`「${this.currentCollection.name}」を削除しますか？`)) return;

        const deletedName = this.currentCollection.name;
        const deletedQuizCount = this.currentCollection.quizzes?.length || 0;
        
        this.collections = this.collections.filter(c => c.id !== this.currentCollection.id);
        this.currentCollection = this.collections.length > 0 ? this.collections[0] : null;
        
        console.log(`🗑️ 問題集を削除: "${deletedName}" (${deletedQuizCount}問)`);
        
        this.updateUI();
        this.saveToLocalStorage();
    }

    selectCollection(collectionId) {
        this.currentCollection = this.collections.find(c => c.id === collectionId) || null;
        this.currentQuiz = null;
        this.updateQuizList();
    }

    startQuizFromCollection() {
        if (!this.currentCollection) {
            alert('問題集を選択してください');
            return;
        }

        // 出題タブに切り替え
        this.switchTab('quiz');

        // すべてのチェックボックスを外す
        const checkboxes = document.querySelectorAll('#quizCollectionCheckboxes input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = false);

        // 現在の問題集だけをチェック
        const targetCheckbox = Array.from(checkboxes).find(cb => cb.value === this.currentCollection.id);
        if (targetCheckbox) {
            targetCheckbox.checked = true;
        }

        // 出題を開始
        this.startQuizMode();
    }

    // ================== 問題管理 ==================
    newQuiz() {
        if (!this.currentCollection) {
            alert('問題集を選択してください');
            return;
        }

        this.currentQuiz = null;
        this.clearEditForm();
        this.switchTab('edit');
    }

    deleteQuiz() {
        if (!this.currentQuiz || !this.currentCollection) {
        const deletedQuestion = this.currentQuiz.question.substring(0, 30);
        
        this.currentCollection.quizzes = this.currentCollection.quizzes.filter(q => q.id !== this.currentQuiz.id);
        this.currentQuiz = null;
        
        console.log(`🗑️ 問題を削除: "${deletedQuestion}..." (問題集: ${this.currentCollection.name})`);
        
        }

        if (!confirm('この問題を削除しますか？')) return;

        this.currentCollection.quizzes = this.currentCollection.quizzes.filter(q => q.id !== this.currentQuiz.id);
        this.currentQuiz = null;
        this.updateQuizList();
        this.saveToLocalStorage();
    }

    saveQuiz() {
        if (!this.currentCollection) {
            alert('問題集を選択してください');
            return;
        }

        const question = document.getElementById('questionInput').value.trim();
        const answer = document.getElementById('answerInput').value.trim();

        if (!question || !answer) {
            alert('問題文と答えは必須です');
            return;
        }

        const tags = document.getElementById('tagsInput').value
            .split(',')
            .map(t => t.trim())
            .filter(t => t);

        const quiz = {
            id: this.currentQuiz ? this.currentQuiz.id : Date.now().toString(),
            question: question,
            answer: answer,
            memo: document.getElementById('memoInput').value.trim(),
            genre: document.getElementById('genreSelect').value,
            difficulty: parseInt(document.getElementById('difficultySelect').value),
            tags: tags,
            created_at: this.currentQuiz ? this.currentQuiz.created_at : new Date().toISOString()
        };

        let currentIndex = -1;

        if (this.currentQuiz) {
            // 更新
            currentIndex = this.currentCollection.quizzes.findIndex(q => q.id === this.currentQuiz.id);
            this.currentCollection.quizzes[currentIndex] = quiz;
        } else {
            // 新規
            this.currentCollection.quizzes.push(quiz);
            currentIndex = this.currentCollection.quizzes.length - 1;
        }

        // 保存した問題を履歴に追加（問題集IDと問題IDのペアで保存）
        this.editHistory.push({
            collectionId: this.currentCollection.id,
            quizId: quiz.id
        });

        this.currentQuiz = quiz;
        this.updateQuizList();
        
        // ログ出力
        console.log(`💾 問題を保存: "${quiz.question.substring(0, 30)}..." (ID: ${quiz.id}, 問題集: ${this.currentCollection.name})`);
        
        this.saveToLocalStorage();

        // 次の問題に移動または新規問題作成
        this.moveToNextQuizForEdit(currentIndex);
    }

    moveToNextQuizForEdit(currentIndex) {
        // 次の問題があれば次の問題へ、なければ新規問題作成画面へ
        if (currentIndex < this.currentCollection.quizzes.length - 1) {
            // 次の問題を編集
            const nextQuiz = this.currentCollection.quizzes[currentIndex + 1];
            this.currentQuiz = nextQuiz;
            this.fillEditForm(nextQuiz);
        } else {
            // 末尾なので新規問題作成
            this.currentQuiz = null;
            this.clearEditForm();
        }
        // 編集タブにとどまる
    }

    cancelEdit() {
        this.switchTab('manage');
    }

    navigateToPreviousQuiz() {
        // 新規作成画面（currentQuizがnull）の場合は編集履歴から戻る
        if (!this.currentQuiz) {
            if (this.editHistory.length === 0) {
                alert('編集履歴がありません');
                return;
            }

            // 履歴から前の問題を取得（最後に保存した問題）
            const previousHistory = this.editHistory.pop();

            // 問題集を取得
            const collection = this.collections.find(c => c.id === previousHistory.collectionId);
            if (!collection) {
                alert('問題集が見つかりません');
                return;
            }

            // 問題を取得
            const quiz = collection.quizzes.find(q => q.id === previousHistory.quizId);
            if (!quiz) {
                alert('問題が見つかりません');
                return;
            }

            // 問題集と問題を設定
            this.currentCollection = collection;
            this.currentQuiz = quiz;
            this.fillEditForm(quiz);
            this.updateQuizList(); // 選択状態を更新
            return;
        }

        // 既存の問題を編集中の場合は問題集内を循環
        if (!this.currentCollection || this.currentCollection.quizzes.length === 0) {
            alert('問題集に問題がありません');
            return;
        }

        // 現在の問題のインデックスを取得
        const currentIndex = this.currentCollection.quizzes.findIndex(q => q.id === this.currentQuiz.id);

        // 前の問題に移動（循環）
        let prevIndex;
        if (currentIndex > 0) {
            prevIndex = currentIndex - 1;
        } else {
            // 1問目の場合は最後の問題へ
            prevIndex = this.currentCollection.quizzes.length - 1;
        }

        const prevQuiz = this.currentCollection.quizzes[prevIndex];
        this.currentQuiz = prevQuiz;
        this.fillEditForm(prevQuiz);
        this.updateQuizList(); // 選択状態を更新
    }

    navigateToNextQuiz() {
        if (!this.currentCollection || this.currentCollection.quizzes.length === 0) {
            alert('問題集に問題がありません');
            return;
        }

        // 現在の問題のインデックスを取得
        let currentIndex = -1;
        if (this.currentQuiz) {
            currentIndex = this.currentCollection.quizzes.findIndex(q => q.id === this.currentQuiz.id);
        }

        // 次の問題に移動（循環）
        let nextIndex;
        if (currentIndex >= 0 && currentIndex < this.currentCollection.quizzes.length - 1) {
            nextIndex = currentIndex + 1;
        } else if (currentIndex === this.currentCollection.quizzes.length - 1) {
            // 最後の問題の場合は最初の問題へ
            nextIndex = 0;
        } else {
            // currentQuizがnullの場合、最初の問題に移動
            nextIndex = 0;
        }

        const nextQuiz = this.currentCollection.quizzes[nextIndex];
        this.currentQuiz = nextQuiz;
        this.fillEditForm(nextQuiz);
        this.updateQuizList(); // 選択状態を更新
    }

    selectQuizOnly(quizId) {
        if (!this.currentCollection) return;

        this.currentQuiz = this.currentCollection.quizzes.find(q => q.id === quizId) || null;
        this.updateQuizList();
    }

    selectQuiz(quizId) {
        if (!this.currentCollection) return;
        if (this.isViewMode) return; // 閲覧モードでは編集タブに遷移しない

        this.currentQuiz = this.currentCollection.quizzes.find(q => q.id === quizId) || null;

        if (this.currentQuiz) {
            this.fillEditForm(this.currentQuiz);
            this.switchTab('edit');
        }
    }

    // ================== フォーム操作 ==================
    clearEditForm() {
        document.getElementById('questionInput').value = '';
        document.getElementById('answerInput').value = '';
        document.getElementById('memoInput').value = '';
        document.getElementById('genreSelect').value = 'ノンジャンル';
        document.getElementById('difficultySelect').value = '2';
        document.getElementById('tagsInput').value = '';
    }

    fillEditForm(quiz) {
        document.getElementById('questionInput').value = quiz.question;
        document.getElementById('answerInput').value = quiz.answer;
        document.getElementById('memoInput').value = quiz.memo || '';
        document.getElementById('genreSelect').value = quiz.genre || 'ノンジャンル';
        document.getElementById('difficultySelect').value = quiz.difficulty || 2;
        document.getElementById('tagsInput').value = quiz.tags ? quiz.tags.join(', ') : '';
    }

    // ================== テキスト装飾 ==================
    addRuby() {
        const textarea = document.getElementById('questionInput');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;

        if (start === end) {
            alert('ふりがなを付けたい漢字を選択してください');
            return;
        }

        const selectedText = textarea.value.substring(start, end);
        const ruby = prompt('ふりがなを入力してください:');

        if (ruby) {
            const rubyText = `${selectedText}(${ruby})`;
            textarea.value = textarea.value.substring(0, start) + rubyText + textarea.value.substring(end);
        }
    }

    addColor() {
        const textarea = document.getElementById('questionInput');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;

        if (start === end) {
            alert('色を付けたいテキストを選択してください');
            return;
        }

        const selectedText = textarea.value.substring(start, end);
        const coloredText = `<color>${selectedText}</color>`;
        textarea.value = textarea.value.substring(0, start) + coloredText + textarea.value.substring(end);
    }

    // ================== UI更新 ==================
    updateUI() {
        this.updateCollectionList();
        this.updateQuizList();
        this.updateGenreFilters();
        this.updateQuizCollectionCheckboxes();
        this.updateMoveCollectionSelects();
    }

    updateCollectionList() {
        const select = document.getElementById('collectionList');
        select.innerHTML = '';

        this.collections.forEach(collection => {
            const option = document.createElement('option');
            option.value = collection.id;
            option.textContent = `${collection.name} (${collection.quizzes.length}問)`;
            if (this.currentCollection && collection.id === this.currentCollection.id) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    updateQuizList() {
        this.filterQuizzes();
    }

    filterQuizzes() {
        if (!this.currentCollection) {
            document.getElementById('quizList').innerHTML = '<p style="padding:20px;">問題集を選択してください</p>';
            return;
        }

        const searchText = document.getElementById('searchBox').value.toLowerCase();
        const genreFilter = document.getElementById('genreFilter').value;
        const difficultyFilter = document.getElementById('difficultyFilter').value;

        let quizzes = this.currentCollection.quizzes.filter(quiz => {
            const matchSearch = !searchText ||
                quiz.question.toLowerCase().includes(searchText) ||
                quiz.answer.toLowerCase().includes(searchText);

            const matchGenre = !genreFilter || quiz.genre === genreFilter;
            const matchDifficulty = !difficultyFilter || quiz.difficulty === parseInt(difficultyFilter);

            return matchSearch && matchGenre && matchDifficulty;
        });

        const container = document.getElementById('quizList');
        container.innerHTML = '';

        if (quizzes.length === 0) {
            container.innerHTML = '<p style="padding:20px;">問題がありません</p>';
            return;
        }

        quizzes.forEach((quiz, index) => {
            const item = document.createElement('div');
            item.className = 'quiz-item';
            item.dataset.genre = quiz.genre;
            item.dataset.quizId = quiz.id;
            item.dataset.quizIndex = index; // インデックスを保存
            item.draggable = true; // ドラッグ可能にする

            if (this.currentQuiz && quiz.id === this.currentQuiz.id) {
                item.classList.add('selected');
            }

            const questionDiv = document.createElement('div');
            questionDiv.className = 'quiz-item-question';
            questionDiv.textContent = this.stripFormatting(quiz.question);

            const answerDiv = document.createElement('div');
            answerDiv.className = 'quiz-item-answer';
            answerDiv.textContent = `答: ${this.stripFormatting(quiz.answer)}`;

            const tagsDiv = document.createElement('div');
            tagsDiv.className = 'quiz-item-tags';

            const genreTag = document.createElement('span');
            genreTag.className = 'tag';
            genreTag.textContent = quiz.genre;
            tagsDiv.appendChild(genreTag);

            const difficultyTag = document.createElement('span');
            difficultyTag.className = 'tag';
            difficultyTag.textContent = ['易', '中', '難'][quiz.difficulty - 1];
            tagsDiv.appendChild(difficultyTag);

            if (quiz.tags) {
                quiz.tags.forEach(tag => {
                    const tagSpan = document.createElement('span');
                    tagSpan.className = 'tag';
                    tagSpan.textContent = tag;
                    tagsDiv.appendChild(tagSpan);
                });
            }

            // 矢印ボタンを追加
            const controlsDiv = document.createElement('div');
            controlsDiv.className = 'quiz-item-controls';

            const upBtn = document.createElement('button');
            upBtn.innerHTML = '▲';
            upBtn.title = '上に移動';
            upBtn.disabled = index === 0;
            upBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.moveQuizUp(quiz.id);
            });

            const downBtn = document.createElement('button');
            downBtn.innerHTML = '▼';
            downBtn.title = '下に移動';
            downBtn.disabled = index === quizzes.length - 1;
            downBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.moveQuizDown(quiz.id);
            });

            controlsDiv.appendChild(upBtn);
            controlsDiv.appendChild(downBtn);

            item.appendChild(questionDiv);
            item.appendChild(answerDiv);
            item.appendChild(tagsDiv);
            item.appendChild(controlsDiv);

            // ドラッグ&ドロップイベント
            item.addEventListener('dragstart', (e) => this.handleDragStart(e));
            item.addEventListener('dragover', (e) => this.handleDragOver(e));
            item.addEventListener('drop', (e) => this.handleDrop(e));
            item.addEventListener('dragenter', (e) => this.handleDragEnter(e));
            item.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            item.addEventListener('dragend', (e) => this.handleDragEnd(e));

            // シングルクリックで選択、ダブルクリックで編集
            item.addEventListener('click', () => this.selectQuizOnly(quiz.id));
            item.addEventListener('dblclick', () => this.selectQuiz(quiz.id));
            container.appendChild(item);
        });
    }

    updateGenreFilters() {
        const genres = ['アニメ&ゲーム', 'スポーツ', '芸能', 'ライフスタイル', '社会', '文系学問', '理系学問', 'ノンジャンル'];

        // 管理画面のフィルター
        const genreFilter = document.getElementById('genreFilter');
        genreFilter.innerHTML = '<option value="">全ジャンル</option>';
        genres.forEach(genre => {
            const option = document.createElement('option');
            option.value = genre;
            option.textContent = genre;
            genreFilter.appendChild(option);
        });

        // 出題画面のフィルター
        const quizGenreFilter = document.getElementById('quizGenreFilter');
        quizGenreFilter.innerHTML = '<option value="">全て</option>';
        genres.forEach(genre => {
            const option = document.createElement('option');
            option.value = genre;
            option.textContent = genre;
            quizGenreFilter.appendChild(option);
        });
    }

    updateQuizCollectionCheckboxes() {
        const container = document.getElementById('quizCollectionCheckboxes');
        container.innerHTML = '';

        if (this.collections.length === 0) {
            container.innerHTML = '<p>問題集がありません</p>';
            return;
        }

        this.collections.forEach(collection => {
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = collection.id;
            checkbox.checked = true;

            const textSpan = document.createElement('span');
            textSpan.textContent = `${collection.name} (${collection.quizzes.length}問)`;

            label.appendChild(checkbox);
            label.appendChild(textSpan);
            container.appendChild(label);
        });
    }

    // ================== 出題機能 ==================
    startQuizMode() {
        // 選択された問題集から問題を集める
        const checkboxes = document.querySelectorAll('#quizCollectionCheckboxes input[type="checkbox"]:checked');

        if (checkboxes.length === 0) {
            alert('出題する問題集を選択してください');
            return;
        }

        let quizzes = [];
        checkboxes.forEach(checkbox => {
            const collection = this.collections.find(c => c.id === checkbox.value);
            if (collection) {
                // ディープコピーして元のデータに影響しないようにする
                quizzes = quizzes.concat(collection.quizzes.map(q => ({...q})));
            }
        });

        // フィルター適用
        const genreFilter = document.getElementById('quizGenreFilter').value;
        const difficultyFilter = document.getElementById('quizDifficultyFilter').value;

        if (genreFilter) {
            quizzes = quizzes.filter(q => q.genre === genreFilter);
        }
        if (difficultyFilter) {
            quizzes = quizzes.filter(q => q.difficulty === parseInt(difficultyFilter));
        }

        if (quizzes.length === 0) {
            alert('条件に合う問題がありません');
            return;
        }

        // シャッフルしない（順番のまま）

        this.quizMode.active = true;
        this.quizMode.quizzes = quizzes;
        this.quizMode.currentIndex = 0;

        document.getElementById('quizFilters').style.display = 'none';
        document.getElementById('startQuizBtn').style.display = 'none';
        document.getElementById('endQuizBtn').style.display = 'inline-block';
        document.getElementById('quizDisplay').style.display = 'block';

        this.displayCurrentQuiz();
    }

    endQuizMode() {
        this.quizMode.active = false;
        this.quizMode.quizzes = [];
        this.quizMode.currentIndex = 0;

        document.getElementById('quizFilters').style.display = 'block';
        document.getElementById('startQuizBtn').style.display = 'inline-block';
        document.getElementById('endQuizBtn').style.display = 'none';
        document.getElementById('quizDisplay').style.display = 'none';
    }

    displayCurrentQuiz() {
        if (!this.quizMode.active || this.quizMode.quizzes.length === 0) return;

        const quiz = this.quizMode.quizzes[this.quizMode.currentIndex];

        // カウンター更新
        document.getElementById('quizCounter').textContent =
            `${this.quizMode.currentIndex + 1} / ${this.quizMode.quizzes.length}`;

        // ジャンルタグ
        const genreTag = document.getElementById('quizGenreTag');
        genreTag.textContent = quiz.genre;
        genreTag.style.backgroundColor = this.getGenreColor(quiz.genre);

        // 難易度タグ
        const difficultyTag = document.getElementById('quizDifficultyTag');
        difficultyTag.textContent = ['易', '中', '難'][quiz.difficulty - 1];

        // 問題文表示
        document.getElementById('questionDisplay').innerHTML = this.formatText(quiz.question);

        // 答え表示
        document.getElementById('answerText').innerHTML = this.formatText(quiz.answer);

        // メモ表示
        const memoText = document.getElementById('memoText');
        const memoDisplay = document.getElementById('memoDisplay');
        if (quiz.memo && quiz.memo.trim()) {
            memoText.textContent = quiz.memo;
            memoDisplay.style.display = 'block';
        } else {
            memoDisplay.style.display = 'none';
        }

        // 答えの表示状態を記憶された状態に設定
        const answerDisplay = document.getElementById('answerDisplay');
        const toggleBtn = document.getElementById('toggleAnswerBtn');

        if (this.quizMode.answerVisible) {
            answerDisplay.style.display = 'block';
            toggleBtn.textContent = '答えを隠す';
        } else {
            answerDisplay.style.display = 'none';
            toggleBtn.textContent = '答えを表示';
        }
    }

    previousQuiz() {
        if (this.quizMode.currentIndex > 0) {
            this.quizMode.currentIndex--;
            this.displayCurrentQuiz();
        }
    }

    nextQuiz() {
        if (this.quizMode.currentIndex < this.quizMode.quizzes.length - 1) {
            this.quizMode.currentIndex++;
            this.displayCurrentQuiz();
        }
    }

    randomQuiz() {
        // 問題リストをシャッフル
        this.quizMode.quizzes = this.shuffleArray(this.quizMode.quizzes);
        // 先頭から表示
        this.quizMode.currentIndex = 0;
        this.displayCurrentQuiz();
    }

    toggleAnswer() {
        const answerDisplay = document.getElementById('answerDisplay');
        const btn = document.getElementById('toggleAnswerBtn');

        // 表示状態を切り替えて記憶
        this.quizMode.answerVisible = !this.quizMode.answerVisible;

        if (this.quizMode.answerVisible) {
            answerDisplay.style.display = 'block';
            btn.textContent = '答えを隠す';
        } else {
            answerDisplay.style.display = 'none';
            btn.textContent = '答えを表示';
        }
    }

    // ================== テキスト整形 ==================
    formatText(text) {
        // ふりがな処理: 漢字(かんじ) → <ruby>漢字<rt>かんじ</rt></ruby>
        text = text.replace(/([一-龯々]+)\(([ぁ-んー]+)\)/g, '<ruby>$1<rt>$2</rt></ruby>');

        // 色付き処理: <color>テキスト</color> → <span class="colored-text">テキスト</span>
        text = text.replace(/<color>(.*?)<\/color>/g, '<span class="colored-text">$1</span>');

        return text;
    }

    stripFormatting(text) {
        // フォーマットを削除してプレーンテキストに
        return text
            .replace(/([一-龯々]+)\(([ぁ-んー]+)\)/g, '$1')
            .replace(/<color>(.*?)<\/color>/g, '$1');
    }

    // ================== ユーティリティ ==================
    getGenreColor(genre) {
        const colors = {
            'アニメ&ゲーム': '#B3D9FF',
            'スポーツ': '#FFB3B3',
            '芸能': '#B3FFB3',
            'ライフスタイル': '#FFF8B3',
            '社会': '#FFD9B3',
            '文系学問': '#D9B3FF',
            '理系学問': '#FFB3E6',
            'ノンジャンル': '#F5F5F5'
        };
        return colors[genre] || colors['ノンジャンル'];
    }

    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    // ================== 候補リスト管理 ==================
    addCandidate() {
        const textInput = document.getElementById('newCandidateInput');
        const memoInput = document.getElementById('candidateMemoInput');
        const text = textInput.value.trim();
        const memo = memoInput.value.trim();

        if (!text) return;

        // 既存の候補テキストと重複していないかチェック
        const exists = this.candidates.some(c => c.text === text);
        if (!exists) {
            this.candidates.push({
                text: text,
                memo: memo,
                created_at: new Date().toISOString()
            });
            this.updateCandidatesUI();
            this.saveToLocalStorage();
        }

        textInput.value = '';
        memoInput.value = '';
        textInput.focus();
    }

    removeCandidate(candidateText) {
        this.candidates = this.candidates.filter(c => c.text !== candidateText);
        this.updateCandidatesUI();
        this.saveToLocalStorage();
    }

    clearCandidates() {
        if (!confirm('候補リストを全て削除しますか?')) return;

        this.candidates = [];
        this.updateCandidatesUI();
        this.saveToLocalStorage();
    }

    updateCandidatesUI() {
        // 候補タブのグリッド表示
        const grid = document.getElementById('candidatesGrid');
        grid.innerHTML = '';

        if (this.candidates.length === 0) {
            grid.innerHTML = '<p style="padding: 20px; text-align: center; color: #666;">候補がありません</p>';
            this.updateCandidatesSidebar();
            return;
        }

        this.candidates.forEach(candidate => {
            const item = document.createElement('div');
            item.className = 'candidate-item';

            const contentDiv = document.createElement('div');
            contentDiv.className = 'candidate-content';

            const text = document.createElement('div');
            text.className = 'candidate-text';
            text.textContent = candidate.text;

            contentDiv.appendChild(text);

            if (candidate.memo) {
                const memo = document.createElement('div');
                memo.className = 'candidate-memo';
                memo.textContent = candidate.memo;
                contentDiv.appendChild(memo);
            }

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-small btn-danger';
            deleteBtn.textContent = '×';
            deleteBtn.onclick = () => this.removeCandidate(candidate.text);

            item.appendChild(contentDiv);
            item.appendChild(deleteBtn);
            grid.appendChild(item);
        });

        // サイドバーも更新
        this.updateCandidatesSidebar();
    }

    updateCandidatesSidebar() {
        const list = document.getElementById('candidatesList');
        list.innerHTML = '';

        if (this.candidates.length === 0) {
            list.innerHTML = '<p style="padding: 10px; text-align: center; color: #666;">候補がありません</p>';
            return;
        }

        this.candidates.forEach(candidate => {
            const item = document.createElement('div');
            item.className = 'candidate-sidebar-item';

            const text = document.createElement('div');
            text.className = 'candidate-sidebar-text';
            text.textContent = candidate.text;
            item.appendChild(text);

            if (candidate.memo) {
                const memo = document.createElement('div');
                memo.className = 'candidate-sidebar-memo';
                memo.textContent = candidate.memo;
                item.appendChild(memo);
            }

            item.onclick = () => {
                // 問題文の末尾に追加
                const input = document.getElementById('questionInput');
                input.value += (input.value ? ' ' : '') + candidate.text;
                input.focus();

                // 候補リストから削除するか確認
                if (confirm(`「${candidate.text}」を候補リストから削除しますか？`)) {
                    this.removeCandidate(candidate.text);
                }
            };
            list.appendChild(item);
        });
    }

    toggleCandidatesSidebar() {
        const sidebar = document.getElementById('candidatesSidebar');
        const isVisible = sidebar.style.display !== 'none';
        sidebar.style.display = isVisible ? 'none' : 'block';

        if (!isVisible) {
            this.updateCandidatesSidebar();
        }
    }

    // ================== ドラッグ&ドロップで順番変更 ==================
    handleDragStart(e) {
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', e.target.innerHTML);
        this.draggedQuizId = e.target.dataset.quizId;
        console.log('👆 ドラッグ開始:', e.target.dataset.quizId);
    }

    handleDragOver(e) {
        if (e.preventDefault) {
            e.preventDefault(); // ドロップを許可
        }
        e.dataTransfer.dropEffect = 'move';
        return false;
    }

    handleDragEnter(e) {
        if (e.target.classList.contains('quiz-item')) {
            e.target.classList.add('drag-over');
        }
    }

    handleDragLeave(e) {
        if (e.target.classList.contains('quiz-item')) {
            e.target.classList.remove('drag-over');
        }
    }

    handleDrop(e) {
        if (e.stopPropagation) {
            e.stopPropagation(); // ブラウザのデフォルト動作を停止
        }

        const dropTarget = e.target.closest('.quiz-item');
        if (!dropTarget) return false;

        const draggedId = this.draggedQuizId;
        const targetId = dropTarget.dataset.quizId;

        if (draggedId !== targetId) {
            this.insertQuiz(draggedId, targetId);
        }

        dropTarget.classList.remove('drag-over');
        return false;
    }

    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        // 全てのdrag-overクラスを削除
        document.querySelectorAll('.quiz-item').forEach(item => {
            item.classList.remove('drag-over');
        });
    }

    insertQuiz(draggedId, targetId) {
        if (!this.currentCollection) return;

        const draggedIndex = this.currentCollection.quizzes.findIndex(q => q.id === draggedId);
        const targetIndex = this.currentCollection.quizzes.findIndex(q => q.id === targetId);

        if (draggedIndex === -1 || targetIndex === -1) return;

        // ドラッグした問題を削除
        const [draggedQuiz] = this.currentCollection.quizzes.splice(draggedIndex, 1);
        
        // 新しいターゲットインデックスを計算（削除によってインデックスがずれる可能性がある）
        const newTargetIndex = draggedIndex < targetIndex ? targetIndex : targetIndex;
        
        // ターゲット位置に挿入
        this.currentCollection.quizzes.splice(newTargetIndex, 0, draggedQuiz);

        console.log(`🔄 問題を挿入: ${draggedIndex + 1} → ${newTargetIndex + 1}`);
        
        this.updateQuizList();
        this.saveToLocalStorage();
    }

    // ================== 問題の順番入れ替え（ボタン） ==================
    moveQuizUp(quizId) {
        if (!this.currentCollection) return;

        const index = this.currentCollection.quizzes.findIndex(q => q.id === quizId);
        if (index <= 0) return; // 最初の要素または見つからない

        // 配列の要素を入れ替え
        [this.currentCollection.quizzes[index - 1], this.currentCollection.quizzes[index]] = 
        [this.currentCollection.quizzes[index], this.currentCollection.quizzes[index - 1]];

        console.log(`⬆️ 問題を上に移動: ${index + 1} → ${index}`);
        
        this.updateQuizList();
        this.saveToLocalStorage();
    }

    moveQuizDown(quizId) {
        if (!this.currentCollection) return;

        const index = this.currentCollection.quizzes.findIndex(q => q.id === quizId);
        if (index === -1 || index >= this.currentCollection.quizzes.length - 1) return; // 最後の要素または見つからない

        // 配列の要素を入れ替え
        [this.currentCollection.quizzes[index], this.currentCollection.quizzes[index + 1]] = 
        [this.currentCollection.quizzes[index + 1], this.currentCollection.quizzes[index]];

        console.log(`⬇️ 問題を下に移動: ${index + 1} → ${index + 2}`);
        
        this.updateQuizList();
        this.saveToLocalStorage();
    }

    // ================== データ保存・読み込み ==================
    // ================== クラウド同期（手動モード）==================
    async uploadToCloud() {
        if (!this.syncEnabled || !window.firebaseSync) return;
        
        const totalQuizzes = this.collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
        console.log(`📤 クラウドにアップロード中... (${this.collections.length}問題集, ${totalQuizzes}問)`);
        
        try {
            await window.firebaseSync.saveCollections(this.collections);
            console.log('✅ クラウドにアップロード成功');
            this.showNotification(`<strong>☁️ クラウドに保存しました</strong><br><small>${this.collections.length}問題集・${totalQuizzes}問を同期</small>`, 'success');
        } catch (err) {
            console.error('❌ クラウドアップロードエラー:', err);
            this.showNotification(`<strong>⚠️ クラウド保存に失敗</strong><br><small>${err.message}</small>`, 'error');
        }
    }

    async downloadFromCloud() {
        if (!this.syncEnabled || !window.firebaseSync) {
            alert('クラウド同期が有効になっていません');
            return;
        }
        
        const confirmDownload = confirm(
            '☁️ クラウドからデータをダウンロードしますか？\n\n' +
            '⚠️ ローカルの変更は上書きされます。\n' +
            '(保存していない変更はクラウドにアップロードされません)'
        );
        
        if (!confirmDownload) return;
        
        console.log('📥 クラウドからダウンロード中...');
        this.showSyncOverlay('📥 ダウンロード中...', 'クラウドからデータを取得しています');
        
        try {
            const firestoreData = await window.firebaseSync.loadCollections();
            
            if (firestoreData && firestoreData.length > 0) {
                const totalQuizzes = firestoreData.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
                this.updateSyncOverlay('✅ データを反映中...', `${firestoreData.length} 問題集・${totalQuizzes} 問をダウンロードしました`);
                this.isLoadingFromFirestore = true;
                this.collections = firestoreData;
                if (this.collections.length > 0) {
                    this.currentCollection = this.collections[0];
                }
                this.updateUI();
                this.saveToLocalStorage();
                this.isLoadingFromFirestore = false;
                
                await new Promise(r => setTimeout(r, 500));
                this.hideSyncOverlay();
                this.showNotification(
                    `<strong>☁️ クラウドから取得しました</strong><br><small>${this.collections.length}問題集・${totalQuizzes}問をダウンロード</small>`,
                    'success'
                );
            } else {
                this.hideSyncOverlay();
                alert('クラウドにデータが見つかりませんでした');
            }
        } catch (err) {
            this.hideSyncOverlay();
            console.error('❌ クラウドダウンロードエラー:', err);
            this.showNotification(`<strong>⚠️ ダウンロードに失敗</strong><br><small>${err.message}</small>`, 'error');
        }
    }

    // ================== データ保存・読み込み ==================

    showNotification(message, type = 'success') {
        const notification = document.createElement('div');
        notification.className = 'copy-notification';
        
        const colors = {
            success: '#4CAF50',
            info: '#2196F3',
            warning: '#FF9800',
            error: '#f44336'
        };
        
        notification.innerHTML = `
            <div style="background: ${colors[type]}; color: white; padding: 15px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 400px;">
                ${message}
            </div>
        `;
        notification.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 10000; animation: slideIn 0.3s;';
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    saveToLocalStorage() {
        if (this.isViewMode) return; // 閲覧モードではlocalStorageに書き込まない
        try {
            const data = {
                collections: this.collections,
                candidates: this.candidates,
                settings: this.settings,
                saved_at: new Date().toISOString()
            };
            
            const jsonData = JSON.stringify(data);
            const dataSize = new Blob([jsonData]).size;
            const dataSizeMB = (dataSize / 1024 / 1024).toFixed(2);
            
            // LocalStorageの容量チェック（通常5-10MBが上限）
            if (dataSize > 4.5 * 1024 * 1024) {
                console.warn(`⚠️ データサイズが大きいです: ${dataSizeMB}MB`);
                console.warn('問題集が多すぎる場合、一部を別ファイルに保存することを推奨します');
            }
            
            localStorage.setItem('quizManagerData', jsonData);
            console.log(`✅ ローカルストレージに保存成功 (${dataSizeMB}MB, ${this.collections.length}問題集, ${this.collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0)}問)`);

            // Firestoreにも同期（同期が有効な場合）- 即座にアップロード
            if (this.syncEnabled && window.firebaseSync && !this.isLoadingFromFirestore) {
                this.uploadToCloud();
            }
        } catch (error) {
            console.error('❌ ローカルストレージへの保存に失敗:', error);
            
            if (error.name === 'QuotaExceededError') {
                alert(
                    '⚠️ データ容量の上限に達しました\n\n' +
                    '対処方法：\n' +
                    '1. 不要な問題集を削除する\n' +
                    '2. データをJSONファイルにエクスポートしてバックアップ\n' +
                    '3. 問題集を複数のファイルに分割する'
                );
            } else {
                alert('データの保存に失敗しました: ' + error.message);
            }
        }
    }

    loadFromLocalStorage() {
        if (this.isViewMode) return; // 閲覧モードではlocalStorageを読まない
        const data = localStorage.getItem('quizManagerData');
        if (data) {
            try {
                const parsed = JSON.parse(data);
                
                // データの整合性チェック
                if (!parsed.collections || !Array.isArray(parsed.collections)) {
                    console.warn('⚠️ データ形式が不正です。初期化します。');
                    this.collections = [];
                } else {
                    this.collections = parsed.collections;
                    
                    // 各問題集のquizzesが配列であることを確認
                    this.collections.forEach(col => {
                        if (!col.quizzes || !Array.isArray(col.quizzes)) {
                            console.warn(`⚠️ 問題集「${col.name}」のデータが不正です。修復します。`);
                            col.quizzes = [];
                        }
                    });
                }

                // 旧形式（文字列配列）を新形式（オブジェクト配列）に変換
                this.candidates = (parsed.candidates || []).map(c => {
                    if (typeof c === 'string') {
                        return { text: c, memo: '', created_at: new Date().toISOString() };
                    }
                    return c;
                });

                this.settings = parsed.settings || this.settings;

                if (this.collections.length > 0) {
                    this.currentCollection = this.collections[0];
                }

                this.updateCandidatesUI();
                
                const totalQuizzes = this.collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
                console.log(`✅ ローカルストレージから読み込み成功 (${this.collections.length}問題集, ${totalQuizzes}問${parsed.saved_at ? ', 保存: ' + new Date(parsed.saved_at).toLocaleString('ja-JP') : ''})`);
            } catch (e) {
                console.error('❌ データの読み込みに失敗しました:', e);
                alert(
                    '⚠️ データの読み込みに失敗しました\n\n' +
                    'ブラウザのデータが破損している可能性があります。\n' +
                    '設定タブから「全データをクリア」を実行するか、\n' +
                    'バックアップファイルから読み込んでください。'
                );
            }
        } else {
            console.log('ℹ️ 保存されたデータがありません。新規スタートです。');
        }

        // 同期状態を復元
        const syncState = localStorage.getItem('quizbook_sync_enabled');
        if (syncState === 'true') {
            this.enableSyncSilently();
        }
    }

    saveToFile() {
        const data = {
            collections: this.collections,
            saved_at: new Date().toISOString()
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quiz_collections_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    loadFromFile() {
        document.getElementById('fileInput').click();
    }

    handleFileLoad(event) {
        const file = event.target.files[0];
        if (!file) return;

        console.log(`📂 ファイルを読み込み中: ${file.name} (${(file.size / 1024).toFixed(2)}KB)`);

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);

                // データ形式の判定と正規化
                let collections = [];

                if (data.collections && Array.isArray(data.collections)) {
                    // 形式1: { collections: [...] }
                    collections = data.collections;
                    console.log('✅ 形式1を検出: { collections: [...] }');
                } else if (data.name && data.quizzes) {
                    // 形式2: 単一の問題集 { name: "...", quizzes: [...] }
                    collections = [data];
                    console.log('✅ 形式2を検出: 単一の問題集');
                } else if (Array.isArray(data)) {
                    // 形式3: 問題集の配列 [...]
                    collections = data;
                    console.log('✅ 形式3を検出: 問題集の配列');
                } else {
                    throw new Error('サポートされていないファイル形式です');
                }

                // データの正規化（Python版との互換性のため）
                collections.forEach(col => {
                    // IDがない場合は生成
                    if (!col.id) {
                        col.id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
                    }

                    // quizzesが存在するか確認
                    if (!col.quizzes || !Array.isArray(col.quizzes)) {
                        col.quizzes = [];
                    }

                    // 各問題のデータを正規化
                    col.quizzes.forEach(quiz => {
                        if (!quiz.id) {
                            quiz.id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
                        }

                        // difficultyを整数に変換（1.5 -> 2, 2.5 -> 3, 3.0 -> 3, 4.5 -> 5 -> 3など）
                        if (typeof quiz.difficulty === 'number') {
                            quiz.difficulty = Math.round(quiz.difficulty);
                            if (quiz.difficulty < 1) quiz.difficulty = 1;
                            if (quiz.difficulty > 3) quiz.difficulty = 3;
                        } else {
                            quiz.difficulty = 2; // デフォルト
                        }

                        // その他のフィールドの初期化
                        if (!quiz.memo) quiz.memo = '';
                        if (!quiz.genre) quiz.genre = 'ノンジャンル';
                        if (!quiz.tags) quiz.tags = [];
                        if (!Array.isArray(quiz.tags)) quiz.tags = [];
                    });
                });

                if (confirm('既存のデータを上書きしますか？（キャンセルで追加モード）')) {
                    this.collections = collections;
                    console.log('📝 上書きモード: 既存データを置換');
                } else {
                    // 追加モード
                    this.collections = this.collections.concat(collections);
                    console.log('➕ 追加モード: 既存データに追加');
                }

                if (this.collections.length > 0) {
                    this.currentCollection = this.collections[0];
                }

                const totalQuizzes = collections.reduce((sum, col) => sum + col.quizzes.length, 0);
                console.log(`✅ ファイル読み込み完了: ${collections.length}問題集, ${totalQuizzes}問`);

                this.updateUI();
                this.saveToLocalStorage();
                alert(`読み込みが完了しました（${collections.length}個の問題集、合計${totalQuizzes}問）`);
            } catch (err) {
                console.error('❌ ファイルの読み込みに失敗:', err);
                alert('ファイルの読み込みに失敗しました: ' + err.message);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    // ================== クラウド同期 ==================
    async toggleSync() {
        if (this.isViewMode) {
            await this.toggleViewModeSync();
            return;
        }
        if (this.syncEnabled) {
            // 同期を無効化
            const confirmDisable = confirm(
                '⚠️ クラウド同期をOFFにしますか？\n\n' +
                '同期コードは保持されますが、自動同期は停止します。\n' +
                '再度ONにすれば同じデータにアクセスできます。'
            );
            
            if (!confirmDisable) return;
            
            this.syncEnabled = false;
            if (window.firebaseSync) {
                window.firebaseSync.disableSync();
            }
            localStorage.setItem('quizbook_sync_enabled', 'false');
            this.updateSyncUI();
            alert('クラウド同期をOFFにしました\n\nデータはこのブラウザのみに保存されます。');
        } else {
            // 同期を有効化
            if (!window.firebaseSync) {
                alert('Firebase接続に失敗しました。ローカルモードで動作します。');
                return;
            }

            // 既存の同期コードを確認
            const existingCode = window.firebaseSync.getSyncCode();
            
            let syncCode;
            if (existingCode) {
                // 既存のコードがある場合
                const useExisting = confirm(
                    `📱 保存されている同期コードが見つかりました\n\n` +
                    `同期コード: ${existingCode}\n\n` +
                    `このコードで同期しますか？\n` +
                    `(キャンセル = 新しいコードを入力)`
                );
                
                if (useExisting) {
                    syncCode = existingCode;
                } else {
                    syncCode = await this.promptSyncCode();
                    if (!syncCode) return;
                }
            } else {
                // 新規の場合
                syncCode = await this.promptSyncCode();
                if (!syncCode) return;
            }

            // 同期コードを設定
            const result = window.firebaseSync.setSyncCode(syncCode);
            if (!result.success) {
                alert('エラー: ' + result.error);
                return;
            }

            const success = await window.firebaseSync.enableSync();
            if (!success) {
                alert('同期の有効化に失敗しました。');
                return;
            }

            this.syncEnabled = true;
            localStorage.setItem('quizbook_sync_enabled', 'true');

            // Firestoreからデータを読み込む
            this.showSyncOverlay('☁️ クラウドに接続中...', 'データを確認しています');
            const firestoreData = await window.firebaseSync.loadCollections();
            this.hideSyncOverlay();
            if (firestoreData && firestoreData.length > 0) {
                const useFirestore = confirm(
                    '☁️ クラウドにデータが見つかりました\n\n' +
                    `クラウド: ${firestoreData.length}個の問題集\n` +
                    `ローカル: ${this.collections.length}個の問題集\n\n` +
                    'クラウドのデータを使用しますか？\n(キャンセル = ローカルを優先してクラウドに上書き)'
                );

                if (useFirestore) {
                    this.isLoadingFromFirestore = true;
                    this.collections = firestoreData;
                    if (this.collections.length > 0) {
                        this.currentCollection = this.collections[0];
                    }
                    this.updateUI();
                    this.saveToLocalStorage();
                    this.isLoadingFromFirestore = false;
                }
            } else {
                // クラウドにデータがない場合、現在のデータをアップロード
                await window.firebaseSync.saveCollections(this.collections);
            }

            this.updateSyncUI();
            
            // 同期コードを表示
            alert(
                `✅ クラウド同期を有効にしました！\n\n` +
                `📱 同期コード: ${syncCode}\n\n` +
                `【同期の動作】\n` +
                `・保存時に自動的にクラウドにアップロード\n` +
                `・ダウンロードは「📥ダウンロード」ボタンを押す\n\n` +
                `他のデバイスでも同じコードを入力すると、\n` +
                `同じデータにアクセスできます。\n\n` +
                `💡 ヒント: 同期ボタンを長押しor右クリックで\n` +
                `コードを確認できます。`
            );
        }
    }

    async toggleViewModeSync() {
        if (this.syncEnabled) {
            // 同期を切断
            this.syncEnabled = false;
            if (window.firebaseSync) window.firebaseSync.disableSync();
            this.updateSyncUI();
            return;
        }

        if (!window.firebaseSync) {
            alert('Firebase接続に失敗しました。');
            return;
        }

        // 同期コードを入力させる（閲覧専用）
        const code = prompt('同期コードを入力してください（閲覧のみ・書き込みはしません）:');
        if (!code) return;

        const result = window.firebaseSync.setSyncCode(code);
        if (!result.success) {
            alert('エラー: ' + result.error);
            return;
        }

        const success = await window.firebaseSync.enableSync();
        if (!success) {
            alert('同期の有効化に失敗しました。');
            return;
        }

        this.syncEnabled = true;

        // Firestoreからデータを読み込む（書き込みはしない）
        const firestoreData = await window.firebaseSync.loadCollections();
        if (firestoreData && firestoreData.length > 0) {
            this.isLoadingFromFirestore = true;
            this.collections = firestoreData;
            this.currentCollection = this.collections[0];
            this.updateUI();
            this.isLoadingFromFirestore = false;
            console.log('✅ 閲覧モード: クラウドからデータを読み込みました（書き込みなし）');
        } else {
            alert('クラウドにデータが見つかりませんでした。');
            this.syncEnabled = false;
            window.firebaseSync.disableSync();
            this.updateSyncUI();
            return;
        }

        this.updateSyncUI();
    }

    async promptSyncCode() {
        const choice = confirm(
            '🔑 同期コードの設定\n\n' +
            '【OK】= 新しいコードを生成\n' +
            '【キャンセル】= 既存のコードを入力\n\n' +
            '※複数デバイスで同期する場合は、\n' +
            '  1台目で「生成」→ 2台目で「入力」'
        );

        if (choice) {
            // 新しいコードを生成
            const newCode = window.firebaseSync.generateSyncCode();
            alert(
                `🎉 同期コードを生成しました！\n\n` +
                `📱 同期コード: ${newCode}\n\n` +
                `このコードを他のデバイスで入力すると、\n` +
                `同じデータにアクセスできます。\n\n` +
                `⚠️ このコードを忘れないようにメモしてください！`
            );
            return newCode;
        } else {
            // 既存のコードを入力
            const code = prompt(
                '🔑 同期コードを入力してください\n\n' +
                '6桁の英数字（例: ABC123）'
            );
            
            if (!code) return null;
            
            const upperCode = code.toUpperCase().trim();
            if (!/^[A-Z0-9]{6}$/.test(upperCode)) {
                alert('❌ 同期コードは6桁の英数字である必要があります');
                return null;
            }
            
            return upperCode;
        }
    }

    showSyncCode() {
        const code = window.firebaseSync.getSyncCode();
        if (!code) {
            alert('同期コードが設定されていません。\n先に同期を有効にしてください。');
            return;
        }

        const copyToClipboard = confirm(
            `📱 現在の同期コード\n\n` +
            `${code}\n\n` +
            `OKを押すとクリップボードにコピーします`
        );

        if (copyToClipboard) {
            navigator.clipboard.writeText(code).then(() => {
                alert('✅ 同期コードをコピーしました！');
            }).catch(() => {
                alert(`同期コード: ${code}\n\n手動でコピーしてください。`);
            });
        }
    }

    showSyncOverlay(message, detail) {
        const overlay = document.getElementById('syncOverlay');
        const msgEl = document.getElementById('syncOverlayMessage');
        const detailEl = document.getElementById('syncOverlayDetail');
        if (overlay) {
            msgEl.textContent = message || 'クラウドと同期中...';
            detailEl.textContent = detail || '';
            overlay.style.display = 'flex';
            this._syncOverlayStart = Date.now();
        }
    }

    updateSyncOverlay(message, detail) {
        const msgEl = document.getElementById('syncOverlayMessage');
        const detailEl = document.getElementById('syncOverlayDetail');
        if (msgEl && message) msgEl.textContent = message;
        if (detailEl && detail !== undefined) detailEl.textContent = detail;
    }

    hideSyncOverlay() {
        const overlay = document.getElementById('syncOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    async enableSyncSilently() {
        if (!window.firebaseSync) return;

        this.showSyncOverlay('☁️ クラウドに接続中...', 'Firebase を初期化しています');

        const success = await window.firebaseSync.enableSync();
        if (!success) {
            this.hideSyncOverlay();
            return;
        }

        this.syncEnabled = true;

        this.updateSyncOverlay('📥 データをダウンロード中...', 'クラウドから最新のデータを取得しています');

        // 起動時にクラウドの最新データを明示的に取得してからUIを更新
        const firestoreData = await window.firebaseSync.loadCollections();
        if (firestoreData && firestoreData.length > 0) {
            const totalQuizzes = firestoreData.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
            this.updateSyncOverlay('✅ データを反映中...', `${firestoreData.length} 問題集・${totalQuizzes} 問を読み込みました`);

            this.isLoadingFromFirestore = true;
            this.collections = firestoreData;
            if (this.collections.length > 0) {
                this.currentCollection = this.collections[0];
            }
            this.updateUI();
            this.saveToLocalStorage();
            this.isLoadingFromFirestore = false;
            console.log('✅ 起動時にクラウドの最新データを読み込みました');
        }

        this.updateSyncUI();

        // 少し余韻を持たせて閉じる
        await new Promise(r => setTimeout(r, 500));
        this.hideSyncOverlay();
    }

    updateSyncUI() {
        const btn = document.getElementById('syncToggleBtn');
        const icon = document.getElementById('syncIcon');
        const status = document.getElementById('syncStatus');
        const downloadBtn = document.getElementById('cloudDownloadBtn');

        if (this.syncEnabled) {
            btn.classList.add('active');
            icon.textContent = '☁️';
            const syncCode = window.firebaseSync.getSyncCode();
            status.textContent = syncCode ? `同期ON (${syncCode})` : '同期ON';
            btn.title = syncCode 
                ? `クラウド同期ON\n同期コード: ${syncCode}\n\n右クリックまたは長押しでコードを表示`
                : 'クラウド同期ON';
            
            // ダウンロードボタンを表示
            if (downloadBtn) {
                downloadBtn.style.display = '';
            }
        } else {
            btn.classList.remove('active');
            icon.textContent = '☁️';
            status.textContent = '同期OFF';
            btn.title = 'クラウド同期OFF\nクリックで有効化';
            
            // ダウンロードボタンを非表示
            if (downloadBtn) {
                downloadBtn.style.display = 'none';
            }
        }
    }

    // ================== CSV操作 ==================
    importCsv() {
        document.getElementById('csvFileInput').click();
    }

    handleCsvImport(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const csv = e.target.result;
                const records = this.parseCsv(csv);

                // ヘッダーをスキップ
                const quizzes = [];
                for (let i = 1; i < records.length; i++) {
                    const parts = records[i];
                    if (parts.length >= 2 && parts[0]) {
                        const quiz = {
                            id: Date.now().toString() + i,
                            question: parts[0] || '',
                            answer: parts[1] || '',
                            memo: parts[2] || '',
                            genre: parts[3] || 'ノンジャンル',
                            difficulty: this.parseDifficulty(parts[4]) || 2,
                            tags: parts[5] ? parts[5].split(',').map(t => t.trim()).filter(t => t) : [],
                            created_at: new Date().toISOString()
                        };
                        quizzes.push(quiz);
                    }
                }

                if (quizzes.length === 0) {
                    alert('有効な問題が見つかりませんでした');
                    return;
                }

                const collectionName = prompt('問題集の名前を入力してください:', file.name.replace('.csv', ''));
                if (!collectionName) return;

                const collection = {
                    id: Date.now().toString(),
                    name: collectionName,
                    quizzes: quizzes,
                    created_at: new Date().toISOString()
                };

                this.collections.push(collection);
                this.currentCollection = collection;
                this.updateUI();
                this.saveToLocalStorage();
                alert(`${quizzes.length}問をインポートしました`);
            } catch (err) {
                console.error('❌ CSVインポートエラー:', err);
                alert('CSVの読み込みに失敗しました: ' + err.message);
            }
        };
        reader.readAsText(file, 'UTF-8');
        event.target.value = '';
    }

    exportCsv() {
        if (!this.currentCollection) {
            alert('エクスポートする問題集を選択してください');
            return;
        }

        let csv = '問題文,答え,メモ,ジャンル,難易度,タグ\n';

        this.currentCollection.quizzes.forEach(quiz => {
            const difficulty = ['易', '中', '難'][quiz.difficulty - 1];
            const tags = quiz.tags ? quiz.tags.join(', ') : '';

            csv += `"${this.escapeCsv(quiz.question)}","${this.escapeCsv(quiz.answer)}","${this.escapeCsv(quiz.memo)}","${quiz.genre}","${difficulty}","${tags}"\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.currentCollection.name}_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    parseCsv(csvText) {
        const records = [];
        let currentRecord = [];
        let currentField = '';
        let inQuotes = false;
        
        for (let i = 0; i < csvText.length; i++) {
            const char = csvText[i];
            const nextChar = csvText[i + 1];
            
            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    // エスケープされたダブルクォート
                    currentField += '"';
                    i++; // 次の文字をスキップ
                } else {
                    // クォートの開始または終了
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                // フィールドの終了
                currentRecord.push(currentField);
                currentField = '';
            } else if ((char === '\n' || char === '\r') && !inQuotes) {
                // レコードの終了
                if (char === '\r' && nextChar === '\n') {
                    i++; // \r\nの場合は\nをスキップ
                }
                if (currentField || currentRecord.length > 0) {
                    currentRecord.push(currentField);
                    records.push(currentRecord);
                    currentRecord = [];
                    currentField = '';
                }
            } else {
                // 通常の文字（改行を含む）
                currentField += char;
            }
        }
        
        // 最後のフィールドとレコードを追加
        if (currentField || currentRecord.length > 0) {
            currentRecord.push(currentField);
            records.push(currentRecord);
        }
        
        return records;
    }

    parseCsvLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }

        result.push(current.trim());
        return result;
    }

    parseDifficulty(text) {
        if (!text) return 2;
        text = text.trim();
        if (text === '易' || text === '1') return 1;
        if (text === '中' || text === '2') return 2;
        if (text === '難' || text === '3') return 3;
        return 2;
    }

    escapeCsv(text) {
        if (!text) return '';
        return text.replace(/"/g, '""');
    }

    // ================== 設定 ==================
    applySettings() {
        document.documentElement.style.setProperty('--base-font-size', `${this.settings.fontSize}px`);
        document.getElementById('fontSizeValue').textContent = this.settings.fontSize;
        document.getElementById('quizFontSizeValue').textContent = this.settings.quizFontSize;

        const questionDisplay = document.querySelector('.question-text');
        if (questionDisplay) {
            questionDisplay.style.fontSize = `${this.settings.quizFontSize}px`;
        }

        this.saveToLocalStorage();
    }

    // ================== 問題移動タブ ==================
    _moveState = {
        sourceId: null,
        destId: null,
        sourceSelected: new Set(),
        destSelected: new Set()
    };

    updateMoveCollectionSelects() {
        ['moveSourceCollection', 'moveDestCollection'].forEach(id => {
            const sel = document.getElementById(id);
            const current = sel.value;
            sel.innerHTML = '<option value="">問題集を選択...</option>';
            this.collections.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col.id;
                opt.textContent = `${col.name} (${col.quizzes.length}問)`;
                sel.appendChild(opt);
            });
            if (current) sel.value = current;
        });
        this.renderMoveList('source');
        this.renderMoveList('dest');
    }

    onMoveCollectionChange(side, colId) {
        if (side === 'source') {
            this._moveState.sourceId = colId || null;
            this._moveState.sourceSelected.clear();
        } else {
            this._moveState.destId = colId || null;
            this._moveState.destSelected.clear();
        }
        this.renderMoveList(side);
    }

    renderMoveList(side) {
        const isSource = side === 'source';
        const colId = isSource ? this._moveState.sourceId : this._moveState.destId;
        const selected = isSource ? this._moveState.sourceSelected : this._moveState.destSelected;
        const listEl = document.getElementById(isSource ? 'moveSourceList' : 'moveDestList');
        const countEl = document.getElementById(isSource ? 'moveSourceCount' : 'moveDestCount');
        const searchVal = document.getElementById(isSource ? 'moveSourceSearch' : 'moveDestSearch').value.toLowerCase();

        if (!colId) {
            listEl.innerHTML = '<p style="padding:16px;color:#999;">問題集を選択してください</p>';
            if (countEl) countEl.textContent = '';
            return;
        }

        const col = this.collections.find(c => c.id === colId);
        if (!col) return;

        const quizzes = col.quizzes.filter(q =>
            !searchVal ||
            q.question.toLowerCase().includes(searchVal) ||
            q.answer.toLowerCase().includes(searchVal)
        );

        if (countEl) countEl.textContent = `${col.quizzes.length}問`;

        listEl.innerHTML = '';
        if (quizzes.length === 0) {
            listEl.innerHTML = '<p style="padding:16px;color:#999;">問題がありません</p>';
            return;
        }

        let lastClickedIndex = null;
        quizzes.forEach((quiz, idx) => {
            const item = document.createElement('div');
            item.className = 'quiz-item' + (selected.has(quiz.id) ? ' selected' : '');
            item.innerHTML = `<div class="quiz-question">${quiz.question.substring(0, 60)}${quiz.question.length > 60 ? '…' : ''}</div>
                <div class="quiz-answer" style="font-size:12px;color:#666;">→ ${quiz.answer}</div>`;

            item.addEventListener('click', (e) => {
                if (e.shiftKey && lastClickedIndex !== null) {
                    // 範囲選択
                    const start = Math.min(lastClickedIndex, idx);
                    const end = Math.max(lastClickedIndex, idx);
                    for (let i = start; i <= end; i++) selected.add(quizzes[i].id);
                } else if (e.ctrlKey || e.metaKey) {
                    // 追加/解除
                    selected.has(quiz.id) ? selected.delete(quiz.id) : selected.add(quiz.id);
                } else {
                    // 単独選択
                    selected.clear();
                    selected.add(quiz.id);
                }
                lastClickedIndex = idx;
                this.renderMoveList(side);
            });

            listEl.appendChild(item);
        });
    }

    moveQuizzes(fromSide, toSide) {
        const fromId = fromSide === 'source' ? this._moveState.sourceId : this._moveState.destId;
        const toId = toSide === 'source' ? this._moveState.sourceId : this._moveState.destId;
        const fromSelected = fromSide === 'source' ? this._moveState.sourceSelected : this._moveState.destSelected;

        if (!fromId || !toId) { alert('移動元と移動先の問題集を選択してください'); return; }
        if (fromId === toId) { alert('移動元と移動先が同じ問題集です'); return; }
        if (fromSelected.size === 0) { alert('移動する問題を選択してください'); return; }

        const fromCol = this.collections.find(c => c.id === fromId);
        const toCol = this.collections.find(c => c.id === toId);

        const toMove = fromCol.quizzes.filter(q => fromSelected.has(q.id));
        toMove.forEach(q => {
            toCol.quizzes.push({ ...q, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) });
        });
        fromCol.quizzes = fromCol.quizzes.filter(q => !fromSelected.has(q.id));
        fromSelected.clear();

        this.saveToLocalStorage();
        this.updateMoveCollectionSelects();
        console.log(`✅ ${toMove.length}問を「${fromCol.name}」→「${toCol.name}」へ移動`);
    }

    copyQuizzes(fromSide, toSide) {
        const fromId = fromSide === 'source' ? this._moveState.sourceId : this._moveState.destId;
        const toId = toSide === 'source' ? this._moveState.sourceId : this._moveState.destId;
        const fromSelected = fromSide === 'source' ? this._moveState.sourceSelected : this._moveState.destSelected;

        if (!fromId || !toId) { alert('コピー元とコピー先の問題集を選択してください'); return; }
        if (fromId === toId) { alert('コピー元とコピー先が同じ問題集です'); return; }
        if (fromSelected.size === 0) { alert('コピーする問題を選択してください'); return; }

        const fromCol = this.collections.find(c => c.id === fromId);
        const toCol = this.collections.find(c => c.id === toId);

        const toCopy = fromCol.quizzes.filter(q => fromSelected.has(q.id));
        toCopy.forEach(q => {
            toCol.quizzes.push({ ...q, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) });
        });

        this.saveToLocalStorage();
        this.updateMoveCollectionSelects();
        console.log(`✅ ${toCopy.length}問を「${fromCol.name}」→「${toCol.name}」へコピー`);
    }

    applyViewMode() {
        // バナー表示
        document.getElementById('viewModeBanner').style.display = 'flex';

        // 非表示にするボタン（編集・保存系）
        const hideIds = [
            'saveBtn', 'importCsvBtn',
            'newCollectionBtn', 'renameCollectionBtn', 'deleteCollectionBtn',
            'newQuizBtn', 'deleteQuizBtn',
            'clearDataBtn'
        ];
        hideIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        // 編集タブ・候補リストタブ・移動タブを非表示
        document.querySelectorAll('.tab-btn').forEach(btn => {
            if (btn.dataset.tab === 'edit' || btn.dataset.tab === 'candidates' || btn.dataset.tab === 'move') {
                btn.style.display = 'none';
            }
        });

        // 読み込みボタンのラベルを変更（メモリのみ読み込みと明示）
        const loadBtn = document.getElementById('loadBtn');
        if (loadBtn) loadBtn.textContent = '一時読み込み';

        console.log('👁 閲覧モードで起動しました（localStorageへの読み書き無効）');
    }

    clearAllData() {
        if (!confirm('全てのデータを削除しますか？この操作は元に戻せません。')) return;
        if (!confirm('本当によろしいですか？')) return;

        const collectionCount = this.collections.length;
        const totalQuizzes = this.collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);

        this.collections = [];
        this.currentCollection = null;
        this.currentQuiz = null;
        localStorage.removeItem('quizManagerData');
        
        console.log(`🗑️ 全データを削除しました (${collectionCount}問題集, ${totalQuizzes}問)`);
        
        this.updateUI();
        alert('全てのデータを削除しました');
    }

    // ================== Claude.ai Web版での事実確認 ==================
    openClaudeWebForFactCheck() {
        const question = document.getElementById('questionInput').value.trim();
        const answer = document.getElementById('answerInput').value.trim();

        if (!question || !answer) {
            alert('問題文と答えを入力してください');
            return;
        }

        // 事実確認用のプロンプトを生成
        const prompt = `以下のクイズ問題について、事実確認をお願いします。

【問題文】
${question}

【答え】
${answer}

以下の観点で確認してください：
1. 答えの正確性（事実として正しいか）
2. 問題文の明確性（曖昧な表現がないか）
3. 追加の関連情報や注意点
4. 問題として適切か（難易度や表現）

簡潔かつ具体的に回答してください。`;

        // クリップボードにコピー
        navigator.clipboard.writeText(prompt).then(() => {
            const notification = document.createElement('div');
            notification.className = 'copy-notification';
            notification.innerHTML = `
                <div style="background: #4CAF50; color: white; padding: 15px 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 400px;">
                    <strong>📋 質問をコピーしました！</strong><br>
                    <small>Claude.aiが開くので、Ctrl+V で貼り付けてください</small>
                </div>
            `;
            notification.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 10000; animation: slideIn 0.3s;';
            document.body.appendChild(notification);

            setTimeout(() => {
                notification.style.animation = 'slideOut 0.3s';
                setTimeout(() => notification.remove(), 300);
            }, 3000);

            // Claude.aiを開く
            window.open('https://claude.ai/new', '_blank');
        }).catch(err => {
            console.error('クリップボードへのコピーに失敗:', err);

            // フォールバック: 手動コピー
            const textarea = document.createElement('textarea');
            textarea.value = prompt;
            textarea.style.cssText = 'position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0;';
            document.body.appendChild(textarea);
            textarea.select();

            try {
                document.execCommand('copy');
                alert('質問をクリップボードにコピーしました！\nClaude.aiが開いたら、貼り付け（Ctrl+V）してください。');
                window.open('https://claude.ai/new', '_blank');
            } catch (err2) {
                alert('クリップボードへのコピーに失敗しました。\n以下の質問文を手動でコピーしてください：\n\n' + prompt);
            }

            document.body.removeChild(textarea);
        });
    }
}

// アプリケーション起動
document.addEventListener('DOMContentLoaded', () => {
    window.quizManager = new QuizManager();
});
