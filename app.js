// 早押しクイズ管理ツール - JavaScript

// 詳細ログ（window.QUIZBOOK_DEBUG は firebase-sync.js で定義される）
// 有効化: localStorage.setItem('quizbook_debug', '1') してリロード
function appDebugLog(...args) {
    if (window.QUIZBOOK_DEBUG) console.log(...args);
}

// innerHTML に流し込む前のエスケープ。
// 問題文・答え・フォルダ名などはCSV/JSON取り込みやクラウド同期で外部から入りうるため、
// HTMLとして解釈させない。
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
            answerVisible: true,  // デフォルトで答えを表示
            // 出題画面から編集タブへ飛んだときの戻り先（{collectionId, quizId}）
            editReturn: null
        };
        this.settings = {
            fontSize: 14,
            quizFontSize: 32
        };
        this.syncEnabled = false;  // 同期状態
        this.isLoadingFromFirestore = false;  // Firestoreからの読み込み中フラグ
        this.cloudSaveTimer = null;
        // 遅延アップロードまでの待ち時間。長すぎるとタブを閉じたときの取りこぼしが増える
        this.cloudSaveDelayMs = 5000;
        // クラウドの問題集一覧を正常に取得できたか。
        // false のあいだは「クラウドにあってローカルに無い問題集」の削除を行わない
        // （取得失敗時にローカルの部分的な状態でクラウドを消してしまう事故を防ぐ）
        this.cloudViewComplete = false;
        this.defaultFolderName = '未分類';
        this.folders = [
            {
                id: 'folder_default',
                name: this.defaultFolderName,
                maxCollections: 50,
                maxQuizzes: 5000
            }
        ];
        this.selectedFolderId = 'folder_default';
        this.limits = {
            maxQuizzesPerCollection: 500
        };
        this.quizSelectionInitialized = false;
        this.quizSelectedFolderNames = new Set();
        this.quizSelectedCollectionIds = new Set();
        // 出題設定の絞り込みキーワードとプリセット
        this.quizFolderSearch = '';
        this.quizCollectionSearch = '';
        this.quizPresets = [];
        this.selectedQuizPresetId = '';
        this.lastSyncResult = '未実行';
        this.lastSyncAt = null;
        this.lastSyncDetail = '';
        this.currentTab = 'manage';
        this.contextMenuType = null;
        this.contextMenuTarget = null;
        this._collectionMoveState = {
            sourceFolderId: null,
            destFolderId: null,
            sourceSelected: new Set(),
            destSelected: new Set()
        };

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
        this.setupUnloadFlush();
        this.updateUI();
        this.applySettings();
        if (this.isViewMode) this.applyViewMode();
        
        console.log('✅ QuizBook の初期化完了');
    }

    getCollectionQuizCount(collection) {
        if (!collection) return 0;
        if (Array.isArray(collection.quizzes) && collection.isDownloaded !== false) {
            return collection.quizzes.length;
        }
        return collection.quizCount || 0;
    }

    getVisibleCollections() {
        if (!this.selectedFolderId) return this.collections;
        const folder = this.folders.find(f => f.id === this.selectedFolderId);
        if (!folder) return this.collections;
        return this.collections.filter(col => (col.folder || this.defaultFolderName) === folder.name);
    }

    getFolderById(folderId) {
        return this.folders.find(folder => folder.id === folderId) || null;
    }

    ensureDefaultFolder() {
        const existing = this.folders.find(folder => folder.name === this.defaultFolderName);
        if (!existing) {
            this.folders.unshift({
                id: 'folder_default',
                name: this.defaultFolderName,
                maxCollections: 50,
                maxQuizzes: 5000
            });
        }
        if (!this.selectedFolderId || !this.getFolderById(this.selectedFolderId)) {
            const defaultFolder = this.folders.find(folder => folder.name === this.defaultFolderName) || this.folders[0];
            this.selectedFolderId = defaultFolder ? defaultFolder.id : null;
        }
    }

    ensureFoldersFromCollections() {
        this.ensureDefaultFolder();
        const existingNames = new Set(this.folders.map(folder => folder.name));
        this.collections.forEach(collection => {
            const folderName = collection.folder || this.defaultFolderName;
            collection.folder = folderName;
            if (!existingNames.has(folderName)) {
                this.folders.push({
                    id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    name: folderName,
                    maxCollections: 50,
                    maxQuizzes: 5000
                });
                existingNames.add(folderName);
            }
        });
    }

    getFolderUsage(folderName) {
        const collections = this.collections.filter(col => (col.folder || this.defaultFolderName) === folderName);
        const totalQuizzes = collections.reduce((sum, col) => sum + this.getCollectionQuizCount(col), 0);
        return {
            collectionCount: collections.length,
            quizCount: totalQuizzes
        };
    }

    canAddCollectionToFolder(folderName) {
        const folder = this.folders.find(f => f.name === folderName);
        if (!folder) return true;
        const usage = this.getFolderUsage(folderName);
        if (usage.collectionCount >= folder.maxCollections) {
            alert(`フォルダ「${folder.name}」の上限に達しています（問題集 ${folder.maxCollections} 個まで）。`);
            return false;
        }
        return true;
    }

    canAddQuizzesToFolder(folderName, quizDelta) {
        const folder = this.folders.find(f => f.name === folderName);
        if (!folder) return true;
        const usage = this.getFolderUsage(folderName);
        if (usage.quizCount + quizDelta > folder.maxQuizzes) {
            alert(`フォルダ「${folder.name}」の問題数上限を超えます（${folder.maxQuizzes}問まで）。`);
            return false;
        }
        return true;
    }

    canAddQuizzesToCollection(collection, quizDelta) {
        if (!collection) return false;
        const currentCount = this.getCollectionQuizCount(collection);
        if (currentCount + quizDelta > this.limits.maxQuizzesPerCollection) {
            alert(`問題集「${collection.name}」の上限を超えます（${this.limits.maxQuizzesPerCollection}問まで）。`);
            return false;
        }
        return true;
    }

    updateFolderList() {
        const select = document.getElementById('folderList');
        if (!select) return;

        select.innerHTML = '';
        this.folders.forEach(folder => {
            const usage = this.getFolderUsage(folder.name);
            const option = document.createElement('option');
            option.value = folder.id;
            option.textContent = `${folder.name} (${usage.collectionCount}集 / ${usage.quizCount}問)`;
            if (folder.id === this.selectedFolderId) {
                option.selected = true;
            }
            select.appendChild(option);
        });

        this.updateFolderStats();
    }

    updateFolderStats() {
        const statsEl = document.getElementById('folderStats');
        if (!statsEl) return;

        const folder = this.getFolderById(this.selectedFolderId);
        if (!folder) {
            statsEl.textContent = '';
            return;
        }

        const usage = this.getFolderUsage(folder.name);
        statsEl.innerHTML = `
            問題集: ${usage.collectionCount} / ${folder.maxCollections}<br>
            問題数: ${usage.quizCount} / ${folder.maxQuizzes}
        `;
    }

    selectFolder(folderId) {
        this.selectedFolderId = folderId;
        const visible = this.getVisibleCollections();
        this.currentCollection = visible.length > 0 ? visible[0] : null;
        this.currentQuiz = null;
        this.updateUI();
    }

    newFolder() {
        const name = prompt('新しいフォルダ名を入力してください:');
        if (!name) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        if (this.folders.some(folder => folder.name === trimmed)) {
            alert('同名のフォルダが既に存在します。');
            return;
        }

        const folder = {
            id: `folder_${Date.now()}`,
            name: trimmed,
            maxCollections: 50,
            maxQuizzes: 5000
        };
        this.folders.push(folder);
        this.selectedFolderId = folder.id;
        this.updateUI();
        this.saveToLocalStorage();
    }

    async downloadCurrentFolderFromCloud() {
        if (!this.syncEnabled || !window.firebaseSync) {
            alert('クラウド同期が有効になっていません');
            return;
        }
        const folder = this.getFolderById(this.selectedFolderId);
        if (!folder) {
            alert('フォルダを選択してください');
            return;
        }

        this.showSyncOverlay('📥 フォルダをダウンロード中...', `「${folder.name}」の問題集を取得しています`);
        try {
            const loadedCollections = await window.firebaseSync.loadCollectionsByFolder(folder.name);
            let loadedCount = 0;
            let skipCount = 0;
            loadedCollections.forEach(loaded => {
                const idx = this.collections.findIndex(col => col.id === loaded.id);
                if (idx !== -1) {
                    const existing = this.collections[idx];
                    const remoteUpdateId = loaded.lastUpdateId || existing.lastUpdateId || null;
                    const localUpdateId = existing.downloadedUpdateId || null;
                    if (this.isCollectionDownloaded(existing) && remoteUpdateId && localUpdateId && remoteUpdateId === localUpdateId) {
                        this.collections[idx] = {
                            ...existing,
                            lastUpdateId: remoteUpdateId,
                            syncStatus: 'synced'
                        };
                        skipCount += 1;
                        return;
                    }

                    this.collections[idx] = {
                        ...loaded,
                        folder: loaded.folder || folder.name,
                        isCloudPlaceholder: false,
                        isDownloaded: true,
                        quizCount: loaded.quizzes.length,
                        lastUpdateId: remoteUpdateId,
                        downloadedUpdateId: remoteUpdateId,
                        syncStatus: 'synced'
                    };
                    loadedCount += 1;
                }
            });

            this.updateUI();
            this.isLoadingFromFirestore = true;
            this.saveToLocalStorage();
            this.isLoadingFromFirestore = false;
            this.hideSyncOverlay();
            this.showNotification(`<strong>📥 フォルダを取得しました</strong><br><small>${loadedCount}件DL / ${skipCount}件は最新</small>`, 'success');
        } catch (error) {
            this.hideSyncOverlay();
            this.showNotification(`<strong>⚠️ フォルダDLに失敗</strong><br><small>${escapeHtml(error.message)}</small>`, 'error');
        }
    }

    isCollectionDownloaded(collection) {
        if (!collection) return false;
        if (collection.isCloudPlaceholder && !collection.isDownloaded) return false;
        return Array.isArray(collection.quizzes);
    }

    ensureCurrentCollectionReadyForEdit() {
        if (!this.currentCollection) {
            alert('問題集を選択してください');
            return false;
        }
        if (!this.isCollectionDownloaded(this.currentCollection)) {
            alert('この問題集は未ダウンロードのため編集できません。先に問題集を開いてダウンロードしてください。');
            return false;
        }
        return true;
    }

    scheduleCloudUpload() {
        if (!this.syncEnabled || !window.firebaseSync || this.isLoadingFromFirestore) return;
        if (this.cloudSaveTimer) {
            clearTimeout(this.cloudSaveTimer);
        }
        this.cloudSaveTimer = setTimeout(() => {
            this.cloudSaveTimer = null;
            this.uploadToCloud();
        }, this.cloudSaveDelayMs);
    }

    setupUnloadFlush() {
        // 遅延アップロードの待機中にタブを閉じると、その変更がクラウドへ届かない。
        // 離脱を検知したら即座にアップロードを開始する（ベストエフォート）。
        // 送信が間に合わなかった場合でもローカルには保存済みで、
        // 次回起動時のマージ処理（mergeCollectionsWithCloudMetas）で消えないようにしてある。
        const flush = () => {
            if (!this.cloudSaveTimer) return;
            clearTimeout(this.cloudSaveTimer);
            this.cloudSaveTimer = null;
            this.uploadToCloud();
        };

        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });
    }

    /**
     * クラウドのメタデータ一覧とローカルの問題集をマージする。
     * 単純に置き換えるとクラウド未アップロードの問題集が消えてしまうため、
     * 「一度も同期されていないローカル限定の問題集」だけを残す。
     * （同期済みなのにクラウドに無い = 他デバイスで削除された、とみなして残さない）
     */
    mergeCollectionsWithCloudMetas(metas) {
        const merged = this.buildCollectionsFromCloudMetas(metas);
        const cloudIds = new Set(metas.map(meta => meta.id));

        const neverSyncedLocals = this.collections.filter(col =>
            col &&
            !cloudIds.has(col.id) &&
            this.isCollectionDownloaded(col) &&
            !col.lastUpdateId &&
            !col.downloadedUpdateId
        );

        if (neverSyncedLocals.length > 0) {
            console.log(`📌 未アップロードの問題集を保持します: ${neverSyncedLocals.map(c => c.name).join(', ')}`);
        }

        return [...merged, ...neverSyncedLocals];
    }

    buildCollectionsFromCloudMetas(metas) {
        const localById = new Map(this.collections.map(col => [col.id, col]));
        return metas.map(meta => {
            const local = localById.get(meta.id);
            const localDownloaded = local && this.isCollectionDownloaded(local);
            const metaUpdateId = meta.lastUpdateId || null;
            const localUpdateId = local ? (local.downloadedUpdateId || local.lastUpdateId || null) : null;
            const isUpToDate = localDownloaded && metaUpdateId && localUpdateId && metaUpdateId === localUpdateId;

            if (isUpToDate) {
                return {
                    ...local,
                    name: meta.name || local.name,
                    folder: meta.folder || local.folder || '未分類',
                    quizCount: meta.quizCount || local.quizzes.length,
                    isCloudPlaceholder: false,
                    isDownloaded: true,
                    lastUpdateId: metaUpdateId,
                    downloadedUpdateId: localUpdateId,
                    syncStatus: 'synced'
                };
            }

            return {
                id: meta.id,
                name: meta.name || '無題の問題集',
                quizzes: [],
                quizCount: meta.quizCount || 0,
                folder: meta.folder || '未分類',
                created_at: meta.created_at || new Date().toISOString(),
                isCloudPlaceholder: true,
                isDownloaded: false,
                lastUpdateId: metaUpdateId,
                downloadedUpdateId: null,
                syncStatus: 'pending'
            };
        });
    }

    /**
     * 指定した問題集の本文をクラウドから取得してローカルへ反映する。
     * 対象は引数で受け取った参照に固定するため、ダウンロード中にユーザーが
     * 別の問題集へ切り替えても、取得結果が別の問題集に書き込まれることはない。
     */
    async downloadCollection(target) {
        if (!target || !this.syncEnabled || !window.firebaseSync) return false;

        const targetId = target.id;
        const targetName = target.name;
        const expectedUpdateId = target.lastUpdateId || null;

        target.syncStatus = 'syncing';
        this.updateCollectionList();
        this.showSyncOverlay('📥 問題集をダウンロード中...', `「${targetName}」を取得しています`);

        let loaded = null;
        try {
            loaded = await window.firebaseSync.loadCollectionById(targetId);
        } catch (error) {
            console.error('❌ 問題集のダウンロードに失敗:', error);
        } finally {
            this.hideSyncOverlay();
        }

        const idx = this.collections.findIndex(c => c.id === targetId);

        if (!loaded) {
            if (idx !== -1) {
                this.collections[idx].syncStatus = 'error';
                this.updateCollectionList();
            }
            return false;
        }

        if (idx === -1) {
            // ダウンロード中にローカルから削除された
            console.warn(`⚠️ ダウンロード完了時に問題集が見つかりません: ${targetId}`);
            return false;
        }

        const updateId = expectedUpdateId || loaded.lastUpdateId || null;
        this.collections[idx] = {
            ...loaded,
            folder: loaded.folder || target.folder || this.defaultFolderName,
            isCloudPlaceholder: false,
            isDownloaded: true,
            quizCount: loaded.quizzes.length,
            lastUpdateId: updateId,
            downloadedUpdateId: updateId,
            syncStatus: 'synced'
        };

        // 表示中の問題集が対象だった場合のみ選択を差し替える
        if (this.currentCollection && this.currentCollection.id === targetId) {
            this.currentCollection = this.collections[idx];
        }

        this.isLoadingFromFirestore = true;
        this.saveToLocalStorage();
        this.isLoadingFromFirestore = false;
        this.updateUI();

        return true;
    }

    async downloadCollectionIfNeeded(collection) {
        if (!collection || this.isCollectionDownloaded(collection) || !this.syncEnabled || !window.firebaseSync) {
            return true;
        }

        const success = await this.downloadCollection(collection);
        if (!success) {
            alert('問題集のダウンロードに失敗しました。ネットワーク接続を確認してください。');
        }
        return success;
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
                case 'e':
                case 'E':
                    // 出題画面を見ているときだけ、いまの問題を編集タブで開く
                    if (this.currentTab !== 'quiz') break;
                    e.preventDefault();
                    this.editCurrentQuiz();
                    break;
                case 'f':
                case 'F':
                    if (this.currentTab !== 'quiz') break;
                    e.preventDefault();
                    this.toggleFactCheckedForCurrentQuiz();
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
        const saveBtn = document.getElementById('saveBtn');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveToFile());

        const loadBtn = document.getElementById('loadBtn');
        if (loadBtn) loadBtn.addEventListener('click', () => this.loadFromFile());

        // クラウド同期
        document.getElementById('syncToggleBtn').addEventListener('click', () => this.toggleSync());
        
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
        document.getElementById('collectionList').addEventListener('change', (e) => this.selectCollection(e.target.value));
        document.getElementById('collectionList').addEventListener('dblclick', (e) => this.startQuizFromCollection());
        document.getElementById('collectionList').addEventListener('contextmenu', (e) => this.showContextMenu(e, 'collection'));
        
        document.getElementById('folderList').addEventListener('change', (e) => this.selectFolder(e.target.value));
        document.getElementById('folderList').addEventListener('contextmenu', (e) => this.showContextMenu(e, 'folder'));
        
        document.getElementById('newFolderBtn').addEventListener('click', () => this.newFolder());
        document.getElementById('downloadFolderBtn').addEventListener('click', () => this.downloadCurrentFolderFromCloud());

        const importCsvFolderBtn = document.getElementById('importCsvFolderBtn');
        if (importCsvFolderBtn) importCsvFolderBtn.addEventListener('click', () => this.importCsvFolder());

        // CSV関連
        const importCsvBtn = document.getElementById('importCsvBtn');
        if (importCsvBtn) importCsvBtn.addEventListener('click', () => this.importCsv());

        // 出題設定（フォルダ・問題集の選択）
        const quizFolderCheckboxes = document.getElementById('quizFolderCheckboxes');
        if (quizFolderCheckboxes) {
            quizFolderCheckboxes.addEventListener('change', (e) => {
                if (e.target && e.target.matches('input[type="checkbox"]')) {
                    this.onQuizFolderToggle(e.target);
                }
            });
        }

        const quizCollectionCheckboxes = document.getElementById('quizCollectionCheckboxes');
        if (quizCollectionCheckboxes) {
            quizCollectionCheckboxes.addEventListener('change', (e) => {
                if (e.target && e.target.matches('input[type="checkbox"]')) {
                    this.onQuizCollectionToggle(e.target);
                }
            });
        }

        const quizFolderSearch = document.getElementById('quizFolderSearch');
        if (quizFolderSearch) {
            quizFolderSearch.addEventListener('input', (e) => {
                this.quizFolderSearch = e.target.value;
                this.updateQuizFolderCheckboxes();
            });
        }

        const quizCollectionSearch = document.getElementById('quizCollectionSearch');
        if (quizCollectionSearch) {
            quizCollectionSearch.addEventListener('input', (e) => {
                this.quizCollectionSearch = e.target.value;
                this.updateQuizCollectionCheckboxes();
            });
        }

        const quizFolderSelectAllBtn = document.getElementById('quizFolderSelectAllBtn');
        if (quizFolderSelectAllBtn) {
            quizFolderSelectAllBtn.addEventListener('click', () => this.setAllVisibleQuizFolders(true));
        }
        const quizFolderClearBtn = document.getElementById('quizFolderClearBtn');
        if (quizFolderClearBtn) {
            quizFolderClearBtn.addEventListener('click', () => this.setAllVisibleQuizFolders(false));
        }
        const quizCollectionSelectAllBtn = document.getElementById('quizCollectionSelectAllBtn');
        if (quizCollectionSelectAllBtn) {
            quizCollectionSelectAllBtn.addEventListener('click', () => this.setAllVisibleQuizCollections(true));
        }
        const quizCollectionClearBtn = document.getElementById('quizCollectionClearBtn');
        if (quizCollectionClearBtn) {
            quizCollectionClearBtn.addEventListener('click', () => this.setAllVisibleQuizCollections(false));
        }

        // 出題プリセット
        const quizPresetSelect = document.getElementById('quizPresetSelect');
        if (quizPresetSelect) {
            quizPresetSelect.addEventListener('change', (e) => {
                this.selectedQuizPresetId = e.target.value;
            });
        }
        const applyQuizPresetBtn = document.getElementById('applyQuizPresetBtn');
        if (applyQuizPresetBtn) {
            applyQuizPresetBtn.addEventListener('click', () => this.applyQuizPreset());
        }
        const saveQuizPresetBtn = document.getElementById('saveQuizPresetBtn');
        if (saveQuizPresetBtn) {
            saveQuizPresetBtn.addEventListener('click', () => this.saveQuizPreset());
        }
        const overwriteQuizPresetBtn = document.getElementById('overwriteQuizPresetBtn');
        if (overwriteQuizPresetBtn) {
            overwriteQuizPresetBtn.addEventListener('click', () => this.overwriteQuizPreset());
        }
        const deleteQuizPresetBtn = document.getElementById('deleteQuizPresetBtn');
        if (deleteQuizPresetBtn) {
            deleteQuizPresetBtn.addEventListener('click', () => this.deleteQuizPreset());
        }

        // 問題管理
        const newQuizBtn = document.getElementById('newQuizBtn');
        if (newQuizBtn) {
            newQuizBtn.addEventListener('click', () => this.newQuiz());
        }
        const deleteQuizBtn = document.getElementById('deleteQuizBtn');
        if (deleteQuizBtn) {
            deleteQuizBtn.addEventListener('click', () => this.deleteQuiz());
        }

        // 問題集フォルダ移動タブ
        document.getElementById('collectionMoveSourceFolder').addEventListener('change', (e) => this.onCollectionMoveFolderChange('source', e.target.value));
        document.getElementById('collectionMoveDestFolder').addEventListener('change', (e) => this.onCollectionMoveFolderChange('dest', e.target.value));
        document.getElementById('moveCollectionsRightBtn').addEventListener('click', () => this.moveCollectionsBetweenFolders('source', 'dest'));
        document.getElementById('moveCollectionsLeftBtn').addEventListener('click', () => this.moveCollectionsBetweenFolders('dest', 'source'));

        // 問題並び替え・削除タブ
        document.getElementById('quizManageCollection').addEventListener('change', (e) => this.selectCollection(e.target.value));
        document.getElementById('quizManageSearch').addEventListener('input', () => this.updateQuizManageList());
        document.getElementById('quizManageGenreFilter').addEventListener('change', () => this.updateQuizManageList());
        document.getElementById('quizManageDifficultyFilter').addEventListener('change', () => this.updateQuizManageList());

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
        const editCurrentQuizBtn = document.getElementById('editCurrentQuizBtn');
        if (editCurrentQuizBtn) {
            editCurrentQuizBtn.addEventListener('click', () => this.editCurrentQuiz());
        }
        const backToQuizBtn = document.getElementById('backToQuizBtn');
        if (backToQuizBtn) {
            backToQuizBtn.addEventListener('click', () => this.returnToQuizMode());
        }
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
        // input = 表示だけ即時反映 / change = ドラッグ終了時に1回だけ保存
        const fontSizeSlider = document.getElementById('fontSizeSlider');
        fontSizeSlider.addEventListener('input', (e) => {
            this.settings.fontSize = parseInt(e.target.value);
            this.applySettings();
        });
        fontSizeSlider.addEventListener('change', () => this.saveToLocalStorage());

        const quizFontSizeSlider = document.getElementById('quizFontSizeSlider');
        quizFontSizeSlider.addEventListener('input', (e) => {
            this.settings.quizFontSize = parseInt(e.target.value);
            this.applySettings();
        });
        quizFontSizeSlider.addEventListener('change', () => this.saveToLocalStorage());
        document.getElementById('clearDataBtn').addEventListener('click', () => this.clearAllData());

        // 事実確認
        document.getElementById('factCheckClaudeWebBtn').addEventListener('click', () => this.openClaudeWebForFactCheck());
        const toggleFactCheckedBtn = document.getElementById('toggleFactCheckedBtn');
        if (toggleFactCheckedBtn) {
            toggleFactCheckedBtn.addEventListener('click', () => this.toggleFactCheckedForCurrentQuiz());
        }
        const factCheckQuizBtn = document.getElementById('factCheckQuizBtn');
        if (factCheckQuizBtn) {
            factCheckQuizBtn.addEventListener('click', () => this.factCheckCurrentQuiz());
        }

        // ファイル入力
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileLoad(e));
        document.getElementById('csvFileInput').addEventListener('change', (e) => this.handleCsvImport(e));
        document.getElementById('csvFolderInput').addEventListener('change', (e) => this.handleCsvFolderImport(e));

        // 問題移動タブ
        document.getElementById('moveSourceCollection').addEventListener('change', (e) => this.onMoveCollectionChange('source', e.target.value));
        document.getElementById('moveDestCollection').addEventListener('change', (e) => this.onMoveCollectionChange('dest', e.target.value));
        document.getElementById('moveSourceSearch').addEventListener('input', () => this.renderMoveList('source'));
        document.getElementById('moveDestSearch').addEventListener('input', () => this.renderMoveList('dest'));
        document.getElementById('moveRightBtn').addEventListener('click', () => this.moveQuizzes('source', 'dest'));
        document.getElementById('moveLeftBtn').addEventListener('click', () => this.moveQuizzes('dest', 'source'));
        document.getElementById('copyRightBtn').addEventListener('click', () => this.copyQuizzes('source', 'dest'));
        document.getElementById('copyLeftBtn').addEventListener('click', () => this.copyQuizzes('dest', 'source'));

        // コンテキストメニューのグローバルハンドラー
        document.addEventListener('click', () => this.hideContextMenu());
        
        const contextMenu = document.getElementById('contextMenu');
        if (contextMenu) {
            contextMenu.addEventListener('click', (e) => {
                if (e.target.classList.contains('context-menu-item')) {
                    const action = e.target.dataset.action;
                    appDebugLog(`🔍 [DEBUG] メニューアイテムクリック: ${action}`);
                    e.stopPropagation(); // ドキュメントクリックへの伝播を防ぐ
                    this.handleContextMenuAction(action);
                    this.hideContextMenu();
                }
            });
        }
    }

    showContextMenu(e, type) {
        e.preventDefault();
        appDebugLog(`🔍 [DEBUG] 右クリックメニュー表示: type=${type}`, e.target);
        this.contextMenuType = type;

        const selectElement = e.currentTarget.tagName === 'SELECT' ? e.currentTarget : e.target.closest('select');
        if (!selectElement) {
            console.warn('⚠️ select要素が見つかりません');
            return;
        }

        // 右クリックされた option を特定する。
        // selectedIndex だけを見ていると「今選択中の項目」が対象になり、
        // 右クリックした項目とは別のものを削除・改名してしまう
        // （ブラウザによっては右クリックで選択が移動しないため）。
        const option = e.target.closest('option');
        const targetId = option
            ? option.value
            : (selectElement.selectedIndex >= 0 ? selectElement.options[selectElement.selectedIndex].value : null);

        if (!targetId) {
            appDebugLog('🔍 [DEBUG] 右クリック位置に対象がありません');
            return;
        }

        this.contextMenuTarget = (type === 'folder')
            ? this.folders.find(folder => folder.id === targetId)
            : this.collections.find(collection => collection.id === targetId);

        if (!this.contextMenuTarget) {
            console.warn('⚠️ 右クリック対象が見つかりません:', targetId);
            return;
        }

        // 右クリックした項目を選択状態にして、操作対象を目で確認できるようにする
        if (option && selectElement.value !== targetId) {
            if (type === 'folder') {
                this.selectFolder(targetId);
            } else {
                this.selectCollection(targetId);
                selectElement.value = targetId;
            }
        }

        appDebugLog(`🔍 [DEBUG] 対象: ${this.contextMenuTarget.name} (${targetId})`);

        const contextMenu = document.getElementById('contextMenu');
        const csvExportItem = contextMenu.querySelector('[data-action="csv-export"]');
        
        // CSV出力は問題集の場合だけ表示
        if (csvExportItem) {
            csvExportItem.style.display = (type === 'collection') ? 'block' : 'none';
        }

        contextMenu.style.left = e.pageX + 'px';
        contextMenu.style.top = e.pageY + 'px';
        contextMenu.style.display = 'block';
    }

    hideContextMenu() {
        const contextMenu = document.getElementById('contextMenu');
        if (contextMenu) contextMenu.style.display = 'none';
    }

    handleContextMenuAction(action) {
        appDebugLog(`🔍 [DEBUG] コンテキストメニューアクション: ${action} / ${this.contextMenuType}`, this.contextMenuTarget);

        if (!this.contextMenuTarget) {
            console.warn('⚠️ contextMenuTarget が null です');
            return;
        }

        if (action === 'rename') {
            this.startInlineEdit(this.contextMenuType);
        } else if (action === 'delete') {
            this.deleteFromContextMenu(this.contextMenuType);
        } else if (action === 'csv-export') {
            this.exportCollectionAsCSV(this.contextMenuTarget);
        }
    }

    startInlineEdit(type) {
        const target = this.contextMenuTarget;
        if (!target) return;

        // 表示文字列（"名前 (12問)  🟢 同期済み"）を parse すると
        // 問題数や同期状態まで名前に混ざってしまうため、データ側の名前をそのまま使う
        const oldName = target.name;
        const newName = prompt('新しい名前を入力してください:', oldName);

        if (!newName || newName === oldName) return;

        if (type === 'folder') {
            this.renameFolderInline(target, newName);
        } else {
            this.renameCollectionInline(target, newName);
        }
    }

    renameFolderInline(folder, newName) {
        const trimmed = newName.trim();
        if (!trimmed) {
            alert('フォルダ名を入力してください');
            return;
        }

        const oldName = folder.name;
        if (trimmed === oldName) return;

        // フォルダは名前で問題集と紐づいているため、同名が2つあると区別できなくなる
        if (this.folders.some(f => f !== folder && f.name === trimmed)) {
            alert('同名のフォルダが既に存在します。');
            return;
        }

        folder.name = trimmed;

        // 同じフォルダ配下のすべての問題集のfolderプロパティを更新
        let updatedCount = 0;
        this.collections.forEach(col => {
            if (col.folder === oldName) {
                col.folder = trimmed;
                updatedCount++;
            }
        });

        console.log(`📁 フォルダ名を変更: "${oldName}" → "${trimmed}" (${updatedCount}個の問題集を更新)`);
        this.updateUI();
        this.saveToLocalStorage();
    }

    renameCollectionInline(collection, newName) {
        const trimmed = newName.trim();
        if (!trimmed) {
            alert('問題集名を入力してください');
            return;
        }

        const oldName = collection.name;
        collection.name = trimmed;

        console.log(`📚 問題集名を変更: "${oldName}" → "${trimmed}"`);
        this.updateUI();
        this.saveToLocalStorage();
    }

    deleteFromContextMenu(type) {
        const target = this.contextMenuTarget;
        
        if (type === 'folder') {
            if (target.name === this.defaultFolderName) {
                alert('デフォルトフォルダは削除できません');
                return;
            }

            if (!confirm(`フォルダ「${target.name}」を削除しますか？このフォルダ内の問題集は「${this.defaultFolderName}」に移動します。`)) {
                return;
            }

            appDebugLog(`🔍 [DEBUG] フォルダ削除開始: "${target.name}" (ID: ${target.id})`);

            // フォルダ内のすべての問題集をデフォルトフォルダに移動
            let movedCount = 0;
            this.collections.forEach(col => {
                if (col.folder === target.name) {
                    col.folder = this.defaultFolderName;
                    movedCount++;
                }
            });

            this.folders = this.folders.filter(f => f.id !== target.id);
            this.selectedFolderId = 'folder_default';

            console.log(`🗑️ フォルダを削除: "${target.name}" (${movedCount}個の問題集を移動)`);
            this.updateUI();
            this.saveToLocalStorage();
        } else {
            if (!confirm(`「${target.name}」を削除しますか？`)) return;

            const deletedId = target.id;
            const deletedName = target.name;
            
            this.collections = this.collections.filter(c => c.id !== deletedId);
            const visibleCollections = this.getVisibleCollections();
            this.currentCollection = visibleCollections.length > 0 ? visibleCollections[0] : null;

            console.log(`🗑️ 問題集を削除: "${deletedName}"`);
            this.updateUI();
            this.saveToLocalStorage();
        }
    }

    exportCollectionAsCSV(collection) {
        if (!collection) {
            alert('問題集を選択してください');
            return;
        }

        // 既存のexportCsv機能を使用
        this.currentCollection = collection;
        this.exportCsv();
    }

    async downloadCurrentCollectionFromCloud() {
        if (!this.currentCollection) {
            alert('ダウンロードする問題集を選択してください');
            return;
        }

        if (!this.syncEnabled || !window.firebaseSync) {
            alert('クラウド同期が有効になっていません');
            return;
        }

        const target = this.currentCollection;

        if (this.isCollectionDownloaded(target)
            && target.lastUpdateId
            && target.downloadedUpdateId
            && target.lastUpdateId === target.downloadedUpdateId) {
            target.syncStatus = 'synced';
            this.updateCollectionList();
            this.showNotification('<strong>✅ すでに最新です</strong><br><small>ダウンロードは不要でした</small>', 'info');
            return;
        }

        const success = await this.downloadCollection(target);
        if (success) {
            this.showNotification(
                `<strong>📥 ダウンロードが完了しました</strong><br><small>${escapeHtml(target.name)}</small>`,
                'success'
            );
        } else {
            this.showNotification('<strong>⚠️ ダウンロードに失敗しました</strong>', 'error');
        }
    }

    // ================== タブ切り替え ==================
    switchTab(tabName) {
        // 閲覧モードでは編集・候補リスト・移動タブへの遷移をブロック
        if (this.isViewMode && (tabName === 'edit' || tabName === 'candidates' || tabName === 'move' || tabName === 'quiz-organize' || tabName === 'collection-folder-move')) return;

        this.currentTab = tabName;

        // タブボタンの切り替え
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // コンテンツの切り替え
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`${tabName}-tab`).classList.add('active');

        // 表示するタイミングで中身を組み立てる
        this.renderActiveTab();
    }

    // ================== 問題集管理 ==================
    newCollection() {
        const name = prompt('新しい問題集の名前を入力してください:');
        if (!name) return;

        const selectedFolder = this.getFolderById(this.selectedFolderId);
        const folderName = selectedFolder ? selectedFolder.name : this.defaultFolderName;
        if (!this.canAddCollectionToFolder(folderName)) return;

        const collection = {
            id: Date.now().toString(),
            name: name,
            quizzes: [],
            created_at: new Date().toISOString(),
            folder: folderName,
            isCloudPlaceholder: false,
            isDownloaded: true,
            quizCount: 0
        };

        this.collections.push(collection);
        this.currentCollection = collection;
        
        console.log(`📁 新規問題集を作成: "${name}" (ID: ${collection.id})`);
        
        this.updateUI();
        this.saveToLocalStorage();
    }

    selectCollection(collectionId) {
        this.currentCollection = this.collections.find(c => c.id === collectionId) || null;
        this.currentQuiz = null;

        this.renderActiveTab();
    }

    async startQuizFromCollection() {
        if (!this.currentCollection) {
            alert('問題集を選択してください');
            return;
        }

        if (!this.isCollectionDownloaded(this.currentCollection)) {
            alert('この問題集は未同期です。問題集を選択して「📥ダウンロード」を押してください。');
            return;
        }

        // 出題タブに切り替え
        this.switchTab('quiz');

        this.quizSelectionInitialized = true;
        this.quizSelectedFolderNames = new Set([this.currentCollection.folder || this.defaultFolderName]);
        this.quizSelectedCollectionIds = new Set([this.currentCollection.id]);
        this.updateQuizFolderCheckboxes();
        this.updateQuizCollectionCheckboxes();

        // 出題を開始
        this.startQuizMode();
    }

    // ================== 問題管理 ==================
    newQuiz() {
        if (!this.ensureCurrentCollectionReadyForEdit()) return;

        this.currentQuiz = null;
        this.clearEditForm();
        this.switchTab('edit');
    }

    deleteQuiz() {
        if (!this.ensureCurrentCollectionReadyForEdit() || !this.currentQuiz) return;

        if (!confirm('この問題を削除しますか？')) return;

        const deletedQuestion = this.currentQuiz.question.substring(0, 30);

        this.currentCollection.quizzes = this.currentCollection.quizzes.filter(q => q.id !== this.currentQuiz.id);
        this.currentCollection.quizCount = this.currentCollection.quizzes.length;
        this.currentQuiz = null;
        console.log(`🗑️ 問題を削除: "${deletedQuestion}..." (問題集: ${this.currentCollection.name})`);
        this.updateQuizList();
        this.updateQuizManageList();
        this.saveToLocalStorage();
    }

    saveQuiz() {
        if (!this.ensureCurrentCollectionReadyForEdit()) return;

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
            factChecked: document.getElementById('factCheckedInput').checked,
            created_at: this.currentQuiz ? this.currentQuiz.created_at : new Date().toISOString()
        };

        let currentIndex = -1;

        if (this.currentQuiz) {
            // 更新
            currentIndex = this.currentCollection.quizzes.findIndex(q => q.id === this.currentQuiz.id);
            this.currentCollection.quizzes[currentIndex] = quiz;
        } else {
            // 新規
            if (!this.canAddQuizzesToCollection(this.currentCollection, 1)) return;
            if (!this.canAddQuizzesToFolder(this.currentCollection.folder || this.defaultFolderName, 1)) return;
            this.currentCollection.quizzes.push(quiz);
            currentIndex = this.currentCollection.quizzes.length - 1;
        }
        this.currentCollection.quizCount = this.currentCollection.quizzes.length;

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

        // 出題中の一覧にも編集内容を反映する
        this.syncQuizModeQuiz(this.currentCollection.id, quiz);

        // 出題画面から飛んできた場合は、保存したら出題画面へ戻る
        if (this.quizMode.active && this.quizMode.editReturn && this.quizMode.editReturn.quizId === quiz.id) {
            this.showNotification('<strong>💾 保存しました</strong><br><small>出題画面に戻ります</small>', 'success');
            this.returnToQuizMode();
            return;
        }

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
        // 出題画面から飛んできた場合は出題画面へ戻る
        if (this.quizMode.active && this.quizMode.editReturn) {
            this.returnToQuizMode();
            return;
        }
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
        document.getElementById('difficultySelect').value = '3';
        document.getElementById('tagsInput').value = '';
        document.getElementById('factCheckedInput').checked = false;
        this.updateEditTabContext();
    }

    fillEditForm(quiz) {
        document.getElementById('questionInput').value = quiz.question;
        document.getElementById('answerInput').value = quiz.answer;
        document.getElementById('memoInput').value = quiz.memo || '';
        document.getElementById('genreSelect').value = quiz.genre || 'ノンジャンル';
        document.getElementById('difficultySelect').value = quiz.difficulty || 2;
        document.getElementById('tagsInput').value = quiz.tags ? quiz.tags.join(', ') : '';
        document.getElementById('factCheckedInput').checked = !!quiz.factChecked;
        this.updateEditTabContext();
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
        this.ensureFoldersFromCollections();
        this.updateGenreFilters();
        this.updateFolderList();
        this.updateCollectionList();
        // 表示されていないタブまで毎回描画すると、問題数に比例して重くなるため
        // アクティブなタブの中身だけを組み立てる（タブ切り替え時に再描画される）
        this.renderActiveTab();
    }

    renderActiveTab() {
        switch (this.currentTab) {
            case 'manage':
                this.updateQuizList();
                break;
            case 'quiz-organize':
                this.updateQuizManageCollectionSelect();
                this.updateQuizManageList();
                break;
            case 'move':
                this.updateMoveCollectionSelects();
                break;
            case 'collection-folder-move':
                this.updateCollectionFolderMoveUI();
                break;
            case 'quiz':
                this.updateQuizPresetSelect();
                this.updateQuizFolderCheckboxes();
                this.updateQuizCollectionCheckboxes();
                break;
            case 'edit':
                this.updateEditTabContext();
                break;
            case 'candidates':
                this.updateCandidatesUI();
                break;
            default:
                break;
        }
    }

    updateCollectionList() {
        const select = document.getElementById('collectionList');
        if (!select) return;

        select.innerHTML = '';

        const visibleCollections = this.getVisibleCollections();
        visibleCollections.forEach(collection => {
            const option = document.createElement('option');
            option.value = collection.id;
            const quizCount = this.getCollectionQuizCount(collection);
            const status = this.isCollectionDownloaded(collection) ? '' : ' [未DL]';
            option.style.backgroundColor = '#ffffff';
            option.style.color = '#1f2937';
            
            // 同期状態インジケーター（同期ONの時のみ表示）
            let syncStatusText = '';
            let syncIndicator = '';
            const syncStatus = this.isCollectionDownloaded(collection)
                ? collection.syncStatus
                : 'pending';
            if (this.syncEnabled) {
                if (syncStatus === 'synced') {
                    syncIndicator = '🟢';
                    syncStatusText = '同期済み';
                    option.style.backgroundColor = '#edf7f0';
                    option.style.color = '#1f5133';
                } else if (syncStatus === 'syncing') {
                    syncIndicator = '🟡';
                    syncStatusText = '同期中';
                    option.style.backgroundColor = '#fff8e8';
                    option.style.color = '#775a00';
                } else if (syncStatus === 'error') {
                    syncIndicator = '🔴';
                    syncStatusText = 'エラー';
                    option.style.backgroundColor = '#fdeff1';
                    option.style.color = '#7f1d1d';
                } else {
                    syncIndicator = '⚪';
                    syncStatusText = '未同期';
                    option.style.backgroundColor = '#f3f4f6';
                    option.style.color = '#374151';
                }
            }

            const syncLabel = syncStatusText ? `  ${syncIndicator} ${syncStatusText}` : '';
            option.textContent = `${collection.name} (${quizCount}問)${status}${syncLabel}`;
            if (this.currentCollection && collection.id === this.currentCollection.id) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    updateQuizList() {
        this.filterQuizzes();
    }

    difficultyLabel(difficulty) {
        // 難易度は 1〜10 の数値。
        // 未設定や範囲外の値が入っていても "undefined" と表示させない
        const level = parseInt(difficulty, 10);
        return (!isNaN(level) && level >= 1 && level <= 10) ? String(level) : '-';
    }

    /**
     * 問題1件分のDOMを組み立てる（問題一覧タブと並び替えタブで共用）。
     * 文字列は全て textContent で入れるため、問題文にHTMLが含まれていても解釈されない。
     */
    buildQuizItem(quiz, options = {}) {
        const { draggable = false, showTags = true } = options;

        const item = document.createElement('div');
        item.className = 'quiz-item';
        item.dataset.genre = quiz.genre;
        item.dataset.quizId = quiz.id;
        item.draggable = draggable;

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
        difficultyTag.textContent = this.difficultyLabel(quiz.difficulty);
        tagsDiv.appendChild(difficultyTag);

        if (showTags && Array.isArray(quiz.tags)) {
            quiz.tags.forEach(tag => {
                const tagSpan = document.createElement('span');
                tagSpan.className = 'tag';
                tagSpan.textContent = tag;
                tagsDiv.appendChild(tagSpan);
            });
        }

        item.appendChild(questionDiv);
        item.appendChild(answerDiv);
        item.appendChild(tagsDiv);

        // シングルクリックで選択、ダブルクリックで編集
        item.addEventListener('click', () => this.selectQuizOnly(quiz.id));
        item.addEventListener('dblclick', () => this.selectQuiz(quiz.id));

        return item;
    }

    // 検索・ジャンル・難易度による絞り込み（一覧タブと並び替えタブで共用）
    filterQuizList(quizzes, { searchText = '', genre = '', difficulty = '' }) {
        const needle = searchText.toLowerCase();
        return quizzes.filter(quiz => {
            const matchSearch = !needle ||
                String(quiz.question).toLowerCase().includes(needle) ||
                String(quiz.answer).toLowerCase().includes(needle);
            const matchGenre = !genre || quiz.genre === genre;
            const matchDifficulty = !difficulty || quiz.difficulty === parseInt(difficulty);
            return matchSearch && matchGenre && matchDifficulty;
        });
    }

    filterQuizzes() {
        const container = document.getElementById('quizList');
        if (!container) return;

        if (!this.currentCollection) {
            container.innerHTML = '<p style="padding:20px;">問題集を選択してください</p>';
            return;
        }

        if (!this.isCollectionDownloaded(this.currentCollection)) {
            container.innerHTML = `
                <p style="padding:20px;">この問題集は未同期です。上部の「📥ダウンロード」で取得してください。</p>
                <div style="padding:0 20px 20px;">
                    <button id="downloadCurrentCollectionBtn" class="btn btn-primary">この問題集をダウンロード</button>
                </div>
            `;
            const btn = document.getElementById('downloadCurrentCollectionBtn');
            if (btn) {
                const target = this.currentCollection;
                btn.addEventListener('click', () => this.downloadCollectionIfNeeded(target));
            }
            return;
        }

        const quizzes = this.filterQuizList(this.currentCollection.quizzes, {
            searchText: document.getElementById('searchBox').value,
            genre: document.getElementById('genreFilter').value,
            difficulty: document.getElementById('difficultyFilter').value
        });

        container.innerHTML = '';

        if (quizzes.length === 0) {
            container.innerHTML = '<p style="padding:20px;">問題がありません</p>';
            return;
        }

        // 1件ずつ append すると都度レイアウトが走るため、まとめて挿入する
        const fragment = document.createDocumentFragment();
        quizzes.forEach(quiz => fragment.appendChild(this.buildQuizItem(quiz)));
        container.appendChild(fragment);
    }

    updateGenreFilters() {
        // ジャンルは固定なので初回だけ構築すればよい
        if (this.genreFiltersInitialized) return;
        this.genreFiltersInitialized = true;

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

        const quizManageGenreFilter = document.getElementById('quizManageGenreFilter');
        if (quizManageGenreFilter) {
            quizManageGenreFilter.innerHTML = '<option value="">全ジャンル</option>';
            genres.forEach(genre => {
                const option = document.createElement('option');
                option.value = genre;
                option.textContent = genre;
                quizManageGenreFilter.appendChild(option);
            });
        }
    }

    updateQuizManageCollectionSelect() {
        const select = document.getElementById('quizManageCollection');
        if (!select) return;

        const current = this.currentCollection ? this.currentCollection.id : '';
        select.innerHTML = '<option value="">問題集を選択...</option>';

        this.collections.forEach(collection => {
            const option = document.createElement('option');
            option.value = collection.id;
            option.textContent = `${collection.name} (${this.getCollectionQuizCount(collection)}問)`;
            if (current && collection.id === current) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    updateQuizManageList() {
        const container = document.getElementById('quizManageList');
        if (!container) return;

        const selectedCollectionId = document.getElementById('quizManageCollection')?.value;
        if (selectedCollectionId && (!this.currentCollection || this.currentCollection.id !== selectedCollectionId)) {
            this.currentCollection = this.collections.find(c => c.id === selectedCollectionId) || null;
            this.currentQuiz = null;
        }

        if (!this.currentCollection) {
            container.innerHTML = '<p style="padding:20px;">問題集を選択してください</p>';
            return;
        }

        if (!this.isCollectionDownloaded(this.currentCollection)) {
            container.innerHTML = '<p style="padding:20px;">未ダウンロードの問題集はこのタブでは編集できません</p>';
            return;
        }

        const quizzes = this.filterQuizList(this.currentCollection.quizzes, {
            searchText: document.getElementById('quizManageSearch')?.value || '',
            genre: document.getElementById('quizManageGenreFilter')?.value || '',
            difficulty: document.getElementById('quizManageDifficultyFilter')?.value || ''
        });

        container.innerHTML = '';
        if (quizzes.length === 0) {
            container.innerHTML = '<p style="padding:20px;">問題がありません</p>';
            return;
        }

        const fragment = document.createDocumentFragment();

        quizzes.forEach((quiz, index) => {
            const item = this.buildQuizItem(quiz, { draggable: true, showTags: false });

            const controlsDiv = document.createElement('div');
            controlsDiv.className = 'quiz-item-controls';

            const upBtn = document.createElement('button');
            upBtn.innerHTML = '▲';
            upBtn.title = '上に移動';
            upBtn.disabled = index === 0;
            upBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.moveQuizUp(quiz.id);
                this.updateQuizManageList();
            });

            const downBtn = document.createElement('button');
            downBtn.innerHTML = '▼';
            downBtn.title = '下に移動';
            downBtn.disabled = index === quizzes.length - 1;
            downBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.moveQuizDown(quiz.id);
                this.updateQuizManageList();
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.innerHTML = '🗑';
            deleteBtn.title = 'この問題を削除';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.currentQuiz = quiz;
                this.deleteQuiz();
                this.updateQuizManageList();
            });

            controlsDiv.appendChild(upBtn);
            controlsDiv.appendChild(downBtn);
            controlsDiv.appendChild(deleteBtn);
            item.appendChild(controlsDiv);

            item.addEventListener('dragstart', (e) => this.handleDragStart(e));
            item.addEventListener('dragover', (e) => this.handleDragOver(e));
            item.addEventListener('drop', (e) => { this.handleDrop(e); this.updateQuizManageList(); });
            item.addEventListener('dragenter', (e) => this.handleDragEnter(e));
            item.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            item.addEventListener('dragend', (e) => this.handleDragEnd(e));

            fragment.appendChild(item);
        });

        container.appendChild(fragment);
    }

    syncQuizSelectionState() {
        const folderNames = this.folders.map(folder => folder.name);
        const collectionIds = new Set(this.collections.map(collection => collection.id));

        if (!this.quizSelectionInitialized) {
            this.quizSelectedFolderNames = new Set(folderNames);
            this.quizSelectedCollectionIds = new Set(
                this.collections
                    .filter(collection => this.isCollectionDownloaded(collection))
                    .map(collection => collection.id)
            );
            this.quizSelectionInitialized = true;
            return;
        }

        // 消えたフォルダ・問題集への参照だけを落とす。
        // 「全解除」を押した状態を勝手に全選択へ戻さないよう、空のままでも触らない
        this.quizSelectedFolderNames = new Set(
            [...this.quizSelectedFolderNames].filter(name => folderNames.includes(name))
        );

        this.quizSelectedCollectionIds = new Set(
            [...this.quizSelectedCollectionIds].filter(id => collectionIds.has(id))
        );
    }

    // 選択中フォルダに入っている問題集（未DLも含む）
    getFolderFilteredCollections() {
        const selectedFolders = this.quizSelectedFolderNames;
        return this.collections.filter(collection =>
            selectedFolders.has(collection.folder || this.defaultFolderName)
        );
    }

    // 実際に出題対象になる問題集（フォルダも問題集もチェック済み、かつダウンロード済み）
    getSelectedQuizCollections() {
        return this.getFolderFilteredCollections().filter(collection =>
            this.quizSelectedCollectionIds.has(collection.id) &&
            this.isCollectionDownloaded(collection)
        );
    }

    buildQuizCheckItem({ value, labelText, countText, checked, disabled = false, title = '' }) {
        const label = document.createElement('label');
        label.className = 'check-item';
        label.classList.toggle('checked', checked);
        label.classList.toggle('disabled', disabled);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = value;
        checkbox.checked = checked;
        checkbox.disabled = disabled;

        const textSpan = document.createElement('span');
        textSpan.className = 'check-item-label';
        textSpan.textContent = labelText;
        if (title) textSpan.title = title;

        label.appendChild(checkbox);
        label.appendChild(textSpan);

        if (countText) {
            const countSpan = document.createElement('span');
            countSpan.className = 'check-item-count';
            countSpan.textContent = countText;
            label.appendChild(countSpan);
        }

        return label;
    }

    showCheckGridMessage(container, message) {
        const paragraph = document.createElement('p');
        paragraph.className = 'check-grid-empty';
        paragraph.textContent = message;
        container.appendChild(paragraph);
    }

    updateQuizFolderCheckboxes() {
        const container = document.getElementById('quizFolderCheckboxes');
        if (!container) return;

        this.syncQuizSelectionState();
        container.innerHTML = '';

        if (this.folders.length === 0) {
            this.showCheckGridMessage(container, 'フォルダがありません');
            this.updateQuizFolderCount(0);
            return;
        }

        const keyword = this.quizFolderSearch.trim().toLowerCase();
        const visibleFolders = keyword
            ? this.folders.filter(folder => folder.name.toLowerCase().includes(keyword))
            : this.folders;

        if (visibleFolders.length === 0) {
            this.showCheckGridMessage(container, '絞り込みに一致するフォルダがありません');
            this.updateQuizFolderCount(0);
            return;
        }

        visibleFolders.forEach(folder => {
            const usage = this.getFolderUsage(folder.name);
            container.appendChild(this.buildQuizCheckItem({
                value: folder.name,
                labelText: folder.name,
                countText: `${usage.collectionCount}集`,
                checked: this.quizSelectedFolderNames.has(folder.name),
                title: `${folder.name}（${usage.collectionCount}問題集 / ${usage.quizCount}問）`
            }));
        });

        this.updateQuizFolderCount(visibleFolders.length);
    }

    updateQuizFolderCount(visibleCount) {
        const el = document.getElementById('quizFolderCount');
        if (!el) return;
        const total = this.folders.length;
        const selected = this.quizSelectedFolderNames.size;
        const filtered = visibleCount === total ? '' : `（表示中 ${visibleCount}）`;
        el.textContent = `${selected} / ${total} 選択${filtered}`;
    }

    updateQuizCollectionCheckboxes() {
        const container = document.getElementById('quizCollectionCheckboxes');
        if (!container) return;

        this.syncQuizSelectionState();
        container.innerHTML = '';

        const targetCollections = this.getFolderFilteredCollections();

        // 未ダウンロードの問題集は出題できないので、選択からは外しておく
        targetCollections.forEach(collection => {
            if (!this.isCollectionDownloaded(collection)) {
                this.quizSelectedCollectionIds.delete(collection.id);
            }
        });

        if (this.quizSelectedFolderNames.size === 0) {
            this.showCheckGridMessage(container, '先にフォルダを選択してください');
            this.updateQuizCollectionCount(0, 0);
            this.updateQuizSelectionSummary();
            return;
        }

        if (targetCollections.length === 0) {
            this.showCheckGridMessage(container, '選択中のフォルダに問題集がありません');
            this.updateQuizCollectionCount(0, 0);
            this.updateQuizSelectionSummary();
            return;
        }

        const keyword = this.quizCollectionSearch.trim().toLowerCase();
        const visibleCollections = keyword
            ? targetCollections.filter(collection => collection.name.toLowerCase().includes(keyword))
            : targetCollections;

        if (visibleCollections.length === 0) {
            this.showCheckGridMessage(container, '絞り込みに一致する問題集がありません');
            this.updateQuizCollectionCount(0, targetCollections.length);
            this.updateQuizSelectionSummary();
            return;
        }

        visibleCollections.forEach(collection => {
            const downloadable = this.isCollectionDownloaded(collection);
            const quizCount = this.getCollectionQuizCount(collection);
            const folderName = collection.folder || this.defaultFolderName;
            container.appendChild(this.buildQuizCheckItem({
                value: collection.id,
                labelText: collection.name + (downloadable ? '' : ' [未DL]'),
                countText: `${quizCount}問`,
                checked: downloadable && this.quizSelectedCollectionIds.has(collection.id),
                disabled: !downloadable,
                title: `${collection.name}（${folderName} / ${quizCount}問）`
            }));
        });

        this.updateQuizCollectionCount(visibleCollections.length, targetCollections.length);
        this.updateQuizSelectionSummary();
    }

    updateQuizCollectionCount(visibleCount, totalCount) {
        const el = document.getElementById('quizCollectionCount');
        if (!el) return;
        const selected = this.getSelectedQuizCollections().length;
        const filtered = visibleCount === totalCount ? '' : `（表示中 ${visibleCount}）`;
        el.textContent = `${selected} / ${totalCount} 選択${filtered}`;
    }

    updateQuizSelectionSummary() {
        const el = document.getElementById('quizSelectionSummary');
        if (!el) return;

        const selected = this.getSelectedQuizCollections();
        if (selected.length === 0) {
            el.textContent = '出題する問題集が選ばれていません';
            el.classList.add('is-empty');
            return;
        }

        el.classList.remove('is-empty');
        const quizCount = selected.reduce((sum, collection) => sum + this.getCollectionQuizCount(collection), 0);
        const names = selected.slice(0, 3).map(collection => collection.name).join('、');
        const more = selected.length > 3 ? ` ほか${selected.length - 3}件` : '';
        el.textContent = `出題対象: ${selected.length}問題集 / ${quizCount}問（${names}${more}）`;
    }

    // 絞り込みで隠れている選択まで消さないよう、DOMではなく選択集合を直接更新する
    onQuizFolderToggle(checkbox) {
        if (checkbox.checked) {
            this.quizSelectedFolderNames.add(checkbox.value);
        } else {
            this.quizSelectedFolderNames.delete(checkbox.value);
        }

        const label = checkbox.closest('.check-item');
        if (label) label.classList.toggle('checked', checkbox.checked);

        this.updateQuizFolderCount(document.querySelectorAll('#quizFolderCheckboxes .check-item').length);
        this.updateQuizCollectionCheckboxes();
    }

    onQuizCollectionToggle(checkbox) {
        if (checkbox.checked) {
            this.quizSelectedCollectionIds.add(checkbox.value);
        } else {
            this.quizSelectedCollectionIds.delete(checkbox.value);
        }

        const label = checkbox.closest('.check-item');
        if (label) label.classList.toggle('checked', checkbox.checked);

        this.updateQuizCollectionCount(
            document.querySelectorAll('#quizCollectionCheckboxes .check-item').length,
            this.getFolderFilteredCollections().length
        );
        this.updateQuizSelectionSummary();
    }

    setAllVisibleQuizFolders(checked) {
        document.querySelectorAll('#quizFolderCheckboxes input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = checked;
            const label = checkbox.closest('.check-item');
            if (label) label.classList.toggle('checked', checked);
            if (checked) {
                this.quizSelectedFolderNames.add(checkbox.value);
            } else {
                this.quizSelectedFolderNames.delete(checkbox.value);
            }
        });

        this.updateQuizFolderCount(document.querySelectorAll('#quizFolderCheckboxes .check-item').length);
        this.updateQuizCollectionCheckboxes();
    }

    setAllVisibleQuizCollections(checked) {
        document.querySelectorAll('#quizCollectionCheckboxes input[type="checkbox"]:not(:disabled)').forEach(checkbox => {
            checkbox.checked = checked;
            const label = checkbox.closest('.check-item');
            if (label) label.classList.toggle('checked', checked);
            if (checked) {
                this.quizSelectedCollectionIds.add(checkbox.value);
            } else {
                this.quizSelectedCollectionIds.delete(checkbox.value);
            }
        });

        this.updateQuizCollectionCount(
            document.querySelectorAll('#quizCollectionCheckboxes .check-item').length,
            this.getFolderFilteredCollections().length
        );
        this.updateQuizSelectionSummary();
    }

    // ================== 出題プリセット ==================
    getQuizPresetById(presetId) {
        return this.quizPresets.find(preset => preset.id === presetId) || null;
    }

    updateQuizPresetSelect() {
        const select = document.getElementById('quizPresetSelect');
        if (!select) return;

        select.innerHTML = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = this.quizPresets.length === 0 ? '（プリセットなし）' : '（未選択）';
        select.appendChild(blank);

        this.quizPresets.forEach(preset => {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = `${preset.name}（${preset.collectionIds.length}問題集）`;
            select.appendChild(option);
        });

        select.value = this.getQuizPresetById(this.selectedQuizPresetId) ? this.selectedQuizPresetId : '';
        this.selectedQuizPresetId = select.value;
    }

    buildQuizPresetPayload() {
        const genreFilter = document.getElementById('quizGenreFilter');
        const difficultyFilter = document.getElementById('quizDifficultyFilter');
        return {
            folderNames: [...this.quizSelectedFolderNames],
            collectionIds: this.getSelectedQuizCollections().map(collection => collection.id),
            genre: genreFilter ? genreFilter.value : '',
            difficulty: difficultyFilter ? difficultyFilter.value : ''
        };
    }

    saveQuizPreset() {
        this.syncQuizSelectionState();
        const payload = this.buildQuizPresetPayload();
        if (payload.collectionIds.length === 0) {
            alert('保存する問題集が選ばれていません');
            return;
        }

        const input = prompt('プリセット名を入力してください:');
        if (!input || !input.trim()) return;
        const name = input.trim();

        const existing = this.quizPresets.find(preset => preset.name === name);
        const now = new Date().toISOString();

        if (existing) {
            if (!confirm(`プリセット「${name}」は既にあります。上書きしますか？`)) return;
            Object.assign(existing, payload, { updated_at: now });
            this.selectedQuizPresetId = existing.id;
        } else {
            const preset = {
                id: `preset_${Date.now()}`,
                name: name,
                ...payload,
                created_at: now,
                updated_at: now
            };
            this.quizPresets.push(preset);
            this.selectedQuizPresetId = preset.id;
        }

        this.updateQuizPresetSelect();
        this.saveToLocalStorage();
        console.log(`📋 出題プリセットを保存: "${name}" (${payload.collectionIds.length}問題集)`);
        this.showNotification(
            `<strong>📋 プリセットを保存しました</strong><br><small>${escapeHtml(name)}（${payload.collectionIds.length}問題集）</small>`,
            'success'
        );
    }

    overwriteQuizPreset() {
        const preset = this.getQuizPresetById(this.selectedQuizPresetId);
        if (!preset) {
            alert('上書きするプリセットを選んでください');
            return;
        }

        this.syncQuizSelectionState();
        const payload = this.buildQuizPresetPayload();
        if (payload.collectionIds.length === 0) {
            alert('保存する問題集が選ばれていません');
            return;
        }
        if (!confirm(`プリセット「${preset.name}」を今の選択内容で上書きしますか？`)) return;

        Object.assign(preset, payload, { updated_at: new Date().toISOString() });
        this.updateQuizPresetSelect();
        this.saveToLocalStorage();
        this.showNotification(
            `<strong>📋 プリセットを上書きしました</strong><br><small>${escapeHtml(preset.name)}（${payload.collectionIds.length}問題集）</small>`,
            'success'
        );
    }

    applyQuizPreset() {
        const preset = this.getQuizPresetById(this.selectedQuizPresetId);
        if (!preset) {
            alert('読み込むプリセットを選んでください');
            return;
        }

        const folderNames = new Set(this.folders.map(folder => folder.name));
        const collectionIds = new Set(this.collections.map(collection => collection.id));
        const missingCount =
            preset.folderNames.filter(name => !folderNames.has(name)).length +
            preset.collectionIds.filter(id => !collectionIds.has(id)).length;

        this.quizSelectionInitialized = true;
        this.quizSelectedFolderNames = new Set(preset.folderNames.filter(name => folderNames.has(name)));
        this.quizSelectedCollectionIds = new Set(preset.collectionIds.filter(id => collectionIds.has(id)));

        // 問題集が入っているフォルダのチェックが外れていると出題対象から漏れるので補う
        // （プリセット保存後に問題集を別フォルダへ移動した場合など）
        this.collections.forEach(collection => {
            if (this.quizSelectedCollectionIds.has(collection.id)) {
                this.quizSelectedFolderNames.add(collection.folder || this.defaultFolderName);
            }
        });

        const genreFilter = document.getElementById('quizGenreFilter');
        const difficultyFilter = document.getElementById('quizDifficultyFilter');
        // 選択肢に無い値を入れた場合は空（＝全て）に落ちる
        if (genreFilter) genreFilter.value = preset.genre || '';
        if (difficultyFilter) difficultyFilter.value = preset.difficulty || '';

        this.quizFolderSearch = '';
        this.quizCollectionSearch = '';
        const folderSearch = document.getElementById('quizFolderSearch');
        if (folderSearch) folderSearch.value = '';
        const collectionSearch = document.getElementById('quizCollectionSearch');
        if (collectionSearch) collectionSearch.value = '';

        this.updateQuizFolderCheckboxes();
        this.updateQuizCollectionCheckboxes();

        console.log(`📋 出題プリセットを読み込み: "${preset.name}"`);
        if (missingCount > 0) {
            this.showNotification(
                `<strong>📋 プリセットを読み込みました</strong><br><small>${missingCount}件は見つかりませんでした（削除・移動された可能性があります）</small>`,
                'warning'
            );
        } else {
            this.showNotification(
                `<strong>📋 プリセットを読み込みました</strong><br><small>${escapeHtml(preset.name)}</small>`,
                'success'
            );
        }
    }

    deleteQuizPreset() {
        const preset = this.getQuizPresetById(this.selectedQuizPresetId);
        if (!preset) {
            alert('削除するプリセットを選んでください');
            return;
        }
        if (!confirm(`プリセット「${preset.name}」を削除しますか？`)) return;

        this.quizPresets = this.quizPresets.filter(item => item.id !== preset.id);
        this.selectedQuizPresetId = '';
        this.updateQuizPresetSelect();
        this.saveToLocalStorage();
    }

    // ================== 出題機能 ==================
    startQuizMode() {
        this.syncQuizSelectionState();

        // フォルダのチェックが外れていると問題集を選んでいても対象外になるので、
        // 実際に出題できる問題集の数で判定する
        const selectedCollections = this.getSelectedQuizCollections();

        if (selectedCollections.length === 0) {
            alert('出題する問題集を選択してください');
            return;
        }

        let quizzes = [];
        selectedCollections.forEach(collection => {
            // ディープコピーして元のデータに影響しないようにする。
            // 複数の問題集を混ぜてもシャッフルしても元をたどれるよう、出典を持たせておく
            quizzes = quizzes.concat(collection.quizzes.map(q => ({
                ...q,
                sourceCollectionId: collection.id,
                sourceCollectionName: collection.name
            })));
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
        this.quizMode.editReturn = null;

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
        this.quizMode.editReturn = null;

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

        // 出典（どの問題集の問題か）。複数の問題集を混ぜているときの目印になる
        const sourceTag = document.getElementById('quizSourceTag');
        if (sourceTag) {
            if (quiz.sourceCollectionName) {
                sourceTag.textContent = `📚 ${quiz.sourceCollectionName}`;
                sourceTag.style.display = 'inline-block';
            } else {
                sourceTag.style.display = 'none';
            }
        }

        // ジャンルタグ
        const genreTag = document.getElementById('quizGenreTag');
        genreTag.textContent = quiz.genre;
        genreTag.style.backgroundColor = this.getGenreColor(quiz.genre);

        // 難易度タグ
        const difficultyTag = document.getElementById('quizDifficultyTag');
        difficultyTag.textContent = this.difficultyLabel(quiz.difficulty);

        // ファクトチェック済みかどうか
        this.updateFactCheckedDisplay(quiz.factChecked);

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

    // ================== ファクトチェック済みの記録 ==================
    updateFactCheckedDisplay(checked) {
        const tag = document.getElementById('quizFactCheckedTag');
        if (tag) {
            tag.textContent = checked ? '✅ ファクトチェック済み' : '⬜ 未確認';
            tag.classList.toggle('checked', !!checked);
            tag.classList.toggle('unchecked', !checked);
        }

        const btn = document.getElementById('toggleFactCheckedBtn');
        if (btn) {
            btn.textContent = checked ? '✅ 確認済み' : '⬜ 未確認';
            btn.title = checked
                ? 'ファクトチェック済みを取り消す（Fキー）'
                : 'ファクトチェック済みにする（Fキー）';
        }
    }

    toggleFactCheckedForCurrentQuiz() {
        if (this.isViewMode) return;
        if (!this.quizMode.active) return;

        const displayed = this.quizMode.quizzes[this.quizMode.currentIndex];
        if (!displayed) return;

        // 出題中の一覧は開始時のコピーなので、元の問題集の中身を書き換える
        const collection = this.collections.find(col => col.id === displayed.sourceCollectionId);
        if (!collection || !this.isCollectionDownloaded(collection)) {
            alert('この問題の問題集が見つからないため変更できません');
            return;
        }
        const target = collection.quizzes.find(q => q.id === displayed.id);
        if (!target) {
            alert('元の問題が見つかりませんでした（削除された可能性があります）');
            return;
        }

        target.factChecked = !target.factChecked;
        displayed.factChecked = target.factChecked;
        if (this.currentQuiz && this.currentQuiz.id === target.id) {
            this.currentQuiz = target;
        }

        this.updateFactCheckedDisplay(target.factChecked);
        this.saveToLocalStorage();
        console.log(`${target.factChecked ? '✅' : '⬜'} ファクトチェック${target.factChecked ? '済みにしました' : 'を取り消しました'}: "${target.question.substring(0, 30)}..."`);
    }

    // ================== 出題中の問題を編集 ==================
    editCurrentQuiz() {
        if (this.isViewMode) return;
        if (!this.quizMode.active) return;

        const displayed = this.quizMode.quizzes[this.quizMode.currentIndex];
        if (!displayed) return;

        // 出題中の一覧は開始時のコピーなので、出典IDから元の問題集をたどる
        const collection = this.collections.find(col => col.id === displayed.sourceCollectionId);
        if (!collection) {
            alert('この問題の問題集が見つかりませんでした（削除された可能性があります）');
            return;
        }
        if (!this.isCollectionDownloaded(collection)) {
            alert('この問題集は未ダウンロードのため編集できません。先に問題集を開いてダウンロードしてください。');
            return;
        }

        const target = collection.quizzes.find(q => q.id === displayed.id);
        if (!target) {
            alert('元の問題が見つかりませんでした（削除された可能性があります）');
            return;
        }

        this.quizMode.editReturn = { collectionId: collection.id, quizId: target.id };
        this.currentCollection = collection;
        this.currentQuiz = target;

        // 問題集管理タブの表示も、いま編集している問題集に合わせておく
        const folder = this.folders.find(f => f.name === (collection.folder || this.defaultFolderName));
        if (folder) this.selectedFolderId = folder.id;

        this.fillEditForm(target);
        this.switchTab('edit');
        this.updateFolderList();
        this.updateCollectionList();

        console.log(`✏️ 出題中の問題を編集: "${target.question.substring(0, 30)}..." (問題集: ${collection.name})`);
    }

    returnToQuizMode() {
        this.quizMode.editReturn = null;
        this.switchTab('quiz');
        if (this.quizMode.active) {
            this.displayCurrentQuiz();
        }
    }

    // 出題中の一覧は開始時のコピーなので、編集した内容を反映しておく
    syncQuizModeQuiz(collectionId, quiz) {
        if (!this.quizMode.active) return;

        this.quizMode.quizzes = this.quizMode.quizzes.map(item => {
            if (item.sourceCollectionId !== collectionId || item.id !== quiz.id) return item;
            return {
                ...quiz,
                sourceCollectionId: item.sourceCollectionId,
                sourceCollectionName: item.sourceCollectionName
            };
        });
    }

    updateEditTabContext() {
        const fromQuiz = !!(this.quizMode.active && this.quizMode.editReturn);

        const backBtn = document.getElementById('backToQuizBtn');
        if (backBtn) backBtn.style.display = fromQuiz ? 'inline-block' : 'none';

        const bar = document.getElementById('editContextBar');
        if (!bar) return;

        if (!this.currentCollection) {
            bar.style.display = 'none';
            bar.textContent = '';
            return;
        }

        let positionText = '新規問題';
        if (this.currentQuiz && Array.isArray(this.currentCollection.quizzes)) {
            const index = this.currentCollection.quizzes.findIndex(q => q.id === this.currentQuiz.id);
            if (index !== -1) {
                positionText = `${index + 1} / ${this.currentCollection.quizzes.length}問目`;
            }
        }

        const suffix = fromQuiz ? '（出題画面から移動）' : '';
        bar.textContent = `編集中: ${this.currentCollection.name} — ${positionText}${suffix}`;
        bar.style.display = 'block';
    }

    // ================== テキスト整形 ==================
    formatText(text) {
        // 先にHTMLをエスケープする。
        // 問題文はCSV/JSON取り込みやクラウド同期で外部から入りうるため、
        // <img onerror=...> のようなタグをそのまま解釈させない。
        let html = escapeHtml(text);

        // ふりがな処理: 漢字(かんじ) → <ruby>漢字<rt>かんじ</rt></ruby>
        html = html.replace(/([一-龯々]+)\(([ぁ-んー]+)\)/g, '<ruby>$1<rt>$2</rt></ruby>');

        // 色付き処理: <color>テキスト</color> → <span class="colored-text">テキスト</span>
        // エスケープ済みなので &lt;color&gt; にマッチさせる
        html = html.replace(/&lt;color&gt;([\s\S]*?)&lt;\/color&gt;/g, '<span class="colored-text">$1</span>');

        return html;
    }

    stripFormatting(text) {
        // フォーマットを削除してプレーンテキストに
        // （戻り値は textContent 経由でのみ使うこと）
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/([一-龯々]+)\(([ぁ-んー]+)\)/g, '$1')
            .replace(/<color>([\s\S]*?)<\/color>/g, '$1');
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

        // 削除で後ろの要素が1つ前へずれるが、ここでは補正しないのが正しい。
        // 下へ移動: ドロップ先の直後 / 上へ移動: ドロップ先の直前 に入り、
        // どちらもドラッグしてきた向きから見て自然な位置になる。
        this.currentCollection.quizzes.splice(targetIndex, 0, draggedQuiz);

        appDebugLog(`🔄 問題を挿入: ${draggedIndex + 1} → ${targetIndex + 1}`);

        this.updateQuizList();
        this.updateQuizManageList();
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
        this.updateQuizManageList();
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

        const totalQuizzes = this.collections.reduce((sum, c) => sum + this.getCollectionQuizCount(c), 0);
        console.log(`📤 クラウド差分同期を実行中... (${this.collections.length}問題集, ${totalQuizzes}問)`);
        
        try {
            // 各 collection を syncing 状態に設定
            this.collections.forEach(col => {
                if (col) window.firebaseSync.setCollectionSyncStatus(col, 'syncing');
            });
            this.updateCollectionList();

            // Collection と フォルダ構成を同時に保存
            appDebugLog(`🔍 [DEBUG] フォルダをクラウドに保存: ${this.folders.length}個`, this.folders.map(f => f.name));
            const [syncResult] = await Promise.all([
                // クラウドの一覧を確実に把握できているときだけ、差分削除を許可する
                window.firebaseSync.saveCollections(this.collections, { allowDeletions: this.cloudViewComplete }),
                window.firebaseSync.saveFolders(this.folders)
            ]);
            appDebugLog('🔍 [DEBUG] フォルダ保存完了');

            const uploadedCount = syncResult?.uploadedCount || 0;
            const skippedCount = syncResult?.skippedCount || 0;
            const deletedCount = syncResult?.deletedCount || 0;
            const fallback = Boolean(syncResult?.fallback);

            // 全て synced 状態に
            this.collections.forEach(col => {
                if (col) window.firebaseSync.setCollectionSyncStatus(col, 'synced');
            });
            this.updateCollectionList();

            if (fallback) {
                console.log('✅ クラウドにアップロード成功（旧形式フォールバック）');
                this.setLastSync('成功', `旧形式保存: ${this.collections.length}問題集`);
                this.showNotification(`<strong>☁️ クラウドに保存しました</strong><br><small>旧形式で全体保存（${this.collections.length}問題集）</small>`, 'success');
            } else {
                console.log(`✅ クラウド差分同期成功 (更新:${uploadedCount}, スキップ:${skippedCount}, 削除:${deletedCount})`);
                this.setLastSync('成功', `更新:${uploadedCount} / スキップ:${skippedCount} / 削除:${deletedCount}`);
                this.showNotification(`<strong>☁️ クラウド差分同期しました</strong><br><small>更新:${uploadedCount}件 / スキップ:${skippedCount}件 / 削除:${deletedCount}件</small>`, 'success');
            }
        } catch (err) {
            console.error('❌ クラウドアップロードエラー:', err);
            this.collections.forEach(col => {
                if (col) window.firebaseSync.setCollectionSyncStatus(col, 'error');
            });
            this.updateCollectionList();
            this.setLastSync('失敗', err.message || '保存エラー');
            this.showNotification(`<strong>⚠️ クラウド保存に失敗</strong><br><small>${escapeHtml(err.message)}</small>`, 'error');
        }
    }

    // ================== データ保存・読み込み ==================

    /**
     * 画面右上に通知を表示する。
     * @param {string} message HTMLとして解釈される。外部由来の文字列を含める場合は
     *                         必ず escapeHtml() を通してから渡すこと。
     */
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
                folders: this.folders,
                selectedFolderId: this.selectedFolderId,
                limits: this.limits,
                candidates: this.candidates,
                settings: this.settings,
                quizPresets: this.quizPresets,
                saved_at: new Date().toISOString()
            };
            
            const jsonData = JSON.stringify(data);
            // localStorage の使用量は UTF-16 の符号単位で数えられるため length * 2 バイトで見積もる。
            // （Blob を作るとデータ全体をもう一度コピーすることになり、保存のたびに無駄が出る）
            const dataSize = jsonData.length * 2;
            const dataSizeMB = (dataSize / 1024 / 1024).toFixed(2);

            // LocalStorageの容量チェック（通常5-10MBが上限）
            if (dataSize > 4.5 * 1024 * 1024) {
                console.warn(`⚠️ データサイズが大きいです: ${dataSizeMB}MB`);
                console.warn('問題集が多すぎる場合、一部を別ファイルに保存することを推奨します');
            }

            localStorage.setItem('quizManagerData', jsonData);
            appDebugLog(`✅ ローカルストレージに保存成功 (${dataSizeMB}MB, ${this.collections.length}問題集)`);

            // Firestore同期は即時ではなく遅延実行
            this.scheduleCloudUpload();
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
                        if (!col.folder) {
                            col.folder = this.defaultFolderName;
                        }
                        if (!col.quizzes || !Array.isArray(col.quizzes)) {
                            console.warn(`⚠️ 問題集「${col.name}」のデータが不正です。修復します。`);
                            col.quizzes = [];
                        }
                        // 未ダウンロードの問題集は quizzes が空配列なので、
                        // ここで上書きするとクラウド由来の問題数が 0 に潰れてしまう
                        if (col.isDownloaded !== false) {
                            col.quizCount = col.quizzes.length;
                        }
                        if (typeof col.isDownloaded !== 'boolean') col.isDownloaded = true;
                        if (typeof col.isCloudPlaceholder !== 'boolean') col.isCloudPlaceholder = false;
                        if (!col.downloadedUpdateId && col.isDownloaded) {
                            col.downloadedUpdateId = col.lastUpdateId || null;
                        }
                        
                        // 同期状態を初期化（localStorageから読み込まれていなければ pending に）
                        if (!col.syncStatus) col.syncStatus = 'pending';
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
                // 出題時フォントサイズの既定を 20px から 32px へ変更した。
                // 既定のままだった場合だけ引き上げ、自分で変えた値はそのまま残す
                if (this.settings.quizFontSize === 20) {
                    this.settings.quizFontSize = 32;
                }
                this.limits = parsed.limits || this.limits;
                this.quizPresets = (Array.isArray(parsed.quizPresets) ? parsed.quizPresets : [])
                    .filter(preset => preset && preset.id && preset.name)
                    .map(preset => ({
                        ...preset,
                        folderNames: Array.isArray(preset.folderNames) ? preset.folderNames : [],
                        collectionIds: Array.isArray(preset.collectionIds) ? preset.collectionIds : []
                    }));
                if (Array.isArray(parsed.folders) && parsed.folders.length > 0) {
                    this.folders = parsed.folders;
                }
                this.selectedFolderId = parsed.selectedFolderId || this.selectedFolderId;
                this.ensureFoldersFromCollections();

                const visibleCollections = this.getVisibleCollections();
                if (visibleCollections.length > 0) {
                    this.currentCollection = visibleCollections[0];
                } else if (this.collections.length > 0) {
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
            folders: this.folders,
            selectedFolderId: this.selectedFolderId,
            limits: this.limits,
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
                            if (quiz.difficulty > 10) quiz.difficulty = 10;
                        } else {
                            quiz.difficulty = 5; // デフォルト
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
                    if (Array.isArray(data.folders) && data.folders.length > 0) {
                        this.folders = data.folders;
                    }
                    if (data.selectedFolderId) {
                        this.selectedFolderId = data.selectedFolderId;
                    }
                    if (data.limits) {
                        this.limits = data.limits;
                    }
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

            // 起動高速化のため、まずメタデータのみを取得
            this.showSyncOverlay('☁️ クラウドに接続中...', 'データを確認しています');
            let metas = [];
            let cloudFolders = null;
            let metaLoadFailed = false;
            try {
                // 問題集メタデータとフォルダ情報を同時に取得
                const [metasResult, foldersResult] = await Promise.all([
                    this.withTimeout(
                        window.firebaseSync.loadCollectionMetas(),
                        12000,
                        'クラウドメタデータ取得がタイムアウトしました'
                    ),
                    this.withTimeout(
                        window.firebaseSync.readFolders(),
                        12000,
                        'フォルダ情報取得がタイムアウトしました'
                    )
                ]);
                metas = metasResult;
                cloudFolders = foldersResult;
            } catch (metaError) {
                console.warn('⚠️ クラウドメタデータ取得に失敗（ローカル継続）:', metaError);
                metas = [];
                cloudFolders = null;
                metaLoadFailed = true;
            } finally {
                this.hideSyncOverlay();
            }

            if (metaLoadFailed) {
                // クラウドの状態が分からないまま「クラウドは空」とみなして上書きすると、
                // クラウド側のデータを壊しかねないため何もしない
                this.updateSyncUI();
                this.showNotification(
                    '<strong>⚠️ クラウドの一覧を取得できませんでした</strong><br><small>同期はONにしましたが、アップロードは次回の保存時に行います</small>',
                    'warning'
                );
                return;
            }

            if (metas && metas.length > 0) {
                const useFirestore = confirm(
                    '☁️ クラウドにデータが見つかりました\n\n' +
                    `クラウド: ${metas.length}個の問題集\n` +
                    `ローカル: ${this.collections.length}個の問題集\n\n` +
                    'クラウドの問題集一覧を使用しますか？\n(問題本文は選択時にダウンロードされます)\n\n' +
                    '(キャンセル = ローカルを優先してクラウドに上書き)'
                );

                if (useFirestore) {
                    this.isLoadingFromFirestore = true;
                    this.collections = this.mergeCollectionsWithCloudMetas(metas);
                    this.cloudViewComplete = true;

                    // クラウドからフォルダ情報を読み込む
                    if (cloudFolders && Array.isArray(cloudFolders.folders)) {
                        console.log(`📁 クラウドからフォルダ情報を読み込み: ${cloudFolders.folders.length}個`);
                        this.folders = cloudFolders.folders;
                        this.ensureDefaultFolder();
                    }
                    
                    if (this.collections.length > 0) {
                        this.currentCollection = this.collections[0];
                    }
                    this.updateUI();
                    this.saveToLocalStorage();
                    this.isLoadingFromFirestore = false;
                }
            } else {
                // クラウドにデータがない場合、現在のデータをアップロード
                // （ここまで来ていればクラウドの状態は取得できているので、以降の差分同期で削除を許可してよい）
                this.cloudViewComplete = true;
                await Promise.all([
                    window.firebaseSync.saveCollections(this.collections, { allowDeletions: true }),
                    window.firebaseSync.saveFolders(this.folders)
                ]);
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

    async withTimeout(promise, timeoutMs, timeoutMessage) {
        let timerId;
        const timeoutPromise = new Promise((_, reject) => {
            timerId = setTimeout(() => {
                reject(new Error(timeoutMessage || '処理がタイムアウトしました'));
            }, timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            clearTimeout(timerId);
        }
    }

    async enableSyncSilently() {
        if (!window.firebaseSync) return;

        this.showSyncOverlay('☁️ クラウドに接続中...', 'Firebase を初期化しています');

        try {
            const success = await window.firebaseSync.enableSync();
            if (!success) {
                return;
            }

            this.syncEnabled = true;
            this.updateSyncOverlay('📥 問題集一覧を取得中...', 'クラウドからメタデータを取得しています');

            // 起動時はメタデータとフォルダ情報を読み込み（問題本文はオンデマンド）
            const [metas, cloudFolders] = await Promise.all([
                this.withTimeout(
                    window.firebaseSync.loadCollectionMetas(),
                    12000,
                    '問題集一覧の取得がタイムアウトしました'
                ),
                this.withTimeout(
                    window.firebaseSync.readFolders(),
                    12000,
                    'フォルダ情報の取得がタイムアウトしました'
                )
            ]);

            if (metas && metas.length > 0) {
                const totalQuizzes = metas.reduce((sum, meta) => sum + (meta.quizCount || 0), 0);
                this.updateSyncOverlay('✅ 問題集一覧を反映中...', `${metas.length} 問題集・${totalQuizzes} 問`);

                this.isLoadingFromFirestore = true;
                this.collections = this.mergeCollectionsWithCloudMetas(metas);
                this.cloudViewComplete = true;

                // クラウドからフォルダ情報を読み込む
                if (cloudFolders && Array.isArray(cloudFolders.folders)) {
                    console.log(`📁 クラウドからフォルダ情報を読み込み: ${cloudFolders.folders.length}個`);
                    this.folders = cloudFolders.folders;
                    this.ensureDefaultFolder();
                }

                if (this.collections.length > 0) {
                    this.currentCollection = this.collections[0];
                }
                this.updateUI();
                this.saveToLocalStorage();
                this.isLoadingFromFirestore = false;
                console.log('✅ 起動時にクラウドの問題集一覧を読み込みました（本文はオンデマンド）');
            } else {
                // クラウドが空だと確認できた場合もローカルが完全な状態
                this.cloudViewComplete = true;
            }

            this.updateSyncUI();
            await new Promise(r => setTimeout(r, 300));
        } catch (error) {
            console.warn('⚠️ 同期起動時のメタデータ取得に失敗（ローカル継続）:', error);
            this.updateSyncUI();
            this.showNotification('<strong>⚠️ クラウド一覧の取得に失敗</strong><br><small>ローカルデータで継続します</small>', 'warning');
        } finally {
            this.hideSyncOverlay();
        }
    }

    updateSyncUI() {
        const btn = document.getElementById('syncToggleBtn');
        const icon = document.getElementById('syncIcon');
        const status = document.getElementById('syncStatus');

        if (this.syncEnabled) {
            btn.classList.add('active');
            icon.textContent = '☁️';
            const syncCode = window.firebaseSync.getSyncCode();
            status.textContent = syncCode ? `同期ON (${syncCode})` : '同期ON';
            btn.title = syncCode 
                ? `クラウド同期ON\n同期コード: ${syncCode}\n\n右クリックまたは長押しでコードを表示`
                : 'クラウド同期ON';
        } else {
            btn.classList.remove('active');
            icon.textContent = '☁️';
            status.textContent = '同期OFF';
            btn.title = 'クラウド同期OFF\nクリックで有効化';
        }

        this.updateSyncSummaryUI();
    }

    setLastSync(result, detail = '') {
        this.lastSyncResult = result;
        this.lastSyncAt = new Date();
        this.lastSyncDetail = detail;
        this.updateSyncSummaryUI();
    }

    updateSyncSummaryUI() {
        const el = document.getElementById('syncSummary');
        if (!el) return;

        const timeText = this.lastSyncAt
            ? this.lastSyncAt.toLocaleString('ja-JP')
            : '未実行';

        const detailText = this.lastSyncDetail ? ` (${this.lastSyncDetail})` : '';
        const syncState = this.syncEnabled ? 'ON' : 'OFF';

        el.textContent = `同期: ${syncState} / 最終結果: ${this.lastSyncResult} / 最終時刻: ${timeText}${detailText}`;
    }

    // ================== CSV操作 ==================
    importCsv() {
        document.getElementById('csvFileInput').click();
    }

    /**
     * CSVのテキストを問題の配列に変換する（1件読み込みとフォルダ読み込みで共用）
     * 形式: 問題文,答え,メモ,ジャンル,難易度,タグ（1行目は見出し）
     */
    csvTextToQuizzes(csvText) {
        const records = this.parseCsv(csvText.replace(/^﻿/, ''));
        const quizzes = [];

        for (let i = 1; i < records.length; i++) {
            const parts = records[i];
            if (parts.length >= 2 && parts[0]) {
                quizzes.push({
                    id: this.generateQuizId(),
                    question: parts[0] || '',
                    answer: parts[1] || '',
                    memo: parts[2] || '',
                    genre: parts[3] || 'ノンジャンル',
                    difficulty: this.parseDifficulty(parts[4]) || 5,
                    tags: parts[5] ? parts[5].split(',').map(t => t.trim()).filter(t => t) : [],
                    created_at: new Date().toISOString()
                });
            }
        }
        return quizzes;
    }

    handleCsvImport(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const quizzes = this.csvTextToQuizzes(e.target.result);

                if (quizzes.length === 0) {
                    alert('有効な問題が見つかりませんでした');
                    return;
                }

                const collectionName = prompt('問題集の名前を入力してください:', file.name.replace('.csv', ''));
                if (!collectionName) return;

                const selectedFolder = this.getFolderById(this.selectedFolderId);
                const folderName = selectedFolder ? selectedFolder.name : this.defaultFolderName;

                // 上限チェックは「空の問題集に quizzes.length 問を足す」形で行う。
                // 先に quizzes を入れてから判定すると問題数を二重に数えてしまい、
                // 上限ちょうどのCSV（500問）が取り込めなくなる。
                const collection = {
                    id: Date.now().toString(),
                    name: collectionName,
                    quizzes: [],
                    created_at: new Date().toISOString(),
                    folder: folderName,
                    isCloudPlaceholder: false,
                    isDownloaded: true,
                    quizCount: 0
                };

                if (!this.canAddCollectionToFolder(folderName)) return;
                if (!this.canAddQuizzesToCollection(collection, quizzes.length)) return;
                if (!this.canAddQuizzesToFolder(folderName, quizzes.length)) return;

                collection.quizzes = quizzes;
                collection.quizCount = quizzes.length;

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

    /**
     * フォルダ選択を開く。
     * Chrome/Edge のフォルダ選択API（showDirectoryPicker）を優先し、
     * 使えない場合は input[webkitdirectory] に切り替える。
     */
    async importCsvFolder() {
        console.log('📂 フォルダ読込を開始します');

        if (typeof window.showDirectoryPicker === 'function') {
            try {
                const dir = await window.showDirectoryPicker({ mode: 'read' });
                const files = [];
                for await (const entry of dir.values()) {
                    if (entry.kind === 'file'
                        && entry.name.toLowerCase().endsWith('.csv')
                        && !entry.name.startsWith('_')) {
                        files.push(await entry.getFile());
                    }
                }
                await this.importCsvFiles(dir.name, files);
                return;
            } catch (error) {
                if (error && (error.name === 'AbortError' || error.name === 'NotAllowedError')) {
                    console.log('📂 フォルダ選択がキャンセルされました');
                    return;
                }
                console.warn('⚠️ フォルダ選択APIが使えませんでした。別方式で開きます:', error);
            }
        }

        const input = document.getElementById('csvFolderInput');
        if (!input) {
            alert('フォルダ読込を開けませんでした（画面を再読み込みしてください）');
            return;
        }
        input.click();
    }

    handleCsvFolderImport(event) {
        const files = Array.from(event.target.files || []);
        event.target.value = '';

        // webkitRelativePath は「フォルダ名/ファイル名」の形になる
        const relative = (files[0] && files[0].webkitRelativePath) || '';
        const folderName = relative.split('/')[0] || 'インポート';

        return this.importCsvFiles(folderName, files.filter(
            f => f.name.toLowerCase().endsWith('.csv') && !f.name.startsWith('_')
        ));
    }

    /**
     * CSVの集まりを1つのフォルダとして取り込む。
     * 選んだフォルダと同じ名前のフォルダを作り、CSV1つを問題集1つとして入れる。
     * （変換スクリプトが元の問題集1つにつき1フォルダを作るので、それをそのまま取り込める）
     */
    async importCsvFiles(folderName, files) {
        // 取り込み前後の確認ダイアログは出さない。
        // 間違えたときはフォルダごと削除すればよいので、そのまま進める。
        if (!files || files.length === 0) {
            this.showNotification('<strong>⚠️ CSVが見つかりませんでした</strong>', 'warning');
            return;
        }

        let folder = this.folders.find(f => f.name === folderName);
        if (!folder) {
            folder = {
                id: `folder_${Date.now()}`,
                name: folderName,
                maxCollections: 50,
                maxQuizzes: 5000
            };
            this.folders.push(folder);
        }

        files.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

        const added = [];
        const skipped = [];
        this.showSyncOverlay('📂 フォルダを読み込み中...', `${files.length} 件のCSVを処理しています`);

        try {
            for (const file of files) {
                const name = file.name.replace(/\.csv$/i, '');
                let quizzes;
                try {
                    quizzes = this.csvTextToQuizzes(await file.text());
                } catch (err) {
                    skipped.push(`${name}（読み込み失敗）`);
                    continue;
                }

                if (quizzes.length === 0) {
                    skipped.push(`${name}（問題なし）`);
                    continue;
                }
                if (quizzes.length > this.limits.maxQuizzesPerCollection) {
                    skipped.push(`${name}（${quizzes.length}問 / 上限${this.limits.maxQuizzesPerCollection}問超過）`);
                    continue;
                }

                const usage = this.getFolderUsage(folder.name);
                if (usage.collectionCount >= folder.maxCollections) {
                    skipped.push(`${name}（フォルダの問題集数が上限）`);
                    continue;
                }
                if (usage.quizCount + quizzes.length > folder.maxQuizzes) {
                    skipped.push(`${name}（フォルダの問題数が上限）`);
                    continue;
                }

                this.collections.push({
                    id: `${Date.now()}_${added.length}`,
                    name: name,
                    quizzes: quizzes,
                    created_at: new Date().toISOString(),
                    folder: folder.name,
                    isCloudPlaceholder: false,
                    isDownloaded: true,
                    quizCount: quizzes.length
                });
                added.push(`${name}（${quizzes.length}問）`);
            }
        } finally {
            this.hideSyncOverlay();
        }

        this.selectedFolderId = folder.id;
        const visible = this.getVisibleCollections();
        this.currentCollection = visible.length > 0 ? visible[0] : null;
        this.updateUI();
        this.saveToLocalStorage();

        const quizTotal = this.getFolderUsage(folder.name).quizCount;
        console.log(`📂 フォルダ「${folderName}」から ${added.length}問題集・${quizTotal}問を取り込みました`);
        added.forEach(line => console.log(`    ${line}`));
        if (skipped.length) {
            console.warn(`⚠️ 取り込めなかったCSV (${skipped.length}件):`);
            skipped.forEach(line => console.warn(`    ${line}`));
        }

        // ダイアログではなく画面右上の通知で知らせる（続けて取り込むときに邪魔にならない）
        const detail = skipped.length
            ? `<small>${added.length}問題集 / ${quizTotal}問<br>${skipped.length}件は取り込めませんでした（詳細はコンソール）</small>`
            : `<small>${added.length}問題集 / ${quizTotal}問</small>`;
        this.showNotification(
            `<strong>📂 ${escapeHtml(folderName)}</strong><br>${detail}`,
            skipped.length ? 'warning' : 'success'
        );
    }

    exportCsv() {
        if (!this.currentCollection) {
            alert('エクスポートする問題集を選択してください');
            return;
        }
        if (!this.isCollectionDownloaded(this.currentCollection)) {
            alert('この問題集は未ダウンロードのためエクスポートできません。');
            return;
        }

        let csv = '問題文,答え,メモ,ジャンル,難易度,タグ\n';

        this.currentCollection.quizzes.forEach(quiz => {
            const difficulty = String(quiz.difficulty);
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

    parseDifficulty(text) {
        if (!text) return 5;
        text = text.trim();
        // 旧テキスト値との後方互換
        if (text === '易') return 2;
        if (text === '中') return 5;
        if (text === '難') return 7;
        const n = parseInt(text, 10);
        if (!isNaN(n) && n >= 1 && n <= 10) return n;
        return 5;
    }

    escapeCsv(text) {
        if (!text) return '';
        return text.replace(/"/g, '""');
    }

    // ================== 設定 ==================
    // 表示への反映のみを行う。保存は呼び出し側で行うこと。
    // （スライダーの input イベントごとに保存すると、全問題集のシリアライズが
    //   ドラッグ中に何十回も走って固まるため）
    applySettings() {
        document.documentElement.style.setProperty('--base-font-size', `${this.settings.fontSize}px`);
        document.getElementById('fontSizeValue').textContent = this.settings.fontSize;
        document.getElementById('quizFontSizeValue').textContent = this.settings.quizFontSize;

        // スライダーのつまみも設定値に合わせる（保存した値と表示がずれるため）
        const fontSizeSlider = document.getElementById('fontSizeSlider');
        if (fontSizeSlider) fontSizeSlider.value = this.settings.fontSize;
        const quizFontSizeSlider = document.getElementById('quizFontSizeSlider');
        if (quizFontSizeSlider) quizFontSizeSlider.value = this.settings.quizFontSize;

        const questionDisplay = document.querySelector('.question-text');
        if (questionDisplay) {
            questionDisplay.style.fontSize = `${this.settings.quizFontSize}px`;
        }
    }

    // ================== 問題集フォルダ移動タブ ==================
    updateCollectionFolderMoveUI() {
        const sourceSel = document.getElementById('collectionMoveSourceFolder');
        const destSel = document.getElementById('collectionMoveDestFolder');
        if (!sourceSel || !destSel) return;

        const prevSource = this._collectionMoveState.sourceFolderId || '';
        const prevDest = this._collectionMoveState.destFolderId || '';

        // フォルダ名を文字列連結でHTMLに埋め込むと属性を脱出されうるため要素を組み立てる
        const fillOptions = (select) => {
            select.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'フォルダを選択...';
            select.appendChild(placeholder);

            this.folders.forEach(folder => {
                const option = document.createElement('option');
                option.value = folder.id;
                option.textContent = folder.name;
                select.appendChild(option);
            });
        };
        fillOptions(sourceSel);
        fillOptions(destSel);

        if (prevSource) sourceSel.value = prevSource;
        if (prevDest) destSel.value = prevDest;

        this.renderCollectionFolderMoveList('source');
        this.renderCollectionFolderMoveList('dest');
    }

    onCollectionMoveFolderChange(side, folderId) {
        if (side === 'source') {
            this._collectionMoveState.sourceFolderId = folderId || null;
            this._collectionMoveState.sourceSelected.clear();
        } else {
            this._collectionMoveState.destFolderId = folderId || null;
            this._collectionMoveState.destSelected.clear();
        }
        this.renderCollectionFolderMoveList(side);
    }

    renderCollectionFolderMoveList(side) {
        const isSource = side === 'source';
        const folderId = isSource ? this._collectionMoveState.sourceFolderId : this._collectionMoveState.destFolderId;
        const selectedSet = isSource ? this._collectionMoveState.sourceSelected : this._collectionMoveState.destSelected;
        const listEl = document.getElementById(isSource ? 'collectionMoveSourceList' : 'collectionMoveDestList');
        const countEl = document.getElementById(isSource ? 'collectionMoveSourceCount' : 'collectionMoveDestCount');
        if (!listEl) return;

        if (!folderId) {
            listEl.innerHTML = '<p style="padding:16px;color:#999;">フォルダを選択してください</p>';
            if (countEl) countEl.textContent = '';
            return;
        }

        const folder = this.getFolderById(folderId);
        if (!folder) {
            listEl.innerHTML = '<p style="padding:16px;color:#999;">フォルダが見つかりません</p>';
            if (countEl) countEl.textContent = '';
            return;
        }

        const collections = this.collections.filter(col => (col.folder || this.defaultFolderName) === folder.name);
        if (countEl) countEl.textContent = `${collections.length}集`;
        listEl.innerHTML = '';

        if (collections.length === 0) {
            listEl.innerHTML = '<p style="padding:16px;color:#999;">問題集がありません</p>';
            return;
        }

        collections.forEach(col => {
            const item = document.createElement('div');
            item.className = 'quiz-item';
            item.dataset.collectionId = col.id;
            if (selectedSet.has(col.id)) item.classList.add('selected');

            const title = document.createElement('div');
            title.className = 'quiz-item-question';
            title.textContent = col.name;

            const meta = document.createElement('div');
            meta.className = 'quiz-item-answer';
            meta.textContent = `${this.getCollectionQuizCount(col)}問`;

            item.appendChild(title);
            item.appendChild(meta);

            item.addEventListener('click', () => {
                if (selectedSet.has(col.id)) {
                    selectedSet.delete(col.id);
                } else {
                    selectedSet.add(col.id);
                }
                this.renderCollectionFolderMoveList(side);
            });

            listEl.appendChild(item);
        });
    }

    moveCollectionsBetweenFolders(fromSide, toSide) {
        const fromIsSource = fromSide === 'source';
        const fromFolderId = fromIsSource ? this._collectionMoveState.sourceFolderId : this._collectionMoveState.destFolderId;
        const toFolderId = toSide === 'source' ? this._collectionMoveState.sourceFolderId : this._collectionMoveState.destFolderId;
        const selectedSet = fromIsSource ? this._collectionMoveState.sourceSelected : this._collectionMoveState.destSelected;

        if (!fromFolderId || !toFolderId) {
            alert('移動元・移動先フォルダを選択してください');
            return;
        }
        if (fromFolderId === toFolderId) {
            alert('同じフォルダ間では移動できません');
            return;
        }

        const toFolder = this.getFolderById(toFolderId);
        if (!toFolder) return;

        const targetCollections = this.collections.filter(col => selectedSet.has(col.id));
        if (targetCollections.length === 0) {
            alert('移動する問題集を選択してください');
            return;
        }

        for (const col of targetCollections) {
            if (!this.canAddCollectionToFolder(toFolder.name)) return;
            if (!this.canAddQuizzesToFolder(toFolder.name, this.getCollectionQuizCount(col))) return;
        }

        targetCollections.forEach(col => {
            col.folder = toFolder.name;
        });

        selectedSet.clear();
        this.updateUI();
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
            this.collections.filter(col => this.isCollectionDownloaded(col)).forEach(col => {
                const opt = document.createElement('option');
                opt.value = col.id;
                opt.textContent = `${col.name} (${this.getCollectionQuizCount(col)}問)`;
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

            // innerHTML に問題文を埋め込むとHTMLとして解釈されるため textContent で組み立てる
            const questionDiv = document.createElement('div');
            questionDiv.className = 'quiz-question';
            const questionText = this.stripFormatting(quiz.question);
            questionDiv.textContent = questionText.substring(0, 60) + (questionText.length > 60 ? '…' : '');

            const answerDiv = document.createElement('div');
            answerDiv.className = 'quiz-answer';
            answerDiv.style.cssText = 'font-size:12px;color:#666;';
            answerDiv.textContent = `→ ${this.stripFormatting(quiz.answer)}`;

            item.appendChild(questionDiv);
            item.appendChild(answerDiv);

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

    // 問題の一意なIDを生成する
    generateQuizId() {
        return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    }

    moveQuizzes(fromSide, toSide) {
        this.transferQuizzes(fromSide, toSide, 'move');
    }

    copyQuizzes(fromSide, toSide) {
        this.transferQuizzes(fromSide, toSide, 'copy');
    }

    /**
     * 問題移動タブでの移動／コピーを行う。
     * @param {'move'|'copy'} mode
     */
    transferQuizzes(fromSide, toSide, mode) {
        const isMove = mode === 'move';
        const label = isMove ? '移動' : 'コピー';

        const fromId = fromSide === 'source' ? this._moveState.sourceId : this._moveState.destId;
        const toId = toSide === 'source' ? this._moveState.sourceId : this._moveState.destId;
        const fromSelected = fromSide === 'source' ? this._moveState.sourceSelected : this._moveState.destSelected;

        if (!fromId || !toId) { alert(`${label}元と${label}先の問題集を選択してください`); return; }
        if (fromId === toId) { alert(`${label}元と${label}先が同じ問題集です`); return; }
        if (fromSelected.size === 0) { alert(`${label}する問題を選択してください`); return; }

        const fromCol = this.collections.find(c => c.id === fromId);
        const toCol = this.collections.find(c => c.id === toId);
        if (!fromCol || !toCol) { alert('問題集が見つかりません'); return; }

        const targets = fromCol.quizzes.filter(q => fromSelected.has(q.id));
        if (targets.length === 0) { alert(`${label}する問題を選択してください`); return; }

        if (!this.canAddQuizzesToCollection(toCol, targets.length)) return;
        if (!this.canAddQuizzesToFolder(toCol.folder || this.defaultFolderName, targets.length)) return;

        targets.forEach(quiz => {
            toCol.quizzes.push({ ...quiz, id: this.generateQuizId() });
        });

        if (isMove) {
            fromCol.quizzes = fromCol.quizzes.filter(q => !fromSelected.has(q.id));
            fromCol.quizCount = fromCol.quizzes.length;
        }
        toCol.quizCount = toCol.quizzes.length;
        fromSelected.clear();

        this.saveToLocalStorage();
        this.updateMoveCollectionSelects();
        console.log(`✅ ${targets.length}問を「${fromCol.name}」→「${toCol.name}」へ${label}`);
    }

    applyViewMode() {
        // バナー表示
        document.getElementById('viewModeBanner').style.display = 'flex';

        // 非表示にするボタン（編集・保存系）
        const hideIds = [
            'saveBtn', 'importCsvBtn', 'importCsvFolderBtn',
            'newFolderBtn', 'downloadFolderBtn',
            'newCollectionBtn',
            'newQuizBtn', 'deleteQuizBtn', 'editCurrentQuizBtn', 'toggleFactCheckedBtn',
            'clearDataBtn'
        ];
        hideIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        // 編集タブ・候補リストタブ・移動タブを非表示
        document.querySelectorAll('.tab-btn').forEach(btn => {
            if (
                btn.dataset.tab === 'edit' ||
                btn.dataset.tab === 'candidates' ||
                btn.dataset.tab === 'move' ||
                btn.dataset.tab === 'collection-folder-move' ||
                btn.dataset.tab === 'quiz-organize'
            ) {
                btn.style.display = 'none';
            }
        });

        // 読み込みボタンのラベルを変更（メモリのみ読み込みと明示）
        const loadBtn = document.getElementById('loadBtn');
        if (loadBtn) loadBtn.textContent = '一時読み込み';

        console.log('👁 閲覧モードで起動しました（localStorageへの読み書き無効）');
    }

    async clearAllData() {
        if (!confirm('全てのデータを削除しますか？この操作は元に戻せません。')) return;
        if (!confirm('本当によろしいですか？')) return;

        const collectionCount = this.collections.length;
        const totalQuizzes = this.collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);

        // クラウド同期中の場合、クラウド側をどうするかを明示的に確認する。
        // （確認せずにローカルだけ空にすると、その後の自動アップロードでクラウドまで
        //   消えてしまう事故につながるため）
        let clearCloud = false;
        if (this.syncEnabled && window.firebaseSync) {
            clearCloud = confirm(
                '☁️ クラウド上のデータも削除しますか？\n\n' +
                '【OK】= クラウドのデータも削除する\n' +
                '【キャンセル】= この端末のデータだけ削除し、クラウドには残す'
            );
        }

        if (clearCloud) {
            this.showSyncOverlay('🗑️ クラウドのデータを削除中...', '');
            try {
                await window.firebaseSync.deleteAllCollections();
                await window.firebaseSync.saveFolders([]);
                this.cloudViewComplete = true;
            } catch (error) {
                this.hideSyncOverlay();
                alert('クラウドのデータ削除に失敗しました: ' + error.message);
                return;
            }
            this.hideSyncOverlay();
        } else if (this.syncEnabled) {
            // ローカルとクラウドの内容が食い違う状態になるため、
            // 以降の自動同期でクラウド側を削除しないようにする
            this.cloudViewComplete = false;
        }

        this.collections = [];
        this.folders = [
            {
                id: 'folder_default',
                name: this.defaultFolderName,
                maxCollections: 50,
                maxQuizzes: 5000
            }
        ];
        this.selectedFolderId = 'folder_default';
        this.currentCollection = null;
        this.currentQuiz = null;
        localStorage.removeItem('quizManagerData');
        
        console.log(`🗑️ 全データを削除しました (${collectionCount}問題集, ${totalQuizzes}問)`);
        
        this.updateUI();
        alert('全てのデータを削除しました');
    }

    // ================== Claude.ai Web版での事実確認 ==================
    factCheckCurrentQuiz() {
        if (!this.quizMode.active) return;
        const quiz = this.quizMode.quizzes[this.quizMode.currentIndex];
        if (!quiz) return;
        this.openClaudeWebForFactCheck(quiz.question, quiz.answer);
    }

    openClaudeWebForFactCheck(questionText, answerText) {
        // 引数が無いときは編集フォームの内容を使う
        const question = (questionText !== undefined
            ? questionText
            : document.getElementById('questionInput').value).trim();
        const answer = (answerText !== undefined
            ? answerText
            : document.getElementById('answerInput').value).trim();

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
            this.showNotification(
                '<strong>📋 質問をコピーしました！</strong><br><small>Claude.aiが開くので、Ctrl+V で貼り付けてください</small>',
                'success'
            );

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
