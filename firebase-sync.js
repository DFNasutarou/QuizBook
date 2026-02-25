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
        if (this.initialized) return;
        
        // Firebase が利用可能か確認
        if (!window.firebaseDB) {
            console.warn('Firebase is not available. Sync disabled.');
            return false;
        }

        this.db = window.firebaseDB;
        this.initialized = true;
        
        // 既存の同期コードを復元
        const savedCode = localStorage.getItem('quizbook_sync_code');
        if (savedCode) {
            this.syncCode = savedCode;
            this.userId = this.syncCodeToUserId(savedCode);
            console.log('Firebase Sync initialized with existing sync code');
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
            return { success: false, error: '同期コードは6桁の英数字である必要があります' };
        }

        this.syncCode = upperCode;
        this.userId = this.syncCodeToUserId(upperCode);
        localStorage.setItem('quizbook_sync_code', upperCode);
        
        console.log('Sync code set:', upperCode);
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
            alert('Firebase接続に失敗しました。ローカルモードで動作します。');
            return false;
        }

        this.syncEnabled = true;
        console.log('Sync enabled');
        return true;
    }

    disableSync() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        this.syncEnabled = false;
        console.log('Sync disabled');
    }

    async saveCollections(collections) {
        if (!this.syncEnabled || !this.db) return;

        try {
            const { setDoc, doc } = window.firebaseUtils;
            const docRef = doc(this.db, 'users', this.userId);
            
            await setDoc(docRef, {
                collections: collections,
                updatedAt: new Date().toISOString()
            });
            
            console.log('Collections synced to Firestore');
        } catch (error) {
            console.error('Error syncing to Firestore:', error);
            alert('クラウド同期中にエラーが発生しました: ' + error.message);
        }
    }

    async loadCollections() {
        if (!this.syncEnabled || !this.db) return null;

        try {
            const { doc, getDoc } = window.firebaseUtils;
            const docRef = doc(this.db, 'users', this.userId);
            const docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                const data = docSnap.data();
                console.log('Collections loaded from Firestore');
                return data.collections || [];
            }
            
            return null;
        } catch (error) {
            console.error('Error loading from Firestore:', error);
            return null;
        }
    }

    startRealtimeSync(callback) {
        if (!this.syncEnabled || !this.db) return;

        try {
            const { onSnapshot, doc } = window.firebaseUtils;
            const docRef = doc(this.db, 'users', this.userId);
            
            this.unsubscribe = onSnapshot(docRef, (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    console.log('Real-time update received from Firestore');
                    callback(data.collections || []);
                }
            }, (error) => {
                console.error('Real-time sync error:', error);
            });
            
            console.log('Real-time sync started');
        } catch (error) {
            console.error('Error starting real-time sync:', error);
        }
    }
}

// グローバルインスタンスを作成
window.firebaseSync = new FirebaseSync();
