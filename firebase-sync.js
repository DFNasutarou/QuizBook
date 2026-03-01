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

    async saveCollections(collections) {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ Firestore同期はスキップされました（同期が無効またはDBが未接続）');
            return;
        }

        try {
            const { setDoc, doc } = window.firebaseUtils;
            const docRef = doc(this.db, 'users', this.userId);
            
            const totalQuizzes = collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
            console.log(`📤 Firestoreに保存中... (${collections.length}問題集, ${totalQuizzes}問)`);
            
            await setDoc(docRef, {
                collections: collections,
                updatedAt: new Date().toISOString()
            });
            
            console.log('✅ Firestoreへの同期が完了しました');
        } catch (error) {
            console.error('❌ Firestore同期エラー:', error);
            alert('クラウド同期中にエラーが発生しました: ' + error.message);
        }
    }

    async loadCollections() {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ Firestoreからの読み込みはスキップされました（同期が無効またはDBが未接続）');
            return null;
        }

        try {
            const { doc, getDoc } = window.firebaseUtils;
            const docRef = doc(this.db, 'users', this.userId);
            
            console.log(`📥 Firestoreからデータを読み込み中... (ユーザーID: ${this.userId})`);
            
            const docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                const data = docSnap.data();
                const collections = data.collections || [];
                const totalQuizzes = collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
                console.log(`✅ Firestoreから読み込み成功 (${collections.length}問題集, ${totalQuizzes}問${data.updatedAt ? ', 更新: ' + new Date(data.updatedAt).toLocaleString('ja-JP') : ''})`);
                return collections;
            } else {
                console.log('ℹ️ Firestoreにデータが見つかりませんでした（初回使用）');
            }
            
            return null;
        } catch (error) {
            console.error('❌ Firestoreからの読み込みエラー:', error);
            alert('クラウドからのデータ読み込み中にエラーが発生しました: ' + error.message);
            return null;
        }
    }

    startRealtimeSync(callback) {
        if (!this.syncEnabled || !this.db) {
            console.log('ℹ️ リアルタイム同期はスキップされました（同期が無効またはDBが未接続）');
            return;
        }

        try {
            const { onSnapshot, doc } = window.firebaseUtils;
            const docRef = doc(this.db, 'users', this.userId);
            
            this.unsubscribe = onSnapshot(docRef, (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    const collections = data.collections || [];
                    const totalQuizzes = collections.reduce((sum, c) => sum + (c.quizzes?.length || 0), 0);
                    console.log(`🔄 リアルタイム更新を受信しました (${collections.length}問題集, ${totalQuizzes}問)`);
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
