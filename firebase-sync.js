// Firebase Firestore 同期マネージャー
class FirebaseSync {
    constructor() {
        this.db = null;
        this.userId = null;
        this.syncCode = null;
        this.unsubscribe = null;
        this.syncEnabled = false;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) {
            console.log('ℹ️ Firebase Sync は既に初期化済みです');
            return;
        }
        
        // Firebase が利用可能か確認
        if (!window.firebaseDB) {
            console.warn('⚠️ Firebase is not available. Sync disabled.');
            return false;
        }

        this.db = window.firebaseDB;
        this.initialized = true;
        
        // 既存の同期コードを復元
        const savedCode = localStorage.getItem('quizbook_sync_code');
        if (savedCode) {
            this.syncCode = savedCode;
            this.userId = this.syncCodeToUserId(savedCode);
            console.log(`✅ Firebase Sync initialized with existing sync code: ${savedCode}`);
        } else {
            console.log('✅ Firebase Sync initialized (no sync code yet)');
        }
        
        return true;
    }

    // 同期コードを生成（6桁の英数字）
    generateSyncCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    // 同期コードからユーザーIDを生成
    syncCodeToUserId(syncCode) {
        return 'sync_' + syncCode.toUpperCase();
    }

    // 同期コードを設定
    setSyncCode(code) {
        const upperCode = code.toUpperCase().trim();
        
        // 6桁の英数字チェック
        if (!/^[A-Z0-9]{6}$/.test(upperCode)) {
            console.error('❌ 無効な同期コード:', code);
            return { success: false, error: '同期コードは6桁の英数字である必要があります' };
        }

        this.syncCode = upperCode;
        this.userId = this.syncCodeToUserId(upperCode);
        localStorage.setItem('quizbook_sync_code', upperCode);
        
        console.log(`🔑 同期コードを設定: ${upperCode} (ユーザーID: ${this.userId})`);
        return { success: true };
    }

    // 同期コードを取得
    getSyncCode() {
        return this.syncCode || localStorage.getItem('quizbook_sync_code');
    }

    // 同期コードをクリア
    clearSyncCode() {
        this.syncCode = null;
        this.userId = null;
        localStorage.removeItem('quizbook_sync_code');
    }

    async enableSync() {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            console.error('❌ Firebase接続に失敗しました');
            alert('Firebase接続に失敗しました。ローカルモードで動作します。');
            return false;
        }

        this.syncEnabled = true;
        console.log('✅ クラウド同期を有効にしました');
        return true;
    }

    disableSync() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
            console.log('🔌 リアルタイム同期を切断しました');
        }
        this.syncEnabled = false;
        console.log('⏸️ クラウド同期を無効にしました');
    }

    getSummaryDocRef() {
        const { doc } = window.firebaseUtils;
        return doc(this.db, 'users', this.userId, 'meta', 'summary');
    }

    getFoldersDocRef() {
        const { doc } = window.firebaseUtils;
        return doc(this.db, 'users', this.userId, 'meta', 'folders');
    }

    getCollectionDocRef(collectionId) {
        const { doc } = window.firebaseUtils;
        return doc(this.db, 'users', this.userId, 'collections', collectionId);
    }

    getLegacyUserDocRef() {
        const { doc } = window.firebaseUtils;
        return doc(this.db, 'users', this.userId);
    }

    isPermissionDenied(error) {
        const code = error && error.code ? String(error.code) : '';
        return code.includes('permission-denied') || code.includes('insufficient permissions');
    }

    sanitizeCollectionForCloud(collection) {
        const sanitized = { ...collection };
        delete sanitized.isCloudPlaceholder;
        delete sanitized.isDownloaded;
        delete sanitized.quizCount;
        delete sanitized.syncStatus;
        delete sanitized.syncUpdatedAt;
        sanitized.quizzes = Array.isArray(collection.quizzes) ? collection.quizzes : [];
        return sanitized;
    }

    computeCollectionVersionId(collection) {
        const payload = {
            id: collection?.id || '',
            name: collection?.name || '',
            folder: collection?.folder || '未分類',
            quizzes: Array.isArray(collection?.quizzes) ? collection.quizzes : []
        };
        const json = JSON.stringify(payload);
        let hash = 0;
        for (let i = 0; i < json.length; i++) {
            hash = ((hash << 5) - hash) + json.charCodeAt(i);
            hash |= 0;
        }
        return `v1_${Math.abs(hash).toString(36)}_${json.length.toString(36)}`;
    }

    buildCollectionMeta(collection) {
        const quizCount = Array.isArray(collection.quizzes)
            ? collection.quizzes.length
            : (collection.quizCount || 0);

        const isPlaceholder = Boolean(collection.isCloudPlaceholder && !collection.isDownloaded);
        const lastUpdateId = isPlaceholder
            ? (collection.lastUpdateId || collection.downloadedUpdateId || null)
            : this.computeCollectionVersionId(collection);

        return {
            id: collection.id,
            name: collection.name || '無題の問題集',
            quizCount: quizCount,
            folder: collection.folder || '未分類',
            lastUpdateId,
            updatedAt: new Date().toISOString(),
            created_at: collection.created_at || null
        };
    }

    async readSummary() {
        const { getDoc } = window.firebaseUtils;
        const summarySnap = await getDoc(this.getSummaryDocRef());
        if (!summarySnap.exists()) return null;
        return summarySnap.data();
    }

    async readLegacyData() {
        const { getDoc } = window.firebaseUtils;
        const legacySnap = await getDoc(this.getLegacyUserDocRef());
        if (!legacySnap.exists()) return null;
        return legacySnap.data() || null;
    }

    async writeLegacyData(data) {
        const { setDoc } = window.firebaseUtils;
        await setDoc(this.getLegacyUserDocRef(), {
            ...data,
            updated_at: new Date().toISOString()
        });
    }

    async readFolders() {
        const { getDoc } = window.firebaseUtils;
        try {
            const foldersSnap = await getDoc(this.getFoldersDocRef());
            if (!foldersSnap.exists()) return null;
            return foldersSnap.data();
        } catch (error) {
            if (!this.isPermissionDenied(error)) throw error;
            const legacy = await this.readLegacyData();
            if (legacy && Array.isArray(legacy.folders)) {
                return {
                    schemaVersion: 1,
                    updatedAt: legacy.updated_at || null,
                    folders: legacy.folders
                };
            }
            return null;
        }
    }

    async writeFolders(folders) {
        const { setDoc } = window.firebaseUtils;
        try {
            await setDoc(this.getFoldersDocRef(), {
                schemaVersion: 1,
                updatedAt: new Date().toISOString(),
                folders: folders || []
            });
        } catch (error) {
            if (!this.isPermissionDenied(error)) throw error;
            const legacy = (await this.readLegacyData()) || {};
            await this.writeLegacyData({
                ...legacy,
                folders: folders || []
            });
        }
    }

    async writeSummary(metas) {
        const { setDoc } = window.firebaseUtils;
        const totalQuizzes = metas.reduce((sum, meta) => sum + (meta.quizCount || 0), 0);
        try {
            await setDoc(this.getSummaryDocRef(), {
                schemaVersion: 2,
                updatedAt: new Date().toISOString(),
                totalCollections: metas.length,
                totalQuizzes: totalQuizzes,
                collections: metas
            });
        } catch (error) {
            if (!this.isPermissionDenied(error)) throw error;
            // Legacy mode keeps summary inside users/{userId}
            const legacy = (await this.readLegacyData()) || {};
            await this.writeLegacyData({
                ...legacy,
                summary: {
                    schemaVersion: 2,
                    updatedAt: new Date().toISOString(),
                    totalCollections: metas.length,
                    totalQuizzes: totalQuizzes,
                    collections: metas
                }
            });
        }
    }

    async loadFolders() {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ フォルダ構成の読み込みはスキップされました（同期が無効またはDBが未接続）');
            return null;
        }

        try {
            const foldersData = await this.readFolders();
            if (foldersData && Array.isArray(foldersData.folders)) {
                console.log(`✅ フォルダ構成をクラウドから読み込みました (${foldersData.folders.length}個)`);
                return foldersData.folders;
            }
            console.log('ℹ️ クラウドにフォルダ構成が見つかりません（初回使用）');
            return null;
        } catch (error) {
            console.error('❌ フォルダ構成の読み込みエラー:', error);
            return null;
        }
    }

    async saveFolders(folders) {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ フォルダ構成の保存はスキップされました（同期が無効またはDBが未接続）');
            return;
        }

        try {
            console.log(`📤 フォルダ構成をクラウドに保存中... (${folders.length}個)`);
            await this.writeFolders(folders);
            console.log('✅ フォルダ構成をクラウドに保存しました');
        } catch (error) {
            console.error('❌ フォルダ構成の保存エラー:', error);
            throw error;
        }
    }

    setCollectionSyncStatus(collection, status) {
        if (!collection) return;
        collection.syncStatus = status; // 'synced' | 'syncing' | 'error' | 'pending'
        collection.syncUpdatedAt = new Date().toISOString();
    }

    async migrateLegacyIfNeeded() {
        const { doc, getDoc } = window.firebaseUtils;
        const legacyRef = doc(this.db, 'users', this.userId);
        const legacySnap = await getDoc(legacyRef);
        if (!legacySnap.exists()) return null;

        const legacyData = legacySnap.data();
        if (!legacyData.collections || !Array.isArray(legacyData.collections)) return null;

        console.log(`🔄 旧同期形式を検出。問題集単位形式へ移行します (${legacyData.collections.length}問題集)`);
        await this.saveCollections(legacyData.collections);
        return legacyData.collections.map(c => this.buildCollectionMeta(c));
    }

    // readSummary に内部タイムアウトを掛けるラッパー
    async readSummaryWithTimeout(timeoutMs = 8000) {
        let timerId;
        const timeoutPromise = new Promise((_, reject) => {
            timerId = setTimeout(
                () => reject(new Error('firestore_summary_timeout')),
                timeoutMs
            );
        });
        try {
            return await Promise.race([this.readSummary(), timeoutPromise]);
        } finally {
            clearTimeout(timerId);
        }
    }

    async loadCollectionMetas() {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ Firestoreメタデータ読み込みはスキップされました（同期が無効またはDBが未接続）');
            return [];
        }

        // --- サマリー doc を 8 秒タイムアウト付きで試みる ---
        let summary = null;
        let summaryError = null;
        try {
            summary = await this.readSummaryWithTimeout(8000);
        } catch (err) {
            summaryError = err;
            const reason = err.message === 'firestore_summary_timeout' ? 'タイムアウト'
                : this.isPermissionDenied(err) ? 'パーミッション拒否'
                : err.message || 'ネットワークエラー';
            console.warn(`⚠️ サマリー取得失敗 (${reason})、レガシーフォールバックへ`);
        }

        // サマリー成功時
        if (summary && Array.isArray(summary.collections)) {
            console.log(`✅ Firestoreメタデータ読み込み成功 (${summary.collections.length}問題集)`);
            return summary.collections;
        }

        // サマリーが空（初回など）かつエラーなし → レガシー移行を試みる
        if (!summaryError) {
            try {
                const migratedMetas = await this.migrateLegacyIfNeeded();
                if (migratedMetas) {
                    console.log(`✅ 旧形式から移行完了 (${migratedMetas.length}問題集)`);
                    return migratedMetas;
                }
            } catch (migrateErr) {
                console.warn('⚠️ 旧形式移行に失敗:', migrateErr.message);
            }
            console.log('ℹ️ Firestoreにメタデータが見つかりませんでした（初回使用）');
            return [];
        }

        // タイムアウト / permission denied / その他エラー → レガシー直読み
        try {
            const legacy = await this.readLegacyData();
            if (legacy && Array.isArray(legacy.collections)) {
                const metas = legacy.collections
                    .filter(c => c && c.id)
                    .map(c => this.buildCollectionMeta(c));
                console.log(`✅ 旧形式データからメタデータ読み込み (${metas.length}問題集)`);
                return metas;
            }
        } catch (legacyError) {
            console.error('❌ 旧形式メタデータ読み込みエラー:', legacyError);
        }
        console.error('❌ Firestoreメタデータ読み込みエラー（全fallback失敗）:', summaryError);
        return [];
    }

    async loadCollectionById(collectionId) {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ Firestore問題集読み込みはスキップされました（同期が無効またはDBが未接続）');
            return null;
        }

        try {
            const { getDoc } = window.firebaseUtils;
            const docSnap = await getDoc(this.getCollectionDocRef(collectionId));
            if (!docSnap.exists()) {
                console.warn(`⚠️ 問題集がクラウドに存在しません: ${collectionId}`);
                return null;
            }

            const data = docSnap.data() || {};
            const quizzes = Array.isArray(data.quizzes) ? data.quizzes : [];
            const collection = {
                ...data,
                id: data.id || collectionId,
                quizzes,
                isCloudPlaceholder: false,
                isDownloaded: true,
                quizCount: quizzes.length,
                downloadedUpdateId: data.lastUpdateId || null
            };

            console.log(`✅ 問題集を読み込みました: ${collection.name || collectionId} (${quizzes.length}問)`);
            return collection;
        } catch (error) {
            if (this.isPermissionDenied(error)) {
                try {
                    const legacy = await this.readLegacyData();
                    const legacyCollection = legacy && Array.isArray(legacy.collections)
                        ? legacy.collections.find(c => c && c.id === collectionId)
                        : null;
                    if (legacyCollection) {
                        const quizzes = Array.isArray(legacyCollection.quizzes) ? legacyCollection.quizzes : [];
                        return {
                            ...legacyCollection,
                            id: legacyCollection.id || collectionId,
                            quizzes,
                            isCloudPlaceholder: false,
                            isDownloaded: true,
                            quizCount: quizzes.length,
                            downloadedUpdateId: legacyCollection.lastUpdateId || null
                        };
                    }
                } catch (legacyError) {
                    console.error(`❌ 旧形式問題集の読み込みエラー (${collectionId}):`, legacyError);
                }
            }
            console.error(`❌ 問題集の読み込みエラー (${collectionId}):`, error);
            return null;
        }
    }

    async saveCollections(collections) {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ Firestore同期はスキップされました（同期が無効またはDBが未接続）');
            return {
                uploadedCount: 0,
                skippedCount: 0,
                deletedCount: 0
            };
        }

        try {
            const { setDoc, deleteDoc } = window.firebaseUtils;
            const previousMetas = await this.loadCollectionMetas();
            const previousIdSet = new Set(previousMetas.map(meta => meta.id));
            const previousMetaById = new Map(previousMetas.map(meta => [meta.id, meta]));

            const totalQuizzes = collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
            console.log(`📤 Firestoreに保存中... (${collections.length}問題集, ${totalQuizzes}問)`);

            const nextMetas = [];
            const nextIdSet = new Set();
            let uploadedCount = 0;
            let skippedCount = 0;
            let deletedCount = 0;

            for (const collection of collections) {
                if (!collection || !collection.id) continue;

                const meta = this.buildCollectionMeta(collection);
                // 同期状態を保存（UI から参照される）
                if (collection.syncStatus) {
                    meta.syncStatus = collection.syncStatus;
                }
                if (collection.syncUpdatedAt) {
                    meta.syncUpdatedAt = collection.syncUpdatedAt;
                }
                nextMetas.push(meta);
                nextIdSet.add(collection.id);

                if (collection.isCloudPlaceholder && !collection.isDownloaded) {
                    continue;
                }

                const previousMeta = previousMetaById.get(collection.id);
                if (previousMeta && previousMeta.lastUpdateId && previousMeta.lastUpdateId === meta.lastUpdateId) {
                    collection.lastUpdateId = meta.lastUpdateId;
                    collection.downloadedUpdateId = meta.lastUpdateId;
                    this.setCollectionSyncStatus(collection, 'synced');
                    skippedCount += 1;
                    continue;
                }

                const sanitized = this.sanitizeCollectionForCloud(collection);
                const lastUpdateId = this.computeCollectionVersionId(collection);
                collection.lastUpdateId = lastUpdateId;
                collection.downloadedUpdateId = lastUpdateId;
                await setDoc(this.getCollectionDocRef(collection.id), {
                    ...sanitized,
                    lastUpdateId,
                    updatedAt: new Date().toISOString()
                });
                // クラウド保存成功後に状態を 'synced' に
                this.setCollectionSyncStatus(collection, 'synced');
                uploadedCount += 1;
            }

            for (const previousId of previousIdSet) {
                if (!nextIdSet.has(previousId)) {
                    await deleteDoc(this.getCollectionDocRef(previousId));
                    console.log(`🗑️ クラウドから問題集を削除: ${previousId}`);
                    deletedCount += 1;
                }
            }

            await this.writeSummary(nextMetas);
            console.log(`✅ Firestoreへの同期が完了しました (更新:${uploadedCount}, スキップ:${skippedCount}, 削除:${deletedCount})`);
            return {
                uploadedCount,
                skippedCount,
                deletedCount
            };
        } catch (error) {
            if (this.isPermissionDenied(error)) {
                const legacyCollections = collections
                    .filter(c => c && c.id)
                    .map(c => this.sanitizeCollectionForCloud(c));
                const legacy = (await this.readLegacyData()) || {};
                await this.writeLegacyData({
                    ...legacy,
                    collections: legacyCollections
                });
                collections.forEach(c => this.setCollectionSyncStatus(c, 'synced'));
                console.log('✅ 旧形式（users/{userId}）へフォールバック保存しました');
                return {
                    uploadedCount: collections.length,
                    skippedCount: 0,
                    deletedCount: 0,
                    fallback: true
                };
            }
            console.error('❌ Firestore同期エラー:', error);
            throw error;
        }
    }

    async loadCollections() {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ Firestoreからの読み込みはスキップされました（同期が無効またはDBが未接続）');
            return null;
        }

        try {
            console.log(`📥 Firestoreからデータを読み込み中... (ユーザーID: ${this.userId})`);

            const metas = await this.loadCollectionMetas();
            if (!metas.length) {
                return [];
            }

            const loadedCollections = [];
            for (const meta of metas) {
                const collection = await this.loadCollectionById(meta.id);
                if (collection) loadedCollections.push(collection);
            }

            const totalQuizzes = loadedCollections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
            console.log(`✅ Firestoreから読み込み成功 (${loadedCollections.length}問題集, ${totalQuizzes}問)`);
            return loadedCollections;
        } catch (error) {
            console.error('❌ Firestoreからの読み込みエラー:', error);
            throw error;
        }
    }

    async loadCollectionsByFolder(folderName) {
        const metas = await this.loadCollectionMetas();
        const targetMetas = metas.filter(meta => (meta.folder || '未分類') === folderName);
        const results = [];
        for (const meta of targetMetas) {
            const collection = await this.loadCollectionById(meta.id);
            if (collection) results.push(collection);
        }
        return results;
    }

    async deleteCollectionById(collectionId) {
        if (!this.syncEnabled || !this.db) return;

        try {
            const { deleteDoc } = window.firebaseUtils;
            await deleteDoc(this.getCollectionDocRef(collectionId));

            const metas = await this.loadCollectionMetas();
            const nextMetas = metas.filter(meta => meta.id !== collectionId);
            await this.writeSummary(nextMetas);

            console.log(`✅ 問題集をクラウドから削除しました: ${collectionId}`);
        } catch (error) {
            console.error(`❌ 問題集削除エラー (${collectionId}):`, error);
            throw error;
        }
    }

    startRealtimeSync(callback) {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ リアルタイム同期はスキップされました（同期が無効またはDBが未接続）');
            return;
        }

        try {
            const { onSnapshot, doc } = window.firebaseUtils;
            const docRef = doc(this.db, 'users', this.userId, 'meta', 'summary');
            
            this.unsubscribe = onSnapshot(docRef, (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    const collections = data.collections || [];
                    const totalQuizzes = collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
                    console.log(`🔄 メタデータ更新を受信しました (${collections.length}問題集, ${totalQuizzes}問)`);
                    callback(collections);
                }
            }, (error) => {
                console.error('❌ リアルタイム同期エラー:', error);
            });
            
            console.log('✅ リアルタイム同期を開始しました');
        } catch (error) {
            console.error('❌ リアルタイム同期の開始に失敗:', error);
        }
    }
}

// グローバルインスタンスを作成
window.firebaseSync = new FirebaseSync();
