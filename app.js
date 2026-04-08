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
        this.cloudSaveTimer = null;
        this.cloudSaveDelayMs = 15000;
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
        this.lastSyncResult = '未実行';
        this.lastSyncAt = null;
        this.lastSyncDetail = '';
        this.currentTab = 'manage';
        this.contextMenuType = null;
        this.contextMenuTarget = null;
        this.lastSelectionSource = 'folder';
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
        this.updateMoveCollectionFolderTarget();
    }

    updateMoveCollectionFolderTarget() {
        const select = document.getElementById('moveCollectionFolderTarget');
        if (!select) return;

        const currentFolder = this.currentCollection
            ? (this.currentCollection.folder || this.defaultFolderName)
            : '';

        select.innerHTML = '<option value="">移動先フォルダ...</option>';
        this.folders.forEach(folder => {
            const option = document.createElement('option');
            option.value = folder.name;
            option.textContent = folder.name;
            if (currentFolder && currentFolder === folder.name) {
                option.selected = true;
            }
            select.appendChild(option);
        });
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
        this.lastSelectionSource = 'folder';
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

    moveCurrentCollectionToFolder() {
        if (!this.currentCollection) {
            alert('問題集を選択してください');
            return;
        }

        const targetSelect = document.getElementById('moveCollectionFolderTarget');
        const targetName = targetSelect ? targetSelect.value : '';
        if (!targetName) {
            alert('移動先フォルダを選択してください');
            return;
        }

        const folder = this.folders.find(f => f.name === targetName);
        if (!folder) {
            alert('指定したフォルダは存在しません。');
            return;
        }
        if ((this.currentCollection.folder || this.defaultFolderName) === folder.name) {
            return;
        }
        if (!this.canAddCollectionToFolder(folder.name)) return;
        if (!this.canAddQuizzesToFolder(folder.name, this.getCollectionQuizCount(this.currentCollection))) return;

        this.currentCollection.folder = folder.name;
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
            this.showNotification(`<strong>⚠️ フォルダDLに失敗</strong><br><small>${error.message}</small>`, 'error');
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
            this.uploadToCloud();
            this.cloudSaveTimer = null;
        }, this.cloudSaveDelayMs);
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

    async downloadCollectionIfNeeded(collection) {
        if (!collection || this.isCollectionDownloaded(collection) || !this.syncEnabled || !window.firebaseSync) {
            return true;
        }

        this.showSyncOverlay('📥 問題集をダウンロード中...', `「${collection.name}」を取得しています`);
        const loaded = await window.firebaseSync.loadCollectionById(collection.id);
        this.hideSyncOverlay();

        if (!loaded) {
            alert('問題集のダウンロードに失敗しました。ネットワーク接続を確認してください。');
            return false;
        }

        const idx = this.collections.findIndex(c => c.id === collection.id);
        if (idx !== -1) {
            this.collections[idx] = {
                ...loaded,
                folder: loaded.folder || collection.folder || '未分類',
                isCloudPlaceholder: false,
                isDownloaded: true,
                quizCount: loaded.quizzes.length,
                lastUpdateId: collection.lastUpdateId || loaded.lastUpdateId || null,
                downloadedUpdateId: collection.lastUpdateId || loaded.lastUpdateId || null,
                syncStatus: 'synced'
            };
            this.currentCollection = this.collections[idx];
            this.isLoadingFromFirestore = true;
            this.saveToLocalStorage();
            this.isLoadingFromFirestore = false;
            this.updateUI();
        }

        return true;
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

        // CSV関連
        const importCsvBtn = document.getElementById('importCsvBtn');
        if (importCsvBtn) importCsvBtn.addEventListener('click', () => this.importCsv());

        const quizFolderCheckboxes = document.getElementById('quizFolderCheckboxes');
        if (quizFolderCheckboxes) {
            quizFolderCheckboxes.addEventListener('change', (e) => {
                if (e.target && e.target.matches('input[type="checkbox"]')) {
                    this.onQuizFolderSelectionChanged();
                }
            });
        }

        const quizCollectionCheckboxes = document.getElementById('quizCollectionCheckboxes');
        if (quizCollectionCheckboxes) {
            quizCollectionCheckboxes.addEventListener('change', (e) => {
                if (e.target && e.target.matches('input[type="checkbox"]')) {
                    this.onQuizCollectionSelectionChanged();
                }
            });
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

        // コンテキストメニューのグローバルハンドラー
        document.addEventListener('click', () => this.hideContextMenu());
        
        const contextMenu = document.getElementById('contextMenu');
        if (contextMenu) {
            contextMenu.addEventListener('click', (e) => {
                console.log('🔍 [DEBUG] コンテキストメニューがクリックされました');
                if (e.target.classList.contains('context-menu-item')) {
                    const action = e.target.dataset.action;
                    console.log(`🔍 [DEBUG] メニューアイテムクリック: ${action}`);
                    e.stopPropagation(); // ドキュメントクリックへの伝播を防ぐ
                    this.handleContextMenuAction(action);
                    this.hideContextMenu();
                } else {
                    console.log('🔍 [DEBUG] メニュー外をクリック');
                }
            });
        }
    }

    showContextMenu(e, type) {
        e.preventDefault();
        console.log(`🔍 [DEBUG] 右クリックメニュー表示: type=${type}`);
        console.log(`🔍 [DEBUG] e.target:`, e.target);
        console.log(`🔍 [DEBUG] e.currentTarget:`, e.currentTarget);
        this.contextMenuType = type;
        
        // selectタグを確実に取得（e.targetがoptionの場合もあるため）
        const selectElement = e.currentTarget.tagName === 'SELECT' ? e.currentTarget : e.target.closest('select');
        console.log(`🔍 [DEBUG] selectElement:`, selectElement);
        
        if (!selectElement) {
            console.warn('⚠️ select要素が見つかりません');
            return;
        }
        
        if (type === 'collection') {
            const selectedIdx = selectElement.selectedIndex;
            console.log(`🔍 [DEBUG] 選択インデックス: ${selectedIdx}`);
            if (selectedIdx < 0) return;
            this.contextMenuTarget = this.getVisibleCollections()[selectedIdx];
            console.log(`🔍 [DEBUG] 対象問題集:`, this.contextMenuTarget?.name);
        } else if (type === 'folder') {
            const selectedIdx = selectElement.selectedIndex;
            console.log(`🔍 [DEBUG] 選択インデックス: ${selectedIdx}`);
            if (selectedIdx < 0) return;
            this.contextMenuTarget = this.folders[selectedIdx];
            console.log(`🔍 [DEBUG] 対象フォルダ:`, this.contextMenuTarget?.name, `ID: ${this.contextMenuTarget?.id}`);
        }

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
        console.log(`🔍 [DEBUG] コンテキストメニューアクション: action=${action}, type=${this.contextMenuType}`);
        console.log(`🔍 [DEBUG] 対象:`, this.contextMenuTarget);
        
        if (!this.contextMenuTarget) {
            console.warn('⚠️ contextMenuTarget が null です');
            return;
        }

        if (action === 'rename') {
            console.log('🔍 [DEBUG] 名前変更処理を開始');
            this.startInlineEdit(this.contextMenuType);
        } else if (action === 'delete') {
            console.log('🔍 [DEBUG] 削除処理を開始');
            this.deleteFromContextMenu(this.contextMenuType);
        } else if (action === 'csv-export') {
            console.log('🔍 [DEBUG] CSV出力処理を開始');
            this.exportCollectionAsCSV(this.contextMenuTarget);
        }
    }

    startInlineEdit(type) {
        console.log(`🔍 [DEBUG] startInlineEdit開始: type=${type}`);
        const target = this.contextMenuTarget;
        console.log('🔍 [DEBUG] target:', target);
        const listElement = (type === 'folder') 
            ? document.getElementById('folderList')
            : document.getElementById('collectionList');
        
        console.log('🔍 [DEBUG] listElement:', listElement);
        if (!listElement) {
            console.warn('⚠️ リスト要素が見つかりません');
            return;
        }

        const selectedIdx = listElement.selectedIndex;
        console.log(`🔍 [DEBUG] selectedIdx: ${selectedIdx}`);
        if (selectedIdx < 0) {
            console.warn('⚠️ 選択されているアイテムがありません');
            return;
        }

        const option = listElement.options[selectedIdx];
        const oldName = option.text.split(' 🟢🟡🔴⚪')[0].trim();
        console.log(`🔍 [DEBUG] 現在の名前: "${oldName}"`);
        
        // 現在のオプションを一時的に削除
        option.remove();
        
        // 入力欄を作成
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.value = oldName;
        
        // optionの代わりにinputを作成（select内に直接は入れられないので、代替手段を使用）
        // select内に直接入力欄は入れられないため、ユーザー入力を促すダイアログを使う
        console.log('🔍 [DEBUG] プロンプトダイアログを表示します...');
        const newName = prompt('新しい名前を入力してください:', oldName);
        console.log(`🔍 [DEBUG] 入力された名前: "${newName}"`);
        
        if (newName && newName !== oldName) {
            if (type === 'folder') {
                console.log('🔍 [DEBUG] フォルダ名変更を実行');
                this.renameFolderInline(target, newName);
            } else {
                this.renameCollectionInline(target, newName);
            }
        }
        
        // オプションを再度追加
        if (type === 'folder') {
            const idx = this.folders.indexOf(target);
            if (idx >= 0) {
                this.updateFolderList();
            }
        } else {
            const idx = this.getVisibleCollections().indexOf(target);
            if (idx >= 0) {
                this.updateCollectionList();
            }
        }
    }

    renameFolderInline(folder, newName) {
        if (!newName.trim()) {
            alert('フォルダ名を入力してください');
            return;
        }

        const oldName = folder.name;
        console.log(`🔍 [DEBUG] フォルダ名変更開始: "${oldName}" → "${newName}"`);
        console.log('🔍 [DEBUG] 変更前のフォルダ一覧:', this.folders.map(f => f.name));
        
        folder.name = newName;
        
        // 同じフォルダ配下のすべての問題集のfolderプロパティを更新
        let updatedCount = 0;
        this.collections.forEach(col => {
            if (col.folder === oldName) {
                col.folder = newName;
                updatedCount++;
            }
        });

        console.log(`📁 フォルダ名を変更: "${oldName}" → "${newName}" (${updatedCount}個の問題集を更新)`);
        console.log('🔍 [DEBUG] 変更後のフォルダ一覧:', this.folders.map(f => f.name));
        this.updateUI();
        this.saveToLocalStorage();
    }

    renameCollectionInline(collection, newName) {
        if (!newName.trim()) {
            alert('問題集名を入力してください');
            return;
        }

        const oldName = collection.name;
        collection.name = newName;

        console.log(`📚 問題集名を変更: "${oldName}" → "${newName}"`);
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

            console.log(`🔍 [DEBUG] フォルダ削除開始: "${target.name}" (ID: ${target.id})`);
            console.log('🔍 [DEBUG] 削除前のフォルダ一覧:', this.folders.map(f => `${f.name} (${f.id})`));

            // フォルダ内のすべての問題集をデフォルトフォルダに移動
            let movedCount = 0;
            this.collections.forEach(col => {
                if (col.folder === target.name) {
                    col.folder = this.defaultFolderName;
                    movedCount++;
                }
            });

            const beforeCount = this.folders.length;
            this.folders = this.folders.filter(f => f.id !== target.id);
            const afterCount = this.folders.length;
            this.selectedFolderId = 'folder_default';

            console.log(`🗑️ フォルダを削除: "${target.name}" (${movedCount}個の問題集を移動)`);
            console.log(`🔍 [DEBUG] フォルダ数: ${beforeCount} → ${afterCount}`);
            console.log('🔍 [DEBUG] 削除後のフォルダ一覧:', this.folders.map(f => `${f.name} (${f.id})`));
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

    downloadCurrentCollectionFromCloud() {
        if (!this.currentCollection) {
            alert('ダウンロードする問題集を選択してください');
            return;
        }
        
        if (!this.syncEnabled || !window.firebaseSync) {
            alert('クラウド同期が有効になっていません');
            return;
        }

        if (this.isCollectionDownloaded(this.currentCollection)
            && this.currentCollection.lastUpdateId
            && this.currentCollection.downloadedUpdateId
            && this.currentCollection.lastUpdateId === this.currentCollection.downloadedUpdateId) {
            this.currentCollection.syncStatus = 'synced';
            this.updateCollectionList();
            this.showNotification('<strong>✅ すでに最新です</strong><br><small>ダウンロードは不要でした</small>', 'info');
            return;
        }

        this.currentCollection.syncStatus = 'syncing';
        this.updateCollectionList();
        this.showSyncOverlay('📥 ダウンロード中...', `「${this.currentCollection.name}」を取得しています`);
        
        window.firebaseSync.loadCollectionById(this.currentCollection.id).then(loaded => {
            this.hideSyncOverlay();
            
            if (!loaded) {
                this.currentCollection.syncStatus = 'error';
                this.updateCollectionList();
                alert('ダウンロードに失敗しました');
                return;
            }
            
            const idx = this.collections.findIndex(c => c.id === this.currentCollection.id);
            if (idx !== -1) {
                this.collections[idx] = {
                    ...loaded,
                    folder: loaded.folder || this.currentCollection.folder || '未分類',
                    isCloudPlaceholder: false,
                    isDownloaded: true,
                    quizCount: loaded.quizzes.length,
                    lastUpdateId: this.currentCollection.lastUpdateId || loaded.lastUpdateId || null,
                    downloadedUpdateId: this.currentCollection.lastUpdateId || loaded.lastUpdateId || null,
                    syncStatus: 'synced'
                };
                this.currentCollection = this.collections[idx];
                this.updateUI();
                this.saveToLocalStorage();
                alert('ダウンロードが完了しました');
            }
        }).catch(() => {
            this.hideSyncOverlay();
            if (this.currentCollection) {
                this.currentCollection.syncStatus = 'error';
                this.updateCollectionList();
            }
            alert('ダウンロードに失敗しました');
        });
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

        if (tabName === 'quiz-organize') {
            this.updateQuizManageList();
        }
        if (tabName === 'collection-folder-move') {
            this.updateCollectionFolderMoveUI();
        }
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

    async selectCollection(collectionId) {
        this.lastSelectionSource = 'collection';
        this.currentCollection = this.collections.find(c => c.id === collectionId) || null;
        this.currentQuiz = null;

        this.updateQuizList();
        this.updateMoveCollectionFolderTarget();
        this.updateQuizManageCollectionSelect();
        this.updateQuizManageList();
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
        this.ensureFoldersFromCollections();
        this.updateFolderList();
        this.updateCollectionList();
        this.updateQuizList();
        this.updateQuizManageCollectionSelect();
        this.updateQuizManageList();
        this.updateGenreFilters();
        this.updateQuizFolderCheckboxes();
        this.updateQuizCollectionCheckboxes();
        this.updateMoveCollectionSelects();
        this.updateCollectionFolderMoveUI();
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

    filterQuizzes() {
        if (!this.currentCollection) {
            document.getElementById('quizList').innerHTML = '<p style="padding:20px;">問題集を選択してください</p>';
            return;
        }

        if (!this.isCollectionDownloaded(this.currentCollection)) {
            const container = document.getElementById('quizList');
            container.innerHTML = `
                <p style="padding:20px;">この問題集は未同期です。上部の「📥ダウンロード」で取得してください。</p>
                <div style="padding:0 20px 20px;">
                    <button id="downloadCurrentCollectionBtn" class="btn btn-primary">この問題集をダウンロード</button>
                </div>
            `;
            const btn = document.getElementById('downloadCurrentCollectionBtn');
            if (btn) {
                btn.addEventListener('click', async () => {
                    await this.downloadCollectionIfNeeded(this.currentCollection);
                });
            }
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
            item.draggable = false;

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

            item.appendChild(questionDiv);
            item.appendChild(answerDiv);
            item.appendChild(tagsDiv);

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

        const searchText = document.getElementById('quizManageSearch')?.value.toLowerCase() || '';
        const genreFilter = document.getElementById('quizManageGenreFilter')?.value || '';
        const difficultyFilter = document.getElementById('quizManageDifficultyFilter')?.value || '';

        const quizzes = this.currentCollection.quizzes.filter(quiz => {
            const matchSearch = !searchText ||
                quiz.question.toLowerCase().includes(searchText) ||
                quiz.answer.toLowerCase().includes(searchText);
            const matchGenre = !genreFilter || quiz.genre === genreFilter;
            const matchDifficulty = !difficultyFilter || quiz.difficulty === parseInt(difficultyFilter);
            return matchSearch && matchGenre && matchDifficulty;
        });

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
            item.draggable = true;

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

            item.appendChild(questionDiv);
            item.appendChild(answerDiv);
            item.appendChild(tagsDiv);
            item.appendChild(controlsDiv);

            item.addEventListener('dragstart', (e) => this.handleDragStart(e));
            item.addEventListener('dragover', (e) => this.handleDragOver(e));
            item.addEventListener('drop', (e) => { this.handleDrop(e); this.updateQuizManageList(); });
            item.addEventListener('dragenter', (e) => this.handleDragEnter(e));
            item.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            item.addEventListener('dragend', (e) => this.handleDragEnd(e));

            item.addEventListener('click', () => this.selectQuizOnly(quiz.id));
            item.addEventListener('dblclick', () => this.selectQuiz(quiz.id));

            container.appendChild(item);
        });
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

        this.quizSelectedFolderNames = new Set(
            [...this.quizSelectedFolderNames].filter(name => folderNames.includes(name))
        );
        if (this.quizSelectedFolderNames.size === 0 && folderNames.length > 0) {
            this.quizSelectedFolderNames = new Set(folderNames);
        }

        this.quizSelectedCollectionIds = new Set(
            [...this.quizSelectedCollectionIds].filter(id => collectionIds.has(id))
        );
    }

    updateQuizFolderCheckboxes() {
        const container = document.getElementById('quizFolderCheckboxes');
        if (!container) return;

        this.syncQuizSelectionState();
        container.innerHTML = '';

        if (this.folders.length === 0) {
            container.innerHTML = '<p>フォルダがありません</p>';
            return;
        }

        this.folders.forEach(folder => {
            const usage = this.getFolderUsage(folder.name);
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = folder.name;
            checkbox.checked = this.quizSelectedFolderNames.has(folder.name);

            const textSpan = document.createElement('span');
            textSpan.textContent = `${folder.name} (${usage.collectionCount}集)`;

            label.appendChild(checkbox);
            label.appendChild(textSpan);
            container.appendChild(label);
        });
    }

    updateQuizCollectionCheckboxes() {
        const container = document.getElementById('quizCollectionCheckboxes');
        if (!container) return;

        this.syncQuizSelectionState();
        container.innerHTML = '';

        const selectedFolders = this.quizSelectedFolderNames;
        const targetCollections = this.collections.filter(collection =>
            selectedFolders.has(collection.folder || this.defaultFolderName)
        );

        if (targetCollections.length === 0) {
            container.innerHTML = '<p>問題集がありません</p>';
            return;
        }

        targetCollections.forEach(collection => {
            const downloadable = this.isCollectionDownloaded(collection);
            if (!downloadable) {
                this.quizSelectedCollectionIds.delete(collection.id);
            }

            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = collection.id;
            checkbox.checked = downloadable && this.quizSelectedCollectionIds.has(collection.id);
            checkbox.disabled = !downloadable;

            const textSpan = document.createElement('span');
            const quizCount = this.getCollectionQuizCount(collection);
            const status = downloadable ? '' : ' [未DL]';
            textSpan.textContent = `${collection.name} (${quizCount}問)${status}`;

            label.appendChild(checkbox);
            label.appendChild(textSpan);
            container.appendChild(label);
        });
    }

    onQuizFolderSelectionChanged() {
        const checkboxes = document.querySelectorAll('#quizFolderCheckboxes input[type="checkbox"]:checked');
        this.quizSelectedFolderNames = new Set(Array.from(checkboxes).map(checkbox => checkbox.value));
        this.updateQuizCollectionCheckboxes();
    }

    onQuizCollectionSelectionChanged() {
        const allDisplayed = document.querySelectorAll('#quizCollectionCheckboxes input[type="checkbox"]');
        const checkedDisplayed = document.querySelectorAll('#quizCollectionCheckboxes input[type="checkbox"]:checked');

        allDisplayed.forEach(checkbox => this.quizSelectedCollectionIds.delete(checkbox.value));
        checkedDisplayed.forEach(checkbox => this.quizSelectedCollectionIds.add(checkbox.value));
    }

    // ================== 出題機能 ==================
    startQuizMode() {
        this.syncQuizSelectionState();

        if (this.quizSelectedCollectionIds.size === 0) {
            alert('出題する問題集を選択してください');
            return;
        }

        const selectedFolders = this.quizSelectedFolderNames;
        const selectedCollections = this.collections.filter(collection =>
            selectedFolders.has(collection.folder || this.defaultFolderName) &&
            this.quizSelectedCollectionIds.has(collection.id)
        );

        let quizzes = [];
        selectedCollections.forEach(collection => {
            if (collection && this.isCollectionDownloaded(collection)) {
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
            console.log(`🔍 [DEBUG] フォルダをクラウドに保存: ${this.folders.length}個`, this.folders.map(f => f.name));
            const [syncResult] = await Promise.all([
                window.firebaseSync.saveCollections(this.collections),
                window.firebaseSync.saveFolders(this.folders)
            ]);
            console.log('🔍 [DEBUG] フォルダ保存完了');

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
            this.showNotification(`<strong>⚠️ クラウド保存に失敗</strong><br><small>${err.message}</small>`, 'error');
        }
    }

    async downloadFromCloud() {
        if (!this.syncEnabled || !window.firebaseSync) {
            alert('クラウド同期が有効になっていません');
            return;
        }

        if (this.lastSelectionSource === 'collection' && this.currentCollection) {
            this.downloadCurrentCollectionFromCloud();
            return;
        }

        await this.downloadCurrentFolderFromCloud();
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
                folders: this.folders,
                selectedFolderId: this.selectedFolderId,
                limits: this.limits,
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
            console.log(`✅ ローカルストレージに保存成功 (${dataSizeMB}MB, ${this.collections.length}問題集, ${this.collections.reduce((sum, c) => sum + this.getCollectionQuizCount(c), 0)}問)`);

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
                        col.quizCount = col.quizzes.length;
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
                this.limits = parsed.limits || this.limits;
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
            } finally {
                this.hideSyncOverlay();
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
                    this.collections = this.buildCollectionsFromCloudMetas(metas);
                    
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
                await Promise.all([
                    window.firebaseSync.saveCollections(this.collections),
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
                this.collections = this.buildCollectionsFromCloudMetas(metas);
                
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

                const selectedFolder = this.getFolderById(this.selectedFolderId);
                const folderName = selectedFolder ? selectedFolder.name : this.defaultFolderName;

                const collection = {
                    id: Date.now().toString(),
                    name: collectionName,
                    quizzes: quizzes,
                    created_at: new Date().toISOString(),
                    folder: folderName,
                    isCloudPlaceholder: false,
                    isDownloaded: true,
                    quizCount: quizzes.length
                };

                if (!this.canAddCollectionToFolder(folderName)) return;
                if (!this.canAddQuizzesToCollection(collection, quizzes.length)) return;
                if (!this.canAddQuizzesToFolder(folderName, quizzes.length)) return;

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
        if (!this.isCollectionDownloaded(this.currentCollection)) {
            alert('この問題集は未ダウンロードのためエクスポートできません。');
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

    // ================== 問題集フォルダ移動タブ ==================
    updateCollectionFolderMoveUI() {
        const sourceSel = document.getElementById('collectionMoveSourceFolder');
        const destSel = document.getElementById('collectionMoveDestFolder');
        if (!sourceSel || !destSel) return;

        const prevSource = this._collectionMoveState.sourceFolderId || '';
        const prevDest = this._collectionMoveState.destFolderId || '';

        const options = '<option value="">フォルダを選択...</option>' +
            this.folders.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
        sourceSel.innerHTML = options;
        destSel.innerHTML = options;

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
        if (!this.canAddQuizzesToCollection(toCol, toMove.length)) return;
        if (!this.canAddQuizzesToFolder(toCol.folder || this.defaultFolderName, toMove.length)) return;
        toMove.forEach(q => {
            toCol.quizzes.push({ ...q, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) });
        });
        fromCol.quizzes = fromCol.quizzes.filter(q => !fromSelected.has(q.id));
        toCol.quizCount = toCol.quizzes.length;
        fromCol.quizCount = fromCol.quizzes.length;
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
        if (!this.canAddQuizzesToCollection(toCol, toCopy.length)) return;
        if (!this.canAddQuizzesToFolder(toCol.folder || this.defaultFolderName, toCopy.length)) return;
        toCopy.forEach(q => {
            toCol.quizzes.push({ ...q, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) });
        });
        toCol.quizCount = toCol.quizzes.length;

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
            'newFolderBtn', 'downloadFolderBtn', 'moveCollectionFolderBtn',
            'newCollectionBtn',
            'newQuizBtn', 'deleteQuizBtn',
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

    clearAllData() {
        if (!confirm('全てのデータを削除しますか？この操作は元に戻せません。')) return;
        if (!confirm('本当によろしいですか？')) return;

        const collectionCount = this.collections.length;
        const totalQuizzes = this.collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);

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
