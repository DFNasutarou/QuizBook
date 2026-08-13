// Firebase Firestore 同期マネージャー

// デバッグログの有効化:
//   localStorage.setItem('quizbook_debug', '1') してリロード
// 通常時は詳細ログを出さないことで、同期のたびに大量の console 出力が出るのを防ぐ。
window.QUIZBOOK_DEBUG = (() => {
    try {
        return localStorage.getItem('quizbook_debug') === '1';
    } catch (e) {
        return false;
    }
})();

function syncDebugLog(...args) {
    if (window.QUIZBOOK_DEBUG) console.log(...args);
}

// Firestore の 1 ドキュメントあたりの上限は 1 MiB。
// 余裕を持って 900KB を超えたら事前にエラーにし、原因の分かるメッセージを出す。
const FIRESTORE_DOC_SIZE_LIMIT = 900 * 1024;

// writeBatch の 1 バッチあたりの操作数上限は 500。余裕を見て 400 で分割する。
const FIRESTORE_BATCH_CHUNK = 400;

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
            syncDebugLog('ℹ️ Firebase Sync は既に初期化済みです');
            return;
        }
        
        // Firebase が利用可能か確認
        if (!window.firebaseDB) {
            console.warn('⚠️ Firebase is not available. Sync disabled.');
            return false;
        }

        // 匿名認証の完了を待つ（セキュリティルールが request.auth != null を要求するため）。
        // 認証が無効・失敗していても false が返るだけで、旧ルール環境では引き続き動作する。
        if (window.firebaseAuthReady) {
            try {
                const authed = await window.firebaseAuthReady;
                if (!authed) {
                    console.warn('⚠️ 認証なしでFirestoreに接続します。セキュリティルールによっては拒否されます。');
                }
            } catch (e) {
                console.warn('⚠️ 認証の待機中にエラーが発生しました:', e);
            }
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
        syncDebugLog(`🔍 [DEBUG] サマリー取得を試行: users/${this.userId}/meta/summary`);
        try {
            const summarySnap = await getDoc(this.getSummaryDocRef());
            if (!summarySnap.exists()) {
                syncDebugLog('🔍 [DEBUG] サマリードキュメントが存在しません');
                return null;
            }
            const data = summarySnap.data();
            syncDebugLog(`🔍 [DEBUG] サマリー取得成功:`, {
                schemaVersion: data.schemaVersion,
                totalCollections: data.totalCollections,
                totalQuizzes: data.totalQuizzes,
                collectionsCount: data.collections?.length
            });
            return data;
        } catch (error) {
            syncDebugLog(`🔍 [DEBUG] サマリー取得エラー:`, error.code, error.message);
            throw error;
        }
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
        syncDebugLog(`🔍 [DEBUG] フォルダ保存を試行: ${folders?.length || 0}個`, folders?.map(f => f.name));
        try {
            await setDoc(this.getFoldersDocRef(), {
                schemaVersion: 1,
                updatedAt: new Date().toISOString(),
                folders: folders || []
            });
            syncDebugLog(`🔍 [DEBUG] フォルダ保存成功: ${folders?.length || 0}個`);
        } catch (error) {
            if (!this.isPermissionDenied(error)) throw error;
            syncDebugLog('🔍 [DEBUG] フォルダ保存がpermission-denied、レガシーフォールバックへ');
            const legacy = (await this.readLegacyData()) || {};
            await this.writeLegacyData({
                ...legacy,
                folders: folders || []
            });
            syncDebugLog('🔍 [DEBUG] レガシー形式でフォルダ保存完了');
        }
    }

    async writeSummary(metas) {
        const { setDoc } = window.firebaseUtils;
        const totalQuizzes = metas.reduce((sum, meta) => sum + (meta.quizCount || 0), 0);
        const summaryData = {
            schemaVersion: 2,
            updatedAt: new Date().toISOString(),
            totalCollections: metas.length,
            totalQuizzes: totalQuizzes,
            collections: metas
        };
        
        syncDebugLog(`🔍 [DEBUG] サマリー保存を試行: users/${this.userId}/meta/summary`, {
            totalCollections: metas.length,
            totalQuizzes: totalQuizzes
        });
        
        try {
            await setDoc(this.getSummaryDocRef(), summaryData);
            syncDebugLog(`🔍 [DEBUG] サマリー保存成功`);
        } catch (error) {
            syncDebugLog(`🔍 [DEBUG] サマリー保存エラー:`, error.code, error.message);
            if (!this.isPermissionDenied(error)) throw error;
            // Legacy mode keeps summary inside users/{userId}
            syncDebugLog(`🔍 [DEBUG] レガシーモードにフォールバック`);
            const legacy = (await this.readLegacyData()) || {};
            await this.writeLegacyData({
                ...legacy,
                summary: summaryData
            });
            syncDebugLog(`🔍 [DEBUG] レガシーモードで保存成功`);
        }
    }

    async saveFolders(folders) {
        if (!this.syncEnabled || !this.db) {
            syncDebugLog('ℹ️ フォルダ構成の保存はスキップされました（同期が無効またはDBが未接続）');
            return;
        }

        try {
            console.log(`📤 フォルダ構成をクラウドに保存中... (${folders.length}個)`, folders.map(f => f.name));
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
            syncDebugLog('ℹ️ Firestoreメタデータ読み込みはスキップされました（同期が無効またはDBが未接続）');
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
            syncDebugLog('ℹ️ Firestore問題集読み込みはスキップされました（同期が無効またはDBが未接続）');
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

    // 書き込み操作をまとめてコミットする（writeBatch が使えない場合は逐次実行にフォールバック）
    async commitWrites(writes) {
        if (!writes.length) return;

        const { writeBatch, setDoc, deleteDoc } = window.firebaseUtils;

        if (typeof writeBatch !== 'function') {
            for (const write of writes) {
                if (write.type === 'set') {
                    await setDoc(write.ref, write.data);
                } else {
                    await deleteDoc(write.ref);
                }
            }
            return;
        }

        for (let i = 0; i < writes.length; i += FIRESTORE_BATCH_CHUNK) {
            const batch = writeBatch(this.db);
            for (const write of writes.slice(i, i + FIRESTORE_BATCH_CHUNK)) {
                if (write.type === 'set') {
                    batch.set(write.ref, write.data);
                } else {
                    batch.delete(write.ref);
                }
            }
            await batch.commit();
        }
    }

    // Firestore のドキュメントサイズ上限に引っかかる前に、原因の分かるエラーにする
    assertDocumentSize(collection, payload) {
        const size = new TextEncoder().encode(JSON.stringify(payload)).length;
        if (size > FIRESTORE_DOC_SIZE_LIMIT) {
            const sizeKB = Math.round(size / 1024);
            throw new Error(
                `問題集「${collection.name || collection.id}」が大きすぎてクラウドに保存できません` +
                `（${sizeKB}KB / 上限約900KB）。問題集を分割してください。`
            );
        }
        return size;
    }

    /**
     * 問題集をクラウドへ差分同期する。
     * @param {Array} collections ローカルの問題集一覧
     * @param {Object} options
     * @param {boolean} options.allowDeletions
     *   true のときだけ「クラウドにあってローカルに無い問題集」を削除する。
     *   起動時のメタデータ取得に失敗した等、ローカルがクラウドの完全な写しでない可能性がある場合は
     *   false を渡すこと（false のままだと削除は一切行わない = クラウド側のデータを消さない）。
     */
    async saveCollections(collections, options = {}) {
        const { allowDeletions = false } = options;

        if (!this.syncEnabled || !this.db) {
            syncDebugLog('ℹ️ Firestore同期はスキップされました（同期が無効またはDBが未接続）');
            return {
                uploadedCount: 0,
                skippedCount: 0,
                deletedCount: 0
            };
        }

        try {
            const previousMetas = await this.loadCollectionMetas();
            const previousIdSet = new Set(previousMetas.map(meta => meta.id));
            const previousMetaById = new Map(previousMetas.map(meta => [meta.id, meta]));

            const totalQuizzes = collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
            console.log(`📤 Firestoreに保存中... (${collections.length}問題集, ${totalQuizzes}問)`);

            const nextMetas = [];
            const nextIdSet = new Set();
            const writes = [];
            // コミット成功後にローカル側へ反映する更新内容
            const pendingLocalUpdates = [];
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
                const payload = {
                    ...sanitized,
                    lastUpdateId,
                    updatedAt: new Date().toISOString()
                };

                this.assertDocumentSize(collection, payload);

                writes.push({
                    type: 'set',
                    ref: this.getCollectionDocRef(collection.id),
                    data: payload
                });
                pendingLocalUpdates.push({ collection, lastUpdateId });
                uploadedCount += 1;
            }

            const staleIds = [...previousIdSet].filter(id => !nextIdSet.has(id));

            if (staleIds.length > 0) {
                // 安全弁1: ローカルの一覧がクラウドの完全な写しだと確認できていない場合は削除しない
                // 安全弁2: 「ローカルが空なのにクラウドには存在する」場合も削除しない（全消し事故の防止）
                const isWipe = nextIdSet.size === 0;
                if (!allowDeletions || isWipe) {
                    console.warn(
                        `⚠️ クラウド上の ${staleIds.length} 件の問題集はローカルにありませんが、` +
                        `安全のため削除しませんでした（${isWipe ? 'ローカルが空のため' : 'ローカル一覧が未確定のため'}）。`
                    );
                    // 削除しない以上、サマリーからも消してはいけないので既存メタを残す
                    staleIds.forEach(id => {
                        const meta = previousMetaById.get(id);
                        if (meta) nextMetas.push(meta);
                    });
                } else {
                    staleIds.forEach(id => {
                        writes.push({ type: 'delete', ref: this.getCollectionDocRef(id) });
                        console.log(`🗑️ クラウドから問題集を削除: ${id}`);
                        deletedCount += 1;
                    });
                }
            }

            await this.commitWrites(writes);

            // コミットが成功してからローカル状態を更新する
            pendingLocalUpdates.forEach(({ collection, lastUpdateId }) => {
                collection.lastUpdateId = lastUpdateId;
                collection.downloadedUpdateId = lastUpdateId;
                this.setCollectionSyncStatus(collection, 'synced');
            });

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
            syncDebugLog('ℹ️ Firestoreからの読み込みはスキップされました（同期が無効またはDBが未接続）');
            return null;
        }

        try {
            console.log(`📥 Firestoreからデータを読み込み中... (ユーザーID: ${this.userId})`);

            const metas = await this.loadCollectionMetas();
            if (!metas.length) {
                return [];
            }

            // 逐次だと問題集の数だけ往復が発生するため並列に取得する
            const loadedCollections = (
                await Promise.all(metas.map(meta => this.loadCollectionById(meta.id)))
            ).filter(Boolean);

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
        // 逐次だと問題集の数だけ往復が発生するため並列に取得する
        return (
            await Promise.all(targetMetas.map(meta => this.loadCollectionById(meta.id)))
        ).filter(Boolean);
    }

    /**
     * クラウド上の全問題集を削除する。
     * 通常の差分同期では安全弁により全消しは行わないため、
     * ユーザーが明示的に「クラウドも消す」を選んだときだけ呼び出すこと。
     */
    async deleteAllCollections() {
        if (!this.syncEnabled || !this.db) return 0;

        const metas = await this.loadCollectionMetas();
        const writes = metas
            .filter(meta => meta && meta.id)
            .map(meta => ({ type: 'delete', ref: this.getCollectionDocRef(meta.id) }));

        await this.commitWrites(writes);
        await this.writeSummary([]);

        console.log(`🗑️ クラウドの全問題集を削除しました (${writes.length}件)`);
        return writes.length;
    }


    // ========================================
    // デバッグ用ヘルパー関数
    // ========================================
    
    /**
     * Firestoreの状態を診断する（開発者ツールのコンソールから呼び出し可能）
     * 使い方: await window.firebaseSync.diagnose()
     */
    async diagnose() {
        console.log('🔍 ========== Firestore診断開始 ==========');
        console.log(`ユーザーID: ${this.userId}`);
        console.log(`同期コード: ${this.syncCode}`);
        console.log(`同期有効: ${this.syncEnabled}`);
        console.log('');
        
        if (!this.syncEnabled || !this.db) {
            console.log('❌ 同期が無効またはDBが未接続です');
            return;
        }
        
        const { getDoc, getDocs, collection } = window.firebaseUtils;
        
        // 1. レガシーデータの確認
        console.log('📋 1. レガシーデータ (users/{userId}) の確認...');
        try {
            const legacySnap = await getDoc(this.getLegacyUserDocRef());
            if (legacySnap.exists()) {
                const data = legacySnap.data();
                console.log('✅ レガシードキュメントが存在します');
                console.log('   - collections:', data.collections?.length || 0);
                console.log('   - folders:', data.folders?.length || 0);
                console.log('   - summary:', data.summary ? 'あり' : 'なし');
            } else {
                console.log('ℹ️ レガシードキュメントは存在しません');
            }
        } catch (error) {
            console.error('❌ レガシーデータ取得エラー:', error.code, error.message);
        }
        console.log('');
        
        // 2. サマリーの確認
        console.log('📋 2. サマリー (users/{userId}/meta/summary) の確認...');
        try {
            const summarySnap = await getDoc(this.getSummaryDocRef());
            if (summarySnap.exists()) {
                const data = summarySnap.data();
                console.log('✅ サマリードキュメントが存在します');
                console.log('   - schemaVersion:', data.schemaVersion);
                console.log('   - totalCollections:', data.totalCollections);
                console.log('   - totalQuizzes:', data.totalQuizzes);
                console.log('   - collections:', data.collections?.length || 0);
                console.log('   - updatedAt:', data.updatedAt);
            } else {
                console.log('ℹ️ サマリードキュメントは存在しません');
            }
        } catch (error) {
            console.error('❌ サマリー取得エラー:', error.code, error.message);
        }
        console.log('');
        
        // 3. フォルダ設定の確認
        console.log('📋 3. フォルダ設定 (users/{userId}/meta/folders) の確認...');
        try {
            const foldersSnap = await getDoc(this.getFoldersDocRef());
            if (foldersSnap.exists()) {
                const data = foldersSnap.data();
                console.log('✅ フォルダドキュメントが存在します');
                console.log('   - folders:', data.folders?.length || 0);
                console.log('   - updatedAt:', data.updatedAt);
            } else {
                console.log('ℹ️ フォルダドキュメントは存在しません');
            }
        } catch (error) {
            console.error('❌ フォルダ取得エラー:', error.code, error.message);
        }
        console.log('');
        
        // 4. 問題集コレクションの確認
        console.log('📋 4. 問題集コレクション (users/{userId}/collections) の確認...');
        try {
            const collectionsRef = collection(this.db, 'users', this.userId, 'collections');
            const snapshot = await getDocs(collectionsRef);
            console.log(`✅ 問題集ドキュメント数: ${snapshot.size}`);
            snapshot.forEach((doc, index) => {
                const data = doc.data();
                console.log(`   ${index + 1}. ${doc.id}`);
                console.log(`      - name: ${data.name}`);
                console.log(`      - quizzes: ${data.quizzes?.length || 0}問`);
                console.log(`      - folder: ${data.folder || '未分類'}`);
            });
        } catch (error) {
            console.error('❌ 問題集コレクション取得エラー:', error.code, error.message);
        }
        console.log('');
        
        console.log('🔍 ========== 診断完了 ==========');
        console.log('');
        console.log('💡 ヒント:');
        console.log('   - permission-denied エラーが出る場合は、Firestoreセキュリティルールを確認してください');
        console.log('   - ドキュメントが存在しない場合は、データ保存を実行してください');
    }
}

// グローバルインスタンスを作成
window.firebaseSync = new FirebaseSync();
