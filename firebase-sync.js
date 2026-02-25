// Firebase Firestore 同期マネージャー
class FirebaseSync {
    constructor() {
        this.db = null;
        this.userId = null;
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
        this.userId = this.getUserId();
        this.initialized = true;
        
        console.log('Firebase Sync initialized with userId:', this.userId);
        return true;
    }

    getUserId() {
        // ローカルストレージからユーザーIDを取得、なければ生成
        let userId = localStorage.getItem('quizbook_user_id');
        if (!userId) {
            userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('quizbook_user_id', userId);
        }
        return userId;
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
