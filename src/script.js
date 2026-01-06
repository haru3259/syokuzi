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

/**
 * ログアウト
 */
async function signOut() {
    try {
        await auth.signOut();
        currentUser = null;
        console.log('ログアウトしました');
    } catch (error) {
        console.error('ログアウトエラー:', error);
    }
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

        // アバター表示
        if (user.photoURL) {
            userAvatar.src = user.photoURL;
            userAvatar.style.display = '';
        } else {
            userAvatar.style.display = 'none';
        }
    } else {
        // 未ログイン
        loginScreen.classList.remove('hidden');
        header.style.display = 'none';
        if (mainContent) mainContent.style.display = 'none';
        if (floatingSave) floatingSave.style.display = 'none';
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
        // オフラインの場合はローカルストレージから読み込み
        loadFromLocalStorage(dateStr);
    } finally {
        isLoading = false;
    }
}

/**
 * ローカルストレージからデータを読み込み（オフライン用）
 */
function loadFromLocalStorage(dateStr) {
    const key = `meal_record_${dateStr}`;
    const storedData = localStorage.getItem(key);

    if (storedData) {
        try {
            meals = JSON.parse(storedData);
        } catch (e) {
            resetMeals();
        }
    } else {
        resetMeals();
    }

    updateUI();
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

        // ローカルストレージにもバックアップ
        localStorage.setItem(`meal_record_${dateStr}`, JSON.stringify(meals));

        // 保存成功時に前回の保存内容を更新
        lastSavedData = currentDataStr;

        if (showIndicator) {
            showSavedIndicator();
        }

        return true;
    } catch (error) {
        console.error('データの保存に失敗:', error);
        // オフラインの場合はローカルストレージに保存
        localStorage.setItem(`meal_record_${dateStr}`, JSON.stringify(meals));
        lastSavedData = currentDataStr;
        if (showIndicator) {
            showSavedIndicator();
        }
        return true;
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
    if (!confirm('画像を削除しますか？')) return;

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

function setupEventListeners() {
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

function renderCalendar() {
    const year = calendarDisplayDate.getFullYear();
    const month = calendarDisplayDate.getMonth();

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

    if (localStorage.getItem(`meal_record_${dateStr}`)) {
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

    // ログアウトボタン
    document.getElementById('logout-btn').addEventListener('click', async () => {
        if (confirm('ログアウトしますか？')) {
            await signOut();
        }
    });

    // 認証状態の監視
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        updateUserUI(user);

        if (user) {
            // イベントリスナーをセットアップ
            setupEventListeners();
            // データを読み込み
            await loadData(formatDate(selectedDate));
        }

        // ローディング画面を非表示
        document.getElementById('loading-screen').classList.add('hidden');
    });
}

// DOMContentLoaded で初期化
document.addEventListener('DOMContentLoaded', init);
