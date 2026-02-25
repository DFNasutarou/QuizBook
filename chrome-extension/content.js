// Claude.aiページで動作するコンテンツスクリプト

console.log('[クイズ事実確認] 拡張機能が読み込まれました');

// ページ読み込み完了を待つ
let checkCount = 0;
const maxChecks = 50; // 最大5秒待機

// URLパラメータから質問文を取得する関数
function getPromptFromURL() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const prompt = urlParams.get('autoPrompt');

        if (prompt) {
            // URLSearchParamsが自動的にデコードしてくれる
            console.log('[クイズ事実確認] URLパラメータからプロンプトを取得');
            console.log('[クイズ事実確認] プロンプト内容:', prompt.substring(0, 100) + '...');
            return prompt;
        }
    } catch (e) {
        console.error('[クイズ事実確認] URLパラメータ読み込みエラー:', e);
    }
    return null;
}

function findTextArea() {
    // Claude.aiの入力フィールドを探す（複数のセレクタを試行）
    const selectors = [
        'div[contenteditable="true"]',  // contenteditable div
        'textarea',                      // textarea要素
        'input[type="text"]',           // text input
        '[role="textbox"]'              // role=textbox
    ];

    for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
            // 見えている要素のみを対象
            if (element.offsetParent !== null) {
                console.log('[クイズ事実確認] 入力フィールドを発見:', selector);
                return element;
            }
        }
    }
    return null;
}

function findSendButton() {
    // 送信ボタンを探す
    const selectors = [
        'button[aria-label*="Send"]',
        'button[aria-label*="送信"]',
        'button:has(svg)',  // SVGアイコンを持つボタン
        'button[type="submit"]'
    ];

    for (const selector of selectors) {
        try {
            const buttons = document.querySelectorAll(selector);
            for (const button of buttons) {
                if (button.offsetParent !== null && !button.disabled) {
                    console.log('[クイズ事実確認] 送信ボタンを発見:', selector);
                    return button;
                }
            }
        } catch (e) {
            // :has() がサポートされていない場合はスキップ
            continue;
        }
    }
    return null;
}

function autoFillAndSend() {
    console.log('[クイズ事実確認] 自動入力を試行...', checkCount);

    const textArea = findTextArea();

    if (!textArea) {
        checkCount++;
        if (checkCount < maxChecks) {
            setTimeout(autoFillAndSend, 100);
        } else {
            console.error('[クイズ事実確認] 入力フィールドが見つかりませんでした');
            showNotification('入力フィールドが見つかりませんでした。手動で貼り付けてください。', 'error');
        }
        return;
    }

    // URLパラメータから質問文を取得
    const prompt = getPromptFromURL();

    if (!prompt) {
        console.log('[クイズ事実確認] プロンプトが設定されていません');
        return;
    }

    console.log('[クイズ事実確認] プロンプトを取得:', prompt.substring(0, 50) + '...');

        // 入力フィールドに値を設定
        if (textArea.tagName === 'TEXTAREA' || textArea.tagName === 'INPUT') {
            // textarea または input の場合
            textArea.value = prompt;
            textArea.dispatchEvent(new Event('input', { bubbles: true }));
            textArea.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            // contenteditable の場合
            textArea.textContent = prompt;
            textArea.innerText = prompt;

            // イベントを発火
            textArea.dispatchEvent(new Event('input', { bubbles: true }));
            textArea.dispatchEvent(new Event('change', { bubbles: true }));
            textArea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            textArea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }

        console.log('[クイズ事実確認] テキストを入力しました');

        // フォーカスを当てる
        textArea.focus();

        // 少し待ってから送信ボタンを探す
        setTimeout(() => {
            const sendButton = findSendButton();

            if (sendButton) {
                console.log('[クイズ事実確認] 送信ボタンをクリックします');
                sendButton.click();
                showNotification('質問を自動送信しました！', 'success');

                // URLパラメータをクリア（履歴に残さない）
                try {
                    const url = new URL(window.location.href);
                    url.searchParams.delete('autoPrompt');
                    window.history.replaceState({}, '', url.toString());
                } catch (e) {
                    console.error('[クイズ事実確認] URLパラメータ削除エラー:', e);
                }
            } else {
                console.warn('[クイズ事実確認] 送信ボタンが見つかりません。Enterキーで送信してください。');
                showNotification('テキストを入力しました。Enterキーで送信してください。', 'info');

                // Enterキーを試す（フォールバック）
                const enterEvent = new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                });
                textArea.dispatchEvent(enterEvent);
            }
        }, 500);
}

function showNotification(message, type = 'info') {
    const colors = {
        success: '#4CAF50',
        error: '#f44336',
        info: '#2196F3'
    };

    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${colors[type]};
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 999999;
        max-width: 400px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        animation: slideIn 0.3s;
    `;
    notification.textContent = `🎯 ${message}`;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s';
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

// ページ読み込み後に実行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(autoFillAndSend, 1000);
    });
} else {
    setTimeout(autoFillAndSend, 1000);
}

// URLが変更されたら再実行（SPAの場合）
let lastURL = window.location.href;
new MutationObserver(() => {
    const url = window.location.href;
    if (url !== lastURL) {
        lastURL = url;
        if (url.includes('autoPrompt=')) {
            console.log('[クイズ事実確認] URL変更を検知');
            checkCount = 0;
            setTimeout(autoFillAndSend, 1000);
        }
    }
}).observe(document, { subtree: true, childList: true });
