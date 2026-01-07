/**
 * 食事記録アプリ - JavaScript
 * Firebase Firestore + Storage を使用してデータを保存
 */

// ===================================
// Firebase Configuration
// ===================================

const firebaseConfig = {
    apiKey: "AIzaSyAqOtMFYlQReNiyx1gGMjrDK05lBtD8Cts",
    authDomain: "todo-cc031.firebaseapp.com",
    projectId: "todo-cc031",
    storageBucket: "todo-cc031.firebasestorage.app",
    messagingSenderId: "154480988348",
    appId: "1:154480988348:web:e067a23f4080c82c0c00b9",
    measurementId: "G-9E0RTS79GX"
};

// Firebase初期化
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

// ===================================
// State Management
// ===================================

let currentUser = null;
let selectedDate = new Date();
let meals = {
    breakfast: { menu: '', memo: '', imageUrl: '' },
    lunch: { menu: '', memo: '', imageUrl: '' },
    dinner: { menu: '', memo: '', imageUrl: '' }
};

// 自動保存関連
let autoSaveEnabled = true;
let autoSaveTimeout = null;
const AUTO_SAVE_DELAY = 3000; // 3秒後に自動保存（データ使用量を抑える）

// カレンダー関連
let calendarDisplayDate = new Date();

// 保存中フラグ
let isSaving = false;
let isLoading = false;

// 前回の保存内容（変更検知用）
let lastSavedData = null;

// クロップモーダル関連
let cropState = {
    file: null,
    imageUrl: null,
    posX: 0,
    posY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    imageWidth: 0,
    imageHeight: 0,
    callback: null // 確定時のコールバック関数
};

// 管理者関連
let isAdmin = false;
let isVerified = false;
let viewingUserId = null; // 閲覧中のユーザーID

// ===================================
// UI Helpers
// ===================================

/**
 * トースト通知を表示
 * @param {string} message - 表示するメッセージ
 * @param {string} type - 'success', 'error', 'info'
 */
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    // アイコンのSVGパス定義
    const icons = {
        success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>',
        error: '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>',
        info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>'
    };

    toast.innerHTML = `
        <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${icons[type] || icons.info}
        </svg>
        <div class="toast-message">${message}</div>
    `;

    container.appendChild(toast);

    // 3秒後に削除
    setTimeout(() => {
        toast.classList.add('removing');
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 3000);
}

/**
 * カスタム確認ダイアログを表示
 * @param {string} message - 表示するメッセージ
 * @param {boolean} isDanger - 危険な操作かどうか（赤いボタンになる）
 * @returns {Promise<boolean>} 確認結果
 */
function showConfirm(message, isDanger = false) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        messageEl.textContent = message;

        if (isDanger) {
            okBtn.classList.add('danger');
        } else {
            okBtn.classList.remove('danger');
        }

        modal.classList.remove('hidden');

        const handleOk = () => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            resolve(true);
        };

        const handleCancel = () => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            resolve(false);
        };

        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
    });
}

// ===================================
// Utility Functions
// ===================================

/**
 * 日付をYYYY-MM-DD形式にフォーマット
 */
function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 曜日ラベルを取得
 */
function getDayLabel(dateStr) {
    const date = new Date(dateStr.replace(/-/g, '/'));
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    return days[date.getDay()];
}

/**
 * Firestoreのドキュメントパスを取得
 */
function getDocPath(dateStr) {
    if (!currentUser) return null;
    return `users/${currentUser.uid}/daily_logs/${dateStr}`;
}

// ===================================
// Authentication
// ===================================


/**
 * 匿名認証でログイン
 */
async function signInAnonymously() {
    try {
        const result = await auth.signInAnonymously();
        currentUser = result.user;
        console.log('匿名ログイン成功:', currentUser.uid);

        // Firestoreにユーザードキュメントを作成（匿名ユーザー）
        await db.doc(`users/${currentUser.uid}`).set({
            isAnonymous: true,
            createdAt: new Date().toISOString(),
            isAdmin: false,
            isVerified: false
        }, { merge: true });

        return currentUser;
    } catch (error) {
        console.error('匿名ログインエラー:', error);
        showToast('ログインに失敗しました。ページをリロードしてください。', 'error');
        return null;
    }
}

/**
 * メール/パスワードでログイン
 */
async function signInWithEmail(email, password) {
    try {
        const result = await auth.signInWithEmailAndPassword(email, password);
        currentUser = result.user;
        console.log('メールログイン成功:', currentUser.email);
        hideAuthError();
        return currentUser;
    } catch (error) {
        console.error('ログインエラー:', error);
        showAuthError(getAuthErrorMessage(error.code));
        return null;
    }
}

/**
 * メール/パスワードで新規登録
 */
async function registerWithEmail(email, password) {
    try {
        const result = await auth.createUserWithEmailAndPassword(email, password);
        currentUser = result.user;
        console.log('新規登録成功:', currentUser.email);
        hideAuthError();

        // Firestoreにユーザードキュメントを作成
        await db.doc(`users/${currentUser.uid}`).set({
            email: currentUser.email,
            createdAt: new Date().toISOString(),
            isAdmin: false,
            isVerified: false
        }, { merge: true });

        // 新規登録後はオンボーディング画面を表示
        showOnboarding();
        return currentUser;
    } catch (error) {
        console.error('登録エラー:', error);
        showAuthError(getAuthErrorMessage(error.code));
        return null;
    }
}

/**
 * 認証エラーメッセージを取得
 */
function getAuthErrorMessage(errorCode) {
    const messages = {
        'auth/email-already-in-use': 'このメールアドレスは既に使用されています。',
        'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
        'auth/user-not-found': 'このメールアドレスは登録されていません。',
        'auth/wrong-password': 'パスワードが間違っています。',
        'auth/weak-password': 'パスワードは6文字以上にしてください。',
        'auth/too-many-requests': 'ログイン試行回数が多すぎます。しばらく待ってからお試しください。',
        'auth/invalid-credential': 'メールアドレスまたはパスワードが間違っています。'
    };
    return messages[errorCode] || 'ログインに失敗しました。もう一度お試しください。';
}

/**
 * 認証エラーを表示
 */
function showAuthError(message) {
    const errorEl = document.getElementById('auth-error');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }
}

/**
 * 認証エラーを非表示
 */
function hideAuthError() {
    const errorEl = document.getElementById('auth-error');
    if (errorEl) {
        errorEl.classList.add('hidden');
    }
}

// ===================================
// オンボーディング関連
// ===================================

// オンボーディング用の一時アバターURL
let onboardingAvatarFile = null;

/**
 * オンボーディング画面を表示
 */
function showOnboarding() {
    const onboardingScreen = document.getElementById('onboarding-screen');
    const loginScreen = document.getElementById('login-screen');

    if (loginScreen) loginScreen.classList.add('hidden');
    if (onboardingScreen) onboardingScreen.classList.remove('hidden');

    // リセット
    onboardingAvatarFile = null;
    const preview = document.getElementById('onboarding-avatar-preview');
    const placeholder = document.getElementById('onboarding-avatar-placeholder');
    const usernameInput = document.getElementById('onboarding-username');

    if (preview) preview.src = '';
    if (placeholder) placeholder.classList.remove('hidden');
    if (usernameInput) usernameInput.value = '';
}

/**
 * オンボーディングを完了（保存して進む）
 */
async function completeOnboarding() {
    if (!currentUser) return;

    const usernameInput = document.getElementById('onboarding-username');
    const username = usernameInput ? usernameInput.value.trim() : '';

    try {
        // ユーザー名を保存
        if (username) {
            await saveUsername(username);
        }

        // アバターをアップロード
        if (onboardingAvatarFile) {
            await uploadProfileImage(onboardingAvatarFile);
        }

        // オンボーディング画面を閉じてメイン画面へ
        hideOnboarding();
        showToast('プロフィールを設定しました', 'success');
    } catch (error) {
        console.error('オンボーディング保存エラー:', error);
        showToast('保存に失敗しました', 'error');
    }
}

/**
 * オンボーディングをスキップ
 */
function skipOnboarding() {
    hideOnboarding();
}

/**
 * オンボーディング画面を非表示にしてメイン画面を表示
 */
function hideOnboarding() {
    const onboardingScreen = document.getElementById('onboarding-screen');
    if (onboardingScreen) onboardingScreen.classList.add('hidden');

    // メイン画面を表示するためupdateUserUIを呼ぶ
    updateUserUI(currentUser);

    // データを読み込み
    if (currentUser) {
        setupEventListeners();
        loadData(formatDate(selectedDate));
        loadUsername().then(username => {
            if (username) updateUsernameDisplay(username);
        });
        loadProfileImage().then(url => {
            if (url) updateProfileImageDisplay(url);
        });
    }
}

/**
 * オンボーディング画面でアバター画像をプレビュー
 */
function previewOnboardingAvatar(file) {
    if (!file) return;

    onboardingAvatarFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('onboarding-avatar-preview');
        const placeholder = document.getElementById('onboarding-avatar-placeholder');

        if (preview) preview.src = e.target.result;
        if (placeholder) placeholder.classList.add('hidden');
    };
    reader.readAsDataURL(file);
}

/**
 * ログアウト
 */
async function signOut() {
    try {
        await auth.signOut();
        currentUser = null;
        listenersInitialized = false; // リスナー初期化フラグをリセット
        console.log('ログアウトしました');
    } catch (error) {
        console.error('ログアウトエラー:', error);
    }
}

/**
 * アカウント削除（Firebase Auth + すべてのデータ）
 */
async function deleteAccount() {
    if (!currentUser) return;

    try {
        // 設定モーダルを閉じる
        document.getElementById('settings-modal').classList.add('hidden');

        // ユーザーのすべてのデータを削除
        const userDocPath = `users/${currentUser.uid}`;

        // daily_logsコレクションの全ドキュメントを削除
        const logsSnapshot = await db.collection(`${userDocPath}/daily_logs`).get();
        const deletePromises = logsSnapshot.docs.map(doc => doc.ref.delete());
        await Promise.all(deletePromises);

        // ユーザードキュメント自体を削除（存在する場合）
        try {
            await db.doc(userDocPath).delete();
        } catch (e) {
            // ユーザードキュメントが存在しない場合は無視
        }

        // Firebase Authのアカウントを削除
        await currentUser.delete();

        showToast('アカウントを削除しました', 'success');
        currentUser = null;
    } catch (error) {
        console.error('アカウント削除エラー:', error);
        if (error.code === 'auth/requires-recent-login') {
            showToast('セキュリティのため、再度ログインしてからお試しください。', 'error');
        } else {
            showToast('アカウントの削除に失敗しました。', 'error');
        }
    }
}

/**
 * ユーザー名を保存
 */
async function saveUsername(username) {
    if (!currentUser) return false;

    try {
        const userDocPath = `users/${currentUser.uid}`;
        await db.doc(userDocPath).set({ username }, { merge: true });
        showToast('ユーザー名を保存しました', 'success');
        // ヘッダーの表示を更新
        updateUsernameDisplay(username);
        return true;
    } catch (error) {
        console.error('ユーザー名保存エラー:', error);
        showToast('ユーザー名の保存に失敗しました', 'error');
        return false;
    }
}

/**
 * ユーザー名を読み込み
 */
async function loadUsername() {
    if (!currentUser) return null;

    try {
        const userDocPath = `users/${currentUser.uid}`;
        const doc = await db.doc(userDocPath).get();
        if (doc.exists && doc.data().username) {
            return doc.data().username;
        }
        return null;
    } catch (error) {
        console.error('ユーザー名読み込みエラー:', error);
        return null;
    }
}

/**
 * ユーザー名表示を更新
 */
function updateUsernameDisplay(username) {
    const userEmail = document.getElementById('user-email');
    if (userEmail && username) {
        userEmail.textContent = username;
    }
}

/**
 * プロフィール画像をアップロード
 */
async function uploadProfileImage(file) {
    if (!currentUser || !file) return null;

    try {
        showToast('プロフィール画像をアップロード中...', 'info', 0);

        // 画像をリサイズ（オプション、今回はそのままアップロード）
        const timestamp = new Date().getTime();
        const storagePath = `users/${currentUser.uid}/profile/${timestamp}_${file.name}`;
        const storageRef = storage.ref(storagePath);

        await storageRef.put(file);
        const downloadURL = await storageRef.getDownloadURL();

        // Firestoreに保存
        const userDocPath = `users/${currentUser.uid}`;
        await db.doc(userDocPath).set({
            profileImageUrl: downloadURL,
            profileImagePath: storagePath
        }, { merge: true });

        // UI更新
        updateProfileImageDisplay(downloadURL);

        showToast('プロフィール画像を更新しました', 'success');
        return downloadURL;
    } catch (error) {
        console.error('プロフィール画像アップロードエラー:', error);
        showToast('プロフィール画像のアップロードに失敗しました', 'error');
        return null;
    }
}

/**
 * プロフィール画像を削除
 */
async function removeProfileImage() {
    if (!currentUser) return;

    try {
        // Firestoreからパスを取得して削除
        const userDocPath = `users/${currentUser.uid}`;
        const doc = await db.doc(userDocPath).get();

        if (doc.exists && doc.data().profileImagePath) {
            // Storageから削除
            try {
                await storage.ref(doc.data().profileImagePath).delete();
            } catch (e) {
                console.warn('Storage削除エラー（既に削除済み?）:', e);
            }
        }

        // Firestoreからも削除
        await db.doc(userDocPath).set({
            profileImageUrl: '',
            profileImagePath: ''
        }, { merge: true });

        // UI更新
        updateProfileImageDisplay('');

        showToast('プロフィール画像を削除しました', 'success');
    } catch (error) {
        console.error('プロフィール画像削除エラー:', error);
        showToast('プロフィール画像の削除に失敗しました', 'error');
    }
}

/**
 * プロフィール画像を読み込み
 */
async function loadProfileImage() {
    if (!currentUser) return null;

    try {
        const userDocPath = `users/${currentUser.uid}`;
        const doc = await db.doc(userDocPath).get();
        if (doc.exists && doc.data().profileImageUrl) {
            return doc.data().profileImageUrl;
        }
        return null;
    } catch (error) {
        console.error('プロフィール画像読み込みエラー:', error);
        return null;
    }
}

/**
 * プロフィール画像表示を更新（ヘッダーと設定画面両方）
 */
function updateProfileImageDisplay(imageUrl) {
    const headerAvatar = document.getElementById('user-avatar');
    const headerPlaceholder = document.getElementById('header-avatar-placeholder');
    const settingsPreview = document.getElementById('settings-avatar-preview');
    const placeholder = document.getElementById('avatar-placeholder');
    const removeBtn = document.getElementById('remove-avatar-btn');

    if (imageUrl) {
        if (headerAvatar) headerAvatar.src = imageUrl;
        if (headerPlaceholder) headerPlaceholder.classList.add('hidden');
        if (settingsPreview) settingsPreview.src = imageUrl;
        if (placeholder) placeholder.classList.add('hidden');
        if (removeBtn) removeBtn.classList.remove('hidden');
    } else {
        if (headerAvatar) headerAvatar.src = '';
        if (headerPlaceholder) headerPlaceholder.classList.remove('hidden');
        if (settingsPreview) settingsPreview.src = '';
        if (placeholder) placeholder.classList.remove('hidden');
        if (removeBtn) removeBtn.classList.add('hidden');
    }
}

// ===================================
// 画像クロップ（位置調整）関連
// ===================================

/**
 * クロップモーダルを表示
 * @param {File} file - 画像ファイル
 * @param {Function} onConfirm - 確定時のコールバック (croppedFile) => {}
 */
function showCropModal(file, onConfirm) {
    const modal = document.getElementById('crop-modal');
    const cropImage = document.getElementById('crop-image');

    if (!modal || !cropImage || !file) return;

    // 状態をリセット
    cropState = {
        file: file,
        imageUrl: null,
        posX: 0,
        posY: 0,
        isDragging: false,
        startX: 0,
        startY: 0,
        imageWidth: 0,
        imageHeight: 0,
        callback: onConfirm
    };

    // 画像を読み込み
    const reader = new FileReader();
    reader.onload = (e) => {
        cropState.imageUrl = e.target.result;
        cropImage.src = e.target.result;

        // 画像サイズを取得してセンタリング
        cropImage.onload = () => {
            cropState.imageWidth = cropImage.naturalWidth;
            cropState.imageHeight = cropImage.naturalHeight;

            // マスクサイズ（200px）に対してセンタリング
            const maskSize = 200;
            const scale = Math.max(maskSize / cropState.imageWidth, maskSize / cropState.imageHeight);
            cropImage.style.width = (cropState.imageWidth * scale) + 'px';
            cropImage.style.height = (cropState.imageHeight * scale) + 'px';

            // 初期位置（中央）
            const displayWidth = cropState.imageWidth * scale;
            const displayHeight = cropState.imageHeight * scale;
            cropState.posX = (maskSize - displayWidth) / 2;
            cropState.posY = (maskSize - displayHeight) / 2;
            updateCropImagePosition();
        };
    };
    reader.readAsDataURL(file);

    modal.classList.remove('hidden');
}

/**
 * クロップモーダルを閉じる
 */
function hideCropModal() {
    const modal = document.getElementById('crop-modal');
    if (modal) modal.classList.add('hidden');

    cropState.file = null;
    cropState.imageUrl = null;
    cropState.callback = null;
}

/**
 * クロップ画像の位置を更新
 */
function updateCropImagePosition() {
    const cropImage = document.getElementById('crop-image');
    if (cropImage) {
        cropImage.style.left = cropState.posX + 'px';
        cropImage.style.top = cropState.posY + 'px';
    }
}

/**
 * クロップを確定してCanvasで切り取り
 */
async function confirmCrop() {
    if (!cropState.file || !cropState.imageUrl) {
        hideCropModal();
        return;
    }

    try {
        // Canvasで円形にクロップ
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const outputSize = 200; // 出力サイズ

        canvas.width = outputSize;
        canvas.height = outputSize;

        // 画像を読み込み
        const img = new Image();
        img.src = cropState.imageUrl;

        await new Promise((resolve) => {
            img.onload = resolve;
        });

        // マスクサイズに対するスケール
        const maskSize = 200;
        const scale = Math.max(maskSize / cropState.imageWidth, maskSize / cropState.imageHeight);

        // 描画位置を計算
        const drawX = cropState.posX;
        const drawY = cropState.posY;
        const drawWidth = cropState.imageWidth * scale;
        const drawHeight = cropState.imageHeight * scale;

        // 円形にクリップ
        ctx.beginPath();
        ctx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        // 画像を描画
        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

        // Canvasを Blob に変換
        const blob = await new Promise((resolve) => {
            canvas.toBlob(resolve, 'image/jpeg', 0.9);
        });

        // 新しいファイルを作成
        const croppedFile = new File([blob], 'profile.jpg', { type: 'image/jpeg' });

        // コールバックを実行
        if (cropState.callback) {
            await cropState.callback(croppedFile);
        }

        hideCropModal();
    } catch (error) {
        console.error('クロップエラー:', error);
        showToast('画像の処理に失敗しました', 'error');
        hideCropModal();
    }
}

/**
 * クロップモーダルのドラッグイベントを初期化
 */
function initCropDragEvents() {
    const cropMask = document.querySelector('.crop-mask');
    if (!cropMask) return;

    const getEventPosition = (e) => {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    };

    const onDragStart = (e) => {
        e.preventDefault();
        const pos = getEventPosition(e);
        cropState.isDragging = true;
        cropState.startX = pos.x - cropState.posX;
        cropState.startY = pos.y - cropState.posY;
    };

    const onDragMove = (e) => {
        if (!cropState.isDragging) return;
        e.preventDefault();

        const pos = getEventPosition(e);
        const maskSize = 200;
        const cropImage = document.getElementById('crop-image');
        if (!cropImage) return;

        const imageWidth = parseFloat(cropImage.style.width);
        const imageHeight = parseFloat(cropImage.style.height);

        // 新しい位置を計算
        let newX = pos.x - cropState.startX;
        let newY = pos.y - cropState.startY;

        // 境界チェック（画像がマスクからはみ出さないように）
        const minX = maskSize - imageWidth;
        const minY = maskSize - imageHeight;

        newX = Math.max(minX, Math.min(0, newX));
        newY = Math.max(minY, Math.min(0, newY));

        cropState.posX = newX;
        cropState.posY = newY;
        updateCropImagePosition();
    };

    const onDragEnd = () => {
        cropState.isDragging = false;
    };

    // マウスイベント
    cropMask.addEventListener('mousedown', onDragStart);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);

    // タッチイベント
    cropMask.addEventListener('touchstart', onDragStart, { passive: false });
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd);
}

// ===================================
// 管理者機能
// ===================================

/**
 * 管理者かどうかをチェック（認証済みフラグも同時に取得）
 */
async function checkIsAdmin() {
    if (!currentUser) {
        isAdmin = false;
        isVerified = false;
        return false;
    }

    try {
        const userDocPath = `users/${currentUser.uid}`;
        const doc = await db.doc(userDocPath).get();
        if (doc.exists) {
            const data = doc.data();
            isAdmin = data.isAdmin === true;
            isVerified = data.isVerified === true;
            return isAdmin;
        }
        isAdmin = false;
        isVerified = false;
        return false;
    } catch (error) {
        console.error('管理者チェックエラー:', error);
        isAdmin = false;
        isVerified = false;
        return false;
    }
}

/**
 * 管理者UIを更新（ボタン表示/非表示、認証バッジも含む）
 */
function updateAdminUI() {
    const adminBtn = document.getElementById('admin-btn');
    const adminBadge = document.getElementById('admin-badge');
    const verifiedBadge = document.getElementById('verified-badge');

    if (isAdmin) {
        if (adminBtn) adminBtn.classList.remove('hidden');
        if (adminBadge) adminBadge.classList.remove('hidden');
    } else {
        if (adminBtn) adminBtn.classList.add('hidden');
        if (adminBadge) adminBadge.classList.add('hidden');
    }

    if (isVerified) {
        if (verifiedBadge) verifiedBadge.classList.remove('hidden');
    } else {
        if (verifiedBadge) verifiedBadge.classList.add('hidden');
    }
}

/**
 * 管理画面を開く
 */
async function openAdminModal() {
    if (!isAdmin) return;

    const modal = document.getElementById('admin-modal');
    if (modal) modal.classList.remove('hidden');

    await loadUserList();
}

/**
 * 管理画面を閉じる
 */
function closeAdminModal() {
    const modal = document.getElementById('admin-modal');
    if (modal) modal.classList.add('hidden');
}

/**
 * ユーザー一覧を読み込み
 */
async function loadUserList() {
    const userList = document.getElementById('admin-user-list');
    const totalCount = document.getElementById('total-users-count');

    if (!userList) return;

    userList.innerHTML = '<div class="admin-loading">読み込み中...</div>';

    try {
        const snapshot = await db.collection('users').get();
        const users = [];

        snapshot.forEach(doc => {
            users.push({
                uid: doc.id,
                ...doc.data()
            });
        });

        if (totalCount) totalCount.textContent = users.length;

        if (users.length === 0) {
            userList.innerHTML = '<div class="admin-loading">ユーザーがいません</div>';
            return;
        }

        userList.innerHTML = users.map(user => `
            <div class="admin-user-item" data-uid="${user.uid}">
                <div class="admin-user-info">
                    <div class="admin-user-avatar">
                        ${user.profileImageUrl
                ? `<img src="${user.profileImageUrl}" alt="">`
                : `<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                <circle cx="12" cy="7" r="4"></circle>
                               </svg>`
            }
                    </div>
                    <div class="admin-user-details">
                        <span class="admin-user-name">${user.username || 'ユーザー'}</span>
                        <span class="admin-user-email">${user.uid}</span>
                    </div>
                </div>
                ${user.isAdmin ? '<span class="admin-user-badge">管理者</span>' : ''}
            </div>
        `).join('');

        // クリックイベントを追加
        userList.querySelectorAll('.admin-user-item').forEach(item => {
            item.addEventListener('click', () => {
                const uid = item.dataset.uid;
                openUserDataModal(uid);
            });
        });

    } catch (error) {
        console.error('ユーザー一覧読み込みエラー:', error);
        userList.innerHTML = '<div class="admin-loading">読み込みエラー</div>';
    }
}

/**
 * ユーザーデータモーダルを開く
 */
async function openUserDataModal(uid) {
    viewingUserId = uid;

    const modal = document.getElementById('user-data-modal');
    const title = document.getElementById('user-data-title');
    const body = document.getElementById('user-data-body');

    if (!modal || !body) return;

    modal.classList.remove('hidden');
    body.innerHTML = '<div class="admin-loading">読み込み中...</div>';

    try {
        // ユーザー情報を取得
        const userDoc = await db.doc(`users/${uid}`).get();
        const userData = userDoc.exists ? userDoc.data() : {};

        if (title) title.textContent = userData.username || 'ユーザーデータ';

        // 閲覧中ユーザーの認証状態を保存
        viewingUserIsVerified = userData.isVerified === true;
        updateVerifyButtonText();

        // 日次ログを取得
        let logs = [];
        try {
            const logsSnapshot = await db.collection(`users/${uid}/daily_logs`).get();
            logsSnapshot.forEach(doc => {
                logs.push({
                    date: doc.id,
                    ...doc.data()
                });
            });
            // 日付で降順ソートして最新7日分を取得
            logs.sort((a, b) => b.date.localeCompare(a.date));
            logs = logs.slice(0, 7);
        } catch (logError) {
            console.warn('日次ログ取得エラー:', logError);
            // ログ取得に失敗しても続行
        }

        // HTMLを生成
        let html = `
            <div class="user-data-section">
                <h4>プロフィール</h4>
                <div class="user-data-content">
                    <div class="user-data-item">
                        <span class="user-data-label">UID</span>
                        <span class="user-data-value">${uid}</span>
                    </div>
                    <div class="user-data-item">
                        <span class="user-data-label">ユーザー名</span>
                        <span class="user-data-value">${userData.username || '未設定'}</span>
                    </div>
                    <div class="user-data-item">
                        <span class="user-data-label">メールアドレス</span>
                        <span class="user-data-value">${userData.email || '未設定'}</span>
                    </div>
                    <div class="user-data-item">
                        <span class="user-data-label">管理者</span>
                        <span class="user-data-value">${userData.isAdmin ? 'はい' : 'いいえ'}</span>
                    </div>
                </div>
            </div>
        `;

        if (logs.length > 0) {
            html += `<div class="user-data-section"><h4>食事記録（最新7日分）</h4>`;

            logs.forEach(log => {
                html += `
                    <div class="user-data-content" style="margin-bottom: 8px;">
                        <strong>${log.date}</strong>
                        ${log.breakfast?.menu ? `<div class="user-data-item"><span class="user-data-label">朝</span><span class="user-data-value">${log.breakfast.menu}</span></div>` : ''}
                        ${log.lunch?.menu ? `<div class="user-data-item"><span class="user-data-label">昼</span><span class="user-data-value">${log.lunch.menu}</span></div>` : ''}
                        ${log.dinner?.menu ? `<div class="user-data-item"><span class="user-data-label">夜</span><span class="user-data-value">${log.dinner.menu}</span></div>` : ''}
                    </div>
                `;
            });

            html += `</div>`;
        } else {
            html += `<div class="user-data-section"><h4>食事記録</h4><div class="user-data-content">記録なし</div></div>`;
        }

        body.innerHTML = html;

    } catch (error) {
        console.error('ユーザーデータ読み込みエラー:', error);
        body.innerHTML = '<div class="admin-loading">読み込みエラー</div>';
    }
}

/**
 * ユーザーデータモーダルを閉じる
 */
function closeUserDataModal() {
    const modal = document.getElementById('user-data-modal');
    if (modal) modal.classList.add('hidden');
    viewingUserId = null;
}

/**
 * ユーザーを削除（Firestoreデータのみ - Auth削除は管理者SDKが必要）
 */
async function deleteUserData() {
    if (!viewingUserId) return;

    const confirmed = await showConfirm('このユーザーのデータを削除しますか？\n（認証アカウント自体はFirebaseコンソールから削除してください）', true);
    if (!confirmed) return;

    // 処理中ローディング表示
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) loadingScreen.classList.remove('hidden');

    try {
        // 日次ログを削除
        const logsSnapshot = await db.collection(`users/${viewingUserId}/daily_logs`).get();
        const batch = db.batch();

        logsSnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });

        // ユーザードキュメントを削除
        batch.delete(db.doc(`users/${viewingUserId}`));

        await batch.commit();

        showToast('ユーザーデータを削除しました', 'success');
        closeUserDataModal();
        await loadUserList();

    } catch (error) {
        console.error('ユーザー削除エラー:', error);
        showToast('削除に失敗しました', 'error');
    } finally {
        if (loadingScreen) loadingScreen.classList.add('hidden');
    }
}

// 閲覧中ユーザーの認証状態（ユーザーデータモーダル用）
let viewingUserIsVerified = false;

/**
 * ユーザーの認証を切り替え
 */
async function toggleUserVerification() {
    if (!viewingUserId) return;

    try {
        const newStatus = !viewingUserIsVerified;
        await db.doc(`users/${viewingUserId}`).set({
            isVerified: newStatus
        }, { merge: true });

        viewingUserIsVerified = newStatus;
        updateVerifyButtonText();

        showToast(newStatus ? '認証を付与しました' : '認証を取り消しました', 'success');
        await loadUserList();

    } catch (error) {
        console.error('認証切り替えエラー:', error);
        showToast('認証の切り替えに失敗しました', 'error');
    }
}

/**
 * 認証ボタンのテキストを更新
 */
function updateVerifyButtonText() {
    const textEl = document.getElementById('toggle-verify-text');
    if (textEl) {
        textEl.textContent = viewingUserIsVerified ? '認証を取り消す' : '認証を付与';
    }
}

// ===================================
// UI Helpers
// ===================================


/**
 * 全データをリセット（ログアウト時など）
 */
function resetAllData() {
    // 食事データのメモリをリセット
    resetMeals();
    // UI反映（入力欄クリア）
    updateUI();

    // ヘッダー情報のクリア
    const userEmail = document.getElementById('user-email');
    if (userEmail) userEmail.textContent = '';

    // プロフィール画像のクリア
    updateProfileImageDisplay('');

    // 設定モーダルのクリア
    const usernameInput = document.getElementById('username-input');
    if (usernameInput) usernameInput.value = '';

    // ファイル入力のリセット
    document.querySelectorAll('input[type="file"]').forEach(input => {
        input.value = '';
    });

    console.log('すべてのデータをリセットしました');
}

/**
 * ユーザーUIを更新
 */
function updateUserUI(user) {
    const loginScreen = document.getElementById('login-screen');
    const userAvatar = document.getElementById('user-avatar');
    const userMenu = document.querySelector('.user-menu');
    const header = document.querySelector('.header');
    const mainContent = document.querySelector('.main-content');
    const floatingSave = document.querySelector('.floating-save');

    if (user) {
        // ログイン済み
        loginScreen.classList.add('hidden');
        header.style.display = '';
        if (mainContent) mainContent.style.display = '';
        if (floatingSave) floatingSave.style.display = '';

        // メールアドレス表示
        const userEmail = document.getElementById('user-email');
        if (userEmail) {
            if (user.isAnonymous) {
                userEmail.textContent = 'ゲスト';
            } else {
                userEmail.textContent = user.email;
            }
        }
    } else {
        // 未ログイン
        loginScreen.classList.remove('hidden');
        header.style.display = 'none';
        if (mainContent) mainContent.style.display = 'none';
        if (floatingSave) floatingSave.style.display = 'none';

        // データを完全にリセット
        resetAllData();
    }
}

// ===================================
// Data Persistence (Firebase)
// ===================================

/**
 * 指定日のデータを読み込み
 */
async function loadData(dateStr) {
    if (isLoading || !currentUser) return;

    isLoading = true;

    try {
        const docPath = getDocPath(dateStr);
        const doc = await db.doc(docPath).get();

        if (doc.exists) {
            const data = doc.data();
            meals = {
                breakfast: data.breakfast || { menu: '', memo: '', imageUrl: '' },
                lunch: data.lunch || { menu: '', memo: '', imageUrl: '' },
                dinner: data.dinner || { menu: '', memo: '', imageUrl: '' }
            };
        } else {
            resetMeals();
        }

        // 読み込んだデータを変更検知の基準として保存
        lastSavedData = JSON.stringify(meals);

        updateUI();
    } catch (error) {
        console.error('データの読み込みに失敗:', error);
        resetMeals();
        updateUI();
    } finally {
        isLoading = false;
    }
}

/**
 * 現在のデータを保存
 */
async function saveData(showIndicator = false) {
    if (isSaving || !currentUser) return false;

    // 入力値を収集
    collectInputValues();

    // 変更がない場合は保存をスキップ（データ使用量を抑える）
    const currentDataStr = JSON.stringify(meals);
    if (lastSavedData === currentDataStr) {
        if (showIndicator) showSavedIndicator();
        return true;
    }

    isSaving = true;
    const dateStr = formatDate(selectedDate);

    try {
        const docPath = getDocPath(dateStr);

        // Firestoreに保存
        await db.doc(docPath).set({
            breakfast: meals.breakfast,
            lunch: meals.lunch,
            dinner: meals.dinner,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // 保存成功時に前回の保存内容を更新
        lastSavedData = currentDataStr;

        if (showIndicator) {
            showSavedIndicator();
        }

        return true;
    } catch (error) {
        console.error('データの保存に失敗:', error);
        lastSavedData = currentDataStr;
        if (showIndicator) {
            showSavedIndicator();
        }
        return false;
    } finally {
        isSaving = false;
    }
}

/**
 * 画像をFirebase Storageにアップロード
 */
/**
 * 画像をFirebase Storageにアップロード
 */
function uploadImageToStorage(file, mealType, onProgress) {
    return new Promise((resolve, reject) => {
        if (!currentUser) {
            reject(new Error('User not logged in'));
            return;
        }

        const dateStr = formatDate(selectedDate);
        const timestamp = Date.now();
        const extension = file.name.split('.').pop();
        const storagePath = `users/${currentUser.uid}/images/${dateStr}_${mealType}_${timestamp}.${extension}`;

        const storageRef = storage.ref(storagePath);
        const uploadTask = storageRef.put(file);

        uploadTask.on('state_changed',
            (snapshot) => {
                // 進捗状況
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                if (onProgress) onProgress(progress);
            },
            (error) => {
                // エラー
                console.error('画像アップロードエラー:', error);
                reject(error);
            },
            async () => {
                // 完了
                try {
                    const downloadURL = await uploadTask.snapshot.ref.getDownloadURL();
                    resolve(downloadURL);
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

/**
 * 自動保存をトリガー（デバウンス処理付き）
 */
function triggerAutoSave() {
    if (!autoSaveEnabled || !currentUser) return;

    if (autoSaveTimeout) {
        clearTimeout(autoSaveTimeout);
    }

    showSavingIndicator();

    autoSaveTimeout = setTimeout(() => {
        saveData(true);
    }, AUTO_SAVE_DELAY);
}

/**
 * 保存中インジケーターを表示
 */
function showSavingIndicator() {
    const saveIndicator = document.getElementById('save-indicator');
    const savedIndicator = document.getElementById('saved-indicator');

    if (saveIndicator && savedIndicator) {
        savedIndicator.classList.add('hidden');
        saveIndicator.classList.remove('hidden');
    }
}

/**
 * 保存完了インジケーターを表示
 */
function showSavedIndicator() {
    const saveIndicator = document.getElementById('save-indicator');
    const savedIndicator = document.getElementById('saved-indicator');

    if (saveIndicator && savedIndicator) {
        saveIndicator.classList.add('hidden');
        savedIndicator.classList.remove('hidden');

        setTimeout(() => {
            savedIndicator.classList.add('hidden');
        }, 2000);
    }
}

/**
 * meals オブジェクトをリセット
 */
function resetMeals() {
    meals = {
        breakfast: { menu: '', memo: '', imageUrl: '' },
        lunch: { menu: '', memo: '', imageUrl: '' },
        dinner: { menu: '', memo: '', imageUrl: '' }
    };
}

/**
 * 入力フィールドから値を収集
 */
function collectInputValues() {
    ['breakfast', 'lunch', 'dinner'].forEach(type => {
        meals[type].menu = document.getElementById(`${type}-menu`).value;
        meals[type].memo = document.getElementById(`${type}-memo`).value;
    });
}

// ===================================
// UI Updates
// ===================================

function updateUI() {
    updateDateDisplay();
    updateMealInputs();
    updateImagePreviews();
}

function updateDateDisplay() {
    const dateStr = formatDate(selectedDate);
    const dayLabel = getDayLabel(dateStr);

    document.getElementById('date-text').innerHTML =
        `${dateStr} <span class="day-label">(${dayLabel})</span>`;

    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.value = dateStr;
    }
}

function updateMealInputs() {
    ['breakfast', 'lunch', 'dinner'].forEach(type => {
        document.getElementById(`${type}-menu`).value = meals[type].menu || '';
        document.getElementById(`${type}-memo`).value = meals[type].memo || '';
    });
}

function updateImagePreviews() {
    ['breakfast', 'lunch', 'dinner'].forEach(type => {
        const uploadArea = document.getElementById(`${type}-upload`);
        const previewContainer = document.getElementById(`${type}-preview`);
        const previewImg = document.getElementById(`${type}-img`);

        if (meals[type].imageUrl) {
            uploadArea.classList.add('hidden');
            previewContainer.classList.remove('hidden');
            previewImg.src = meals[type].imageUrl;
        } else {
            uploadArea.classList.remove('hidden');
            previewContainer.classList.add('hidden');
            previewImg.src = '';
        }
    });
}

// ===================================
// Event Handlers
// ===================================

function changeDate(days) {
    saveData();
    selectedDate.setDate(selectedDate.getDate() + days);
    loadData(formatDate(selectedDate));
}

function handleDateSelect(event) {
    const value = event.target.value;
    if (!value) return;

    saveData();
    const [y, m, d] = value.split('-').map(Number);
    selectedDate = new Date(y, m - 1, d);
    loadData(formatDate(selectedDate));
}

/**
 * 画像アップロード処理（Firebase Storage対応）
 */
async function handleImageUpload(event, mealType) {
    const file = event.target.files[0];
    if (!file || !currentUser) return;

    // 画像ファイルかどうかをチェック
    if (!file.type.startsWith('image/')) {
        showToast('画像ファイルのみアップロードできます。', 'error');
        event.target.value = '';
        return;
    }

    // ファイルサイズチェック（5MB以下）
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
        showToast('ファイルサイズは5MB以下にしてください。', 'error');
        event.target.value = '';
        return;
    }

    const uploadArea = document.getElementById(`${mealType}-upload`);
    const progressContainer = document.getElementById(`${mealType}-progress`);
    const progressFill = progressContainer.querySelector('.progress-fill');
    const progressText = progressContainer.querySelector('.progress-text');

    uploadArea.classList.add('hidden');
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = '0%';

    try {
        // Firebase Storageにアップロード
        const downloadURL = await uploadImageToStorage(file, mealType, (progress) => {
            const percent = Math.round(progress);
            progressFill.style.width = `${percent}%`;
            progressText.textContent = `${percent}%`;
        });
        meals[mealType].imageUrl = downloadURL;
        updateImagePreviews();
        triggerAutoSave();
    } catch (error) {
        console.error('画像アップロードエラー:', error);
        // フォールバック: Base64として保存
        const reader = new FileReader();
        reader.onload = function (e) {
            meals[mealType].imageUrl = e.target.result;
            updateImagePreviews();
            triggerAutoSave();
        };
        reader.readAsDataURL(file);
    } finally {
        uploadArea.classList.remove('uploading');
        progressContainer.classList.add('hidden');
    }
}

/**
 * Firebase StorageのURLからパスを抽出
 */
function getStoragePathFromUrl(url) {
    if (!url || !url.includes('firebasestorage.googleapis.com')) {
        return null;
    }
    try {
        // URLからパスを抽出
        const decodedUrl = decodeURIComponent(url);
        const match = decodedUrl.match(/\/o\/(.+?)\?/);
        if (match && match[1]) {
            return match[1];
        }
    } catch (e) {
        console.error('パス抽出エラー:', e);
    }
    return null;
}

/**
 * Firebase Storageから画像を削除
 */
async function deleteImageFromStorage(imageUrl) {
    const storagePath = getStoragePathFromUrl(imageUrl);
    if (!storagePath) return;

    try {
        const storageRef = storage.ref(storagePath);
        await storageRef.delete();
        console.log('Storage画像を削除しました:', storagePath);
    } catch (error) {
        console.error('Storage画像の削除エラー:', error);
        // 削除に失敗しても続行（画像が既に存在しない場合など）
    }
}

/**
 * 画像削除処理（Firebase Storageからも削除）
 */
async function handleRemoveImage(mealType) {
    const confirmed = await showConfirm('画像を削除しますか？');
    if (!confirmed) return;

    const imageUrl = meals[mealType].imageUrl;

    // Firebase Storageから削除
    if (imageUrl && imageUrl.includes('firebasestorage.googleapis.com')) {
        await deleteImageFromStorage(imageUrl);
    }

    // ローカル状態をクリア
    meals[mealType].imageUrl = '';
    updateImagePreviews();
    document.getElementById(`${mealType}-file`).value = '';

    // Firestoreに保存
    triggerAutoSave();
}

function showImageModal(imageUrl) {
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('modal-img');
    modalImg.src = imageUrl;
    modal.classList.remove('hidden');
}

function closeImageModal() {
    document.getElementById('image-modal').classList.add('hidden');
}

async function handleSave() {
    const saveBtn = document.getElementById('save-btn');
    const saveText = document.getElementById('save-text');

    saveBtn.disabled = true;
    saveText.textContent = '保存中...';

    const success = await saveData();

    if (success) {
        saveText.textContent = '保存しました！';
        setTimeout(() => {
            saveBtn.disabled = false;
            saveText.textContent = '記録する';
        }, 1500);
    } else {
        saveBtn.disabled = false;
        saveText.textContent = '記録する';
    }
}

// ===================================
// Event Listeners Setup
// ===================================

let listenersInitialized = false;

function setupEventListeners() {
    if (listenersInitialized) return;
    listenersInitialized = true;

    // 自動保存トグル
    const autoSaveCheckbox = document.getElementById('auto-save-checkbox');
    if (autoSaveCheckbox) {
        autoSaveCheckbox.addEventListener('change', (e) => {
            autoSaveEnabled = e.target.checked;
            localStorage.setItem('autoSaveEnabled', autoSaveEnabled);
        });

        const savedAutoSave = localStorage.getItem('autoSaveEnabled');
        if (savedAutoSave !== null) {
            autoSaveEnabled = savedAutoSave === 'true';
            autoSaveCheckbox.checked = autoSaveEnabled;
        }
    }

    // 日付ナビゲーション
    document.getElementById('prev-date').addEventListener('click', () => changeDate(-1));
    document.getElementById('next-date').addEventListener('click', () => changeDate(1));

    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.addEventListener('change', handleDateSelect);
    }

    // 「今日」ボタン
    const todayBtn = document.getElementById('today-btn');
    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            saveData();
            selectedDate = new Date();
            loadData(formatDate(selectedDate));
        });
    }

    // 各食事セクションのイベント
    ['breakfast', 'lunch', 'dinner'].forEach(type => {
        const fileInput = document.getElementById(`${type}-file`);
        const uploadArea = document.getElementById(`${type}-upload`);
        const previewContainer = document.getElementById(`${type}-preview`);
        const previewImg = document.getElementById(`${type}-img`);
        const menuInput = document.getElementById(`${type}-menu`);
        const memoInput = document.getElementById(`${type}-memo`);

        menuInput.addEventListener('input', triggerAutoSave);
        memoInput.addEventListener('input', triggerAutoSave);

        uploadArea.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', (e) => {
            handleImageUpload(e, type);
        });

        previewImg.addEventListener('click', () => {
            if (meals[type].imageUrl) {
                showImageModal(meals[type].imageUrl);
            }
        });

        previewContainer.querySelectorAll('.action-btn, .mobile-action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;

                switch (action) {
                    case 'zoom':
                        showImageModal(meals[type].imageUrl);
                        break;
                    case 'change':
                        fileInput.click();
                        break;
                    case 'delete':
                        handleRemoveImage(type);
                        break;
                }
            });
        });
    });

    // 保存ボタン
    document.getElementById('save-btn').addEventListener('click', handleSave);

    // 画像モーダル
    document.getElementById('modal-close').addEventListener('click', closeImageModal);
    document.getElementById('image-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeImageModal();
        }
    });

    // ESCキー
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeImageModal();
            closeCalendarModal();
        }
    });

    // カレンダーモーダル
    setupCalendarEventListeners();
}

// ===================================
// Calendar Functions
// ===================================

function openCalendarModal() {
    calendarDisplayDate = new Date(selectedDate);
    renderCalendar();
    document.getElementById('calendar-modal').classList.remove('hidden');
}

function closeCalendarModal() {
    document.getElementById('calendar-modal').classList.add('hidden');
}

// 月のデータがある日付を取得
let monthDataDates = new Set();

async function fetchMonthDataDates(year, month) {
    if (!currentUser) return new Set();

    const dates = new Set();
    const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month + 1).padStart(2, '0')}-31`;

    try {
        const collectionPath = `users/${currentUser.uid}/daily_logs`;
        const snapshot = await db.collection(collectionPath)
            .where(firebase.firestore.FieldPath.documentId(), '>=', startDate)
            .where(firebase.firestore.FieldPath.documentId(), '<=', endDate)
            .get();

        snapshot.forEach(doc => {
            const data = doc.data();
            const hasContent =
                (data.breakfast && (data.breakfast.menu || data.breakfast.memo || data.breakfast.imageUrl)) ||
                (data.lunch && (data.lunch.menu || data.lunch.memo || data.lunch.imageUrl)) ||
                (data.dinner && (data.dinner.menu || data.dinner.memo || data.dinner.imageUrl));
            if (hasContent) {
                dates.add(doc.id);
            }
        });
    } catch (error) {
        console.error('月のデータ取得エラー:', error);
    }

    return dates;
}

async function renderCalendar() {
    const year = calendarDisplayDate.getFullYear();
    const month = calendarDisplayDate.getMonth();

    // Firebaseからその月のデータがある日付を取得
    monthDataDates = await fetchMonthDataDates(year, month);

    document.getElementById('calendar-month-year').textContent =
        `${year}年 ${month + 1}月`;

    const daysContainer = document.getElementById('calendar-days');
    daysContainer.innerHTML = '';

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    const today = new Date();
    const todayStr = formatDate(today);
    const selectedStr = formatDate(selectedDate);

    const startDayOfWeek = firstDay.getDay();
    const prevMonthLastDay = new Date(year, month, 0).getDate();

    for (let i = startDayOfWeek - 1; i >= 0; i--) {
        const day = prevMonthLastDay - i;
        const date = new Date(year, month - 1, day);
        const btn = createDayButton(date, true, todayStr, selectedStr);
        daysContainer.appendChild(btn);
    }

    for (let day = 1; day <= lastDay.getDate(); day++) {
        const date = new Date(year, month, day);
        const btn = createDayButton(date, false, todayStr, selectedStr);
        daysContainer.appendChild(btn);
    }

    const totalCells = 42;
    const currentCells = startDayOfWeek + lastDay.getDate();
    const remaining = totalCells - currentCells;

    for (let day = 1; day <= remaining; day++) {
        const date = new Date(year, month + 1, day);
        const btn = createDayButton(date, true, todayStr, selectedStr);
        daysContainer.appendChild(btn);
    }
}

function createDayButton(date, isOtherMonth, todayStr, selectedStr) {
    const btn = document.createElement('button');
    btn.className = 'calendar-day';
    btn.textContent = date.getDate();

    const dateStr = formatDate(date);
    const dayOfWeek = date.getDay();

    if (isOtherMonth) btn.classList.add('other-month');
    if (dayOfWeek === 0) btn.classList.add('sunday');
    else if (dayOfWeek === 6) btn.classList.add('saturday');
    if (dateStr === todayStr) btn.classList.add('today');
    if (dateStr === selectedStr) btn.classList.add('selected');

    // Firebaseから取得したデータがある日付かチェック
    if (monthDataDates.has(dateStr)) {
        btn.classList.add('has-data');
    }

    btn.addEventListener('click', () => selectDateFromCalendar(date));

    return btn;
}

function selectDateFromCalendar(date) {
    saveData();
    selectedDate = new Date(date);
    loadData(formatDate(selectedDate));
    closeCalendarModal();
}

function changeCalendarMonth(delta) {
    calendarDisplayDate.setMonth(calendarDisplayDate.getMonth() + delta);
    renderCalendar();
}

function setupCalendarEventListeners() {
    const dateSelector = document.querySelector('.date-selector-wrapper');
    if (dateSelector) {
        const datePicker = document.getElementById('date-picker');
        if (datePicker) datePicker.style.display = 'none';

        dateSelector.addEventListener('click', (e) => {
            e.preventDefault();
            openCalendarModal();
        });
    }

    document.getElementById('calendar-prev-month').addEventListener('click', () => changeCalendarMonth(-1));
    document.getElementById('calendar-next-month').addEventListener('click', () => changeCalendarMonth(1));

    document.getElementById('calendar-today-btn').addEventListener('click', () => {
        // 今日の日付を選択してカレンダーを閉じる
        saveData();
        selectedDate = new Date();
        calendarDisplayDate = new Date();
        loadData(formatDate(selectedDate));
        closeCalendarModal();
    });

    document.getElementById('calendar-close-btn').addEventListener('click', closeCalendarModal);

    document.getElementById('calendar-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeCalendarModal();
        }
    });
}

// ===================================
// Initialization
// ===================================

async function init() {
    // ローディング画面を表示
    document.getElementById('loading-screen').classList.remove('hidden');


    // メール/パスワード認証フォーム
    const emailForm = document.getElementById('email-auth-form');
    const emailInput = document.getElementById('email-input');
    const passwordInput = document.getElementById('password-input');
    const registerBtn = document.getElementById('register-btn');

    // ログインボタン（フォーム送信）
    if (emailForm) {
        emailForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            if (email && password) {
                await signInWithEmail(email, password);
            }
        });
    }

    // 新規登録ボタン
    if (registerBtn) {
        registerBtn.addEventListener('click', async () => {
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            if (email && password) {
                await registerWithEmail(email, password);
            }
        });
    }

    // 匿名モードボタン（ログインせずに使う）
    document.getElementById('local-mode-btn').addEventListener('click', async () => {
        await signInAnonymously();
    });

    // オンボーディング画面のイベントリスナー
    const onboardingAvatarBtn = document.getElementById('onboarding-avatar-btn');
    const onboardingAvatarInput = document.getElementById('onboarding-avatar-input');
    const onboardingSkipBtn = document.getElementById('onboarding-skip-btn');
    const onboardingSaveBtn = document.getElementById('onboarding-save-btn');


    if (onboardingAvatarBtn && onboardingAvatarInput) {
        onboardingAvatarBtn.addEventListener('click', () => {
            onboardingAvatarInput.click();
        });
        onboardingAvatarInput.addEventListener('change', (e) => {
            if (e.target.files[0]) {
                showCropModal(e.target.files[0], (croppedFile) => {
                    // クロップされたファイルをオンボーディング用に保存
                    onboardingAvatarFile = croppedFile;
                    // プレビューを更新
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const preview = document.getElementById('onboarding-avatar-preview');
                        const placeholder = document.getElementById('onboarding-avatar-placeholder');
                        if (preview) preview.src = ev.target.result;
                        if (placeholder) placeholder.classList.add('hidden');
                    };
                    reader.readAsDataURL(croppedFile);
                });
                e.target.value = '';
            }
        });
    }

    if (onboardingSkipBtn) {
        onboardingSkipBtn.addEventListener('click', skipOnboarding);
    }

    if (onboardingSaveBtn) {
        onboardingSaveBtn.addEventListener('click', completeOnboarding);
    }

    // ログアウトボタン
    document.getElementById('logout-btn').addEventListener('click', async () => {
        const confirmed = await showConfirm('ログアウトしますか？');
        if (confirmed) {
            await signOut();
            showToast('ログアウトしました', 'success');
        }
    });

    // 設定ボタン
    document.getElementById('settings-btn').addEventListener('click', async () => {
        document.getElementById('settings-modal').classList.remove('hidden');
        // ユーザー名を読み込んで入力欄に表示
        const username = await loadUsername();
        const usernameInput = document.getElementById('username-input');
        if (usernameInput && username) {
            usernameInput.value = username;
        }
        // プロフィール画像を読み込んで表示
        const profileImageUrl = await loadProfileImage();
        updateProfileImageDisplay(profileImageUrl || '');
    });

    // 設定モーダル閉じる
    document.getElementById('settings-close-btn').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
    });

    document.getElementById('settings-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            document.getElementById('settings-modal').classList.add('hidden');
        }
    });

    // ユーザー名保存ボタン
    document.getElementById('save-username-btn').addEventListener('click', async () => {
        const usernameInput = document.getElementById('username-input');
        const username = usernameInput.value.trim();
        if (username) {
            await saveUsername(username);
        } else {
            showToast('ユーザー名を入力してください', 'error');
        }
    });

    // アカウント削除ボタン
    const deleteAccountBtn = document.getElementById('delete-account-btn');
    // 古いイベントリスナーがある場合にそなえて（cloneNodeでリセットする方法もあるが、今回はフラグ管理で対応）
    const newDeleteBtn = deleteAccountBtn.cloneNode(true);
    deleteAccountBtn.parentNode.replaceChild(newDeleteBtn, deleteAccountBtn);

    newDeleteBtn.addEventListener('click', async () => {
        // 設定モーダルを先に閉じる
        document.getElementById('settings-modal').classList.add('hidden');

        const confirmed = await showConfirm('本当にアカウントを削除しますか？\nこの操作は取り消すことができません。', true);
        if (confirmed) {
            await deleteAccount();
        }
    });

    // プロフィール画像変更ボタン
    document.getElementById('change-avatar-btn').addEventListener('click', () => {
        document.getElementById('avatar-file-input').click();
    });

    // プロフィール画像ファイル選択（クロップモーダル経由）
    document.getElementById('avatar-file-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            showCropModal(file, async (croppedFile) => {
                await uploadProfileImage(croppedFile);
            });
            e.target.value = ''; // リセット
        }
    });

    // プロフィール画像削除ボタン
    document.getElementById('remove-avatar-btn').addEventListener('click', async () => {
        const confirmed = await showConfirm('プロフィール画像を削除しますか？');
        if (confirmed) {
            await removeProfileImage();
        }
    });

    // クロップモーダルのイベントリスナー
    document.getElementById('crop-cancel-btn').addEventListener('click', hideCropModal);
    document.getElementById('crop-confirm-btn').addEventListener('click', confirmCrop);

    // クロップモーダルのドラッグイベントを初期化
    initCropDragEvents();

    // 管理者ボタン
    document.getElementById('admin-btn').addEventListener('click', openAdminModal);

    // 管理画面モーダルを閉じる
    document.getElementById('admin-close-btn').addEventListener('click', closeAdminModal);
    document.getElementById('admin-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeAdminModal();
    });

    // ユーザーデータモーダルを閉じる
    document.getElementById('user-data-close-btn').addEventListener('click', closeUserDataModal);
    document.getElementById('user-data-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeUserDataModal();
    });

    // ユーザー削除ボタン
    document.getElementById('delete-user-btn').addEventListener('click', deleteUserData);

    // 認証トグルボタン
    document.getElementById('toggle-verify-btn').addEventListener('click', toggleUserVerification);

    // 認証状態の監視
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        updateUserUI(user);

        if (user) {
            // イベントリスナーをセットアップ
            setupEventListeners();
            // データを読み込み
            await loadData(formatDate(selectedDate));
            // ユーザー名を読み込んでヘッダーに表示
            const username = await loadUsername();
            if (username) {
                updateUsernameDisplay(username);
            }
            // プロフィール画像を読み込んでヘッダーに表示
            const profileImageUrl = await loadProfileImage();
            if (profileImageUrl) {
                updateProfileImageDisplay(profileImageUrl);
            }

            // ユーザー情報をFirestoreに同期（メールアドレスなど）
            if (user.email) {
                try {
                    await db.doc(`users/${user.uid}`).set({
                        email: user.email,
                        lastLoginAt: new Date().toISOString()
                    }, { merge: true });
                } catch (e) {
                    console.error('ユーザー情報同期エラー:', e);
                }
            }

            // 管理者チェックと管理者UI更新
            await checkIsAdmin();
            updateAdminUI();
        }

        // ローディング画面を非表示
        document.getElementById('loading-screen').classList.add('hidden');
    });
}

// DOMContentLoaded で初期化
document.addEventListener('DOMContentLoaded', init);
