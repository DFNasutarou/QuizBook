// バックグラウンドサービスワーカー

console.log('[クイズ事実確認] バックグラウンドスクリプトが起動しました');

// 拡張機能がインストールされた時
chrome.runtime.onInstalled.addListener(() => {
    console.log('[クイズ事実確認] 拡張機能がインストールされました');
});

// メッセージを受信（クイズ管理ツールから）
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    console.log('[クイズ事実確認] 外部メッセージを受信:', request);

    if (request.action === 'factCheck') {
        handleFactCheck(request.prompt);
        sendResponse({ success: true });
    }

    return true;
});

// 内部メッセージも受信
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[クイズ事実確認] メッセージを受信:', request);

    if (request.action === 'factCheck') {
        handleFactCheck(request.prompt);
        sendResponse({ success: true });
    }

    return true;
});

function handleFactCheck(prompt) {
    // プロンプトをstorageに保存
    chrome.storage.local.set({ quizFactCheckPrompt: prompt }, () => {
        console.log('[クイズ事実確認] プロンプトを保存しました');

        // Claude.aiの新しいチャットページを開く
        chrome.tabs.create({
            url: 'https://claude.ai/new',
            active: true
        }, (tab) => {
            console.log('[クイズ事実確認] 新しいタブを開きました:', tab.id);
        });
    });
}
