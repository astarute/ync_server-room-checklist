/* 서버실 점검 체크리스트 PWA
 * - Web NFC(NDEFReader)로 서버실 입구 태그를 스캔해 "실제로 그 자리에 있었다"는 증거를 남깁니다.
 * - 사람 식별은 이 기기에 등록된 이름(로컬 저장)을 사용합니다. 여러 명이 같은 기기를 쓰면
 *   설정에서 이름을 바꿔가며 쓰면 됩니다.
 * - 기록은 Google Apps Script 웹앱(설정에서 URL 입력)으로 전송되어 구글 시트에 쌓입니다.
 *   주소가 없거나 네트워크가 안 되면 기기에 임시 저장했다가 온라인이 되면 자동 재전송합니다.
 */

const LS = {
  name: 'src_user_name',
  team: 'src_user_team',
  email: 'src_user_email',
  endpoint: 'src_endpoint',
  pending: 'src_pending',
  historyCache: 'src_history_cache',
  deviceId: 'src_device_id',
  isAdmin: 'src_is_admin',
  // 로그아웃해도 지워지지 않는 "이 기기에서 예전에 등록했던 사람" 기록입니다. 한 번 등록한
  // 이메일로 다시 로그인하면(같은 기기) 직책 확인 화면을 건너뛰는 데 씁니다.
  knownUsers: 'src_known_users',
};

// 관리자용: 여기에 배포한 Apps Script 웹앱 주소를 미리 채워두면, 사용자가 설정에서
// 따로 입력하지 않아도 자동으로 이 주소를 씁니다. 비워두면(빈 문자열) 기존처럼
// 각자 기기의 설정 화면에서 입력해야 합니다.
const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzpXMmpLUMaGom-CtWO7jvj-H9Cxx2B58MyDwZL3q_7ru4o7VprSueVd9F-vYq3eP6P/exec';

// Google 로그인 설정: 학교 이메일(@ync.ac.kr) 계정만 로그인을 허용합니다.
// Google Cloud Console에서 만든 OAuth 클라이언트(웹 애플리케이션)의 "클라이언트 ID"를
// 아래에 붙여넣으세요. (예: 1234567890-abcxyz.apps.googleusercontent.com)
const GOOGLE_CLIENT_ID = '904845440598-a9sul7p4reug9rcre031im6e0mjdunce.apps.googleusercontent.com';

// 관리자용: 서버실/장비실 입구에 붙인 실제 NFC 태그의 고유 시리얼 번호를 여기에 채워두면
// 그 태그를 찍었을 때만 인식됩니다(더 이상 처음 찍은 사람이 이름을 등록하는 방식이 아닙니다).
// 태그를 구매해 붙인 뒤, 임시로 콘솔에 serial 값을 출력해보고 그 값을 그대로 복사해 넣으세요.
const FIXED_NFC_TAGS = {
  server: '여기에_서버실_태그_시리얼번호',
  equipment: '여기에_장비실_태그_시리얼번호',
};

const qs = (id) => document.getElementById(id);

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    /* ignore quota errors */
  }
}

function getEndpoint() {
  return localStorage.getItem(LS.endpoint) || DEFAULT_ENDPOINT;
}
function getUser() {
  return {
    name: localStorage.getItem(LS.name) || '',
    team: localStorage.getItem(LS.team) || '',
    email: localStorage.getItem(LS.email) || '',
  };
}
function isAdmin() {
  return localStorage.getItem(LS.isAdmin) === '1';
}

/* 로그아웃해도 지워지지 않는 "알고 있는 사람" 기록. 한 번 등록한 이메일이면 다음에
   같은 기기에서 로그아웃 후 다시 로그인해도 직책 확인 화면을 건너뛸 수 있게 해줍니다. */
function getKnownUser(email) {
  const map = loadJSON(LS.knownUsers, {});
  return map[String(email || '').toLowerCase()] || null;
}
function saveKnownUser(email, name, position) {
  const map = loadJSON(LS.knownUsers, {});
  map[String(email || '').toLowerCase()] = { name: name || '', position: position || '' };
  saveJSON(LS.knownUsers, map);
}

/* 계정관리(연결된 기기 목록)용: 이 기기를 구분할 고유 ID를 한 번 만들어 저장해두고
   계속 재사용합니다. 로그인 여부와 무관하게 기기 자체에 고정된 값입니다. */
function getDeviceId() {
  let id = localStorage.getItem(LS.deviceId);
  if (!id) {
    id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(LS.deviceId, id);
  }
  return id;
}

// User-Agent에서 대략적인 OS/브라우저 이름만 뽑아 사람이 알아보기 쉬운 이름으로 만듭니다.
// 정확한 기기 모델명까지는 알 수 없지만, 목록에서 "어느 기기인지" 구분하는 용도로는 충분합니다.
function getDeviceName() {
  const ua = navigator.userAgent || '';
  let os = '알 수 없는 기기';
  if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS/i.test(ua)) os = 'Mac';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return browser ? `${os} · ${browser}` : os;
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  qs(id).classList.remove('hidden');
  // 어떤 화면이 켜져있는지 body에 표시해둡니다. 홈 화면에서만 PC 레이아웃이
  // 본문 폭 제한을 풀어야 해서(로그인 박스를 화면 오른쪽 끝까지 붙이기 위해) CSS가 이 값을 봅니다.
  document.body.dataset.screen = id;
}

let toastTimer = null;
function toast(msg) {
  const el = qs('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ---------------- 로그인 로딩 표시 ----------------
 * 아이디/비번 로그인과 구글 로그인 둘 다, 서버 응답을 기다리는 동안 같은 오버레이를
 * 띄웁니다. 점 4개가 순서대로만(겹치지 않게) 튀어오르고, 정상에 도달하면 잠깐
 * 아이콘(방패/자물쇠/체크/열쇠)으로 바뀌었다가 다시 점으로 내려옵니다.
 * CSS 애니메이션 대신 requestAnimationFrame으로 매 프레임 직접 계산해서, 4개 점의
 * 타이밍(느린 상승 + 정상 유지 + 빠른 하강)을 정확히 맞춥니다.
 */
const LOGIN_LOADING_DURATION = 3200; // ms, 점 4개가 한 바퀴 도는 전체 시간
const LOGIN_LOADING_SEG = LOGIN_LOADING_DURATION / 4; // 점 하나가 맡는 구간
const LOGIN_LOADING_RISE_FRAC = 0.62; // 그 구간 중 "올라가는 데" 쓰는 비율 → 느리게
const LOGIN_LOADING_HOLD_FRAC = 0.20; // 정상에서 아이콘으로 멈춰있는 비율

let loginLoadingRaf = null;
let loginLoadingStart = 0;

function loginLoadingEase(x) {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));
}

function loginLoadingFrame(now) {
  const t = (now - loginLoadingStart) % LOGIN_LOADING_DURATION;
  for (let i = 0; i < 4; i++) {
    const wrap = qs('loginDot' + i);
    if (!wrap) continue;
    const plain = wrap.querySelector('.dot-plain');
    const icon = wrap.querySelector('.dot-icon');
    const local = t - i * LOGIN_LOADING_SEG;
    let y = 0;
    let showIcon = false;
    if (local >= 0 && local < LOGIN_LOADING_SEG) {
      const riseEnd = LOGIN_LOADING_SEG * LOGIN_LOADING_RISE_FRAC;
      const holdEnd = riseEnd + LOGIN_LOADING_SEG * LOGIN_LOADING_HOLD_FRAC;
      if (local <= riseEnd) {
        y = -11 * loginLoadingEase(local / riseEnd);
        showIcon = local >= riseEnd * 0.82;
      } else if (local <= holdEnd) {
        y = -11;
        showIcon = true;
      } else {
        const frac = (local - holdEnd) / (LOGIN_LOADING_SEG - holdEnd);
        y = -11 * (1 - loginLoadingEase(frac));
        showIcon = frac < 0.25;
      }
    }
    wrap.style.transform = `translateY(${y}px)`;
    plain.style.opacity = showIcon ? '0' : '1';
    icon.style.opacity = showIcon ? '1' : '0';
  }
  loginLoadingRaf = requestAnimationFrame(loginLoadingFrame);
}

function showLoginLoading() {
  qs('loginLoadingOverlay').classList.remove('hidden');
  loginLoadingStart = performance.now();
  if (loginLoadingRaf) cancelAnimationFrame(loginLoadingRaf);
  loginLoadingRaf = requestAnimationFrame(loginLoadingFrame);
}

function hideLoginLoading() {
  qs('loginLoadingOverlay').classList.add('hidden');
  if (loginLoadingRaf) {
    cancelAnimationFrame(loginLoadingRaf);
    loginLoadingRaf = null;
  }
}

/* ---------------- 초기화 ---------------- */

let pendingChecklist = null; // 스캔 확인 후 checklist 화면에 넘길 정보
let pendingGoogleUser = null; // Google 로그인 확인 후, 직책 입력 전까지 임시로 들고 있는 사용자 정보

function init() {
  registerServiceWorker();
  updateOnlineDot();
  syncTopbarHeightVar();
  if (!window.__topbarResizeBound) {
    window.addEventListener('resize', syncTopbarHeightVar);
    window.__topbarResizeBound = true;
  }
  window.addEventListener('online', () => { updateOnlineDot(); flushPending(); });
  window.addEventListener('offline', updateOnlineDot);

  const user = getUser();
  // 관리자 계정으로 로그인했을 때만 PC에서도 서버실/장비실 탭과 가입자 관리 탭이 보이도록
  // body에 표시를 남겨둡니다(CSS에서 body.is-admin 기준으로 노출 여부를 결정합니다).
  document.body.classList.toggle('is-admin', !!(user.name && user.email) && isAdmin());
  if (!user.name || !user.email) {
    // 로그인 전에는 메뉴/설정 버튼을 감추고(모바일), PC의 고정 사이드바도 감춰서
    // (body.logged-out + CSS) 구글 로그인을 건너뛰고 다른 화면으로 갈 방법을 없앱니다.
    // 모바일 드로어 자체의 열림/닫힘 상태(hidden 클래스)는 건드리지 않습니다 —
    // 그건 openDrawer/closeDrawer가 따로 관리합니다.
    document.body.classList.add('logged-out');
    qs('menuBtn').classList.add('hidden');
    closeDrawer();
    showScreen('screen-onboard');
    startGoogleSignIn();
  } else {
    document.body.classList.remove('logged-out');
    qs('menuBtn').classList.remove('hidden');
    showScreen('screen-home');
    // 이름 첫 글자 대신, 카카오톡 기본 프로필 느낌의 사람 실루엣 아이콘을 보여줍니다.
    qs('homeUserAvatar').innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.2" r="4"/><path d="M12 13.5c-5 0-8 2.7-8 6.5v1h16v-1c0-3.8-3-6.5-8-6.5z"/></svg>';
    qs('homeUserName').textContent = user.name + (user.team ? ` · ${user.team}` : '');
    startClock();
    loadHistory();
    flushPending();
  }

  bindEvents();
}

function updateOnlineDot() {
  // 상단바의 초록/빨강 점 표시는 뺐지만, 온라인/오프라인 판단 로직 자체는 다른 곳
  // (기록 새로고침, 밀린 기록 재전송)에서 계속 쓰이니 이 함수는 남겨둡니다.
  const dot = qs('statusDot');
  if (!dot) return;
  if (navigator.onLine) dot.classList.remove('offline');
  else dot.classList.add('offline');
}

// PC 화면에서 사이드바(.drawer)가 상단 고정바 바로 밑에 겹침 없이 붙도록, 상단바의
// 실제 렌더링 높이를 측정해 CSS 변수(--topbar-height)로 갱신합니다.
function syncTopbarHeightVar() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const height = topbar.offsetHeight;
  if (height > 0) {
    document.documentElement.style.setProperty('--topbar-height', height + 'px');
  }
}

function startClock() {
  const tick = () => { qs('nowClock').textContent = formatDateTime(new Date()).slice(11); };
  tick();
  setInterval(tick, 1000);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ---------------- 이벤트 바인딩 ---------------- */

function bindEvents() {
  // init()은 최초 로드 때뿐 아니라 로그인/로그아웃 성공 시에도 다시 호출되는데, 그때마다
  // bindEvents()도 같이 불려서 예전에는 매 로그인마다 모든 이벤트 리스너가 중복으로
  // 쌓였습니다(토글류는 두 번 실행돼도 서로 상쇄돼 눈에 안 띄었지만, 목록을 불러와
  // 누적하는 곳들은 항목이 두 배로 쌓이는 실제 버그였습니다). 그래서 최초 한 번만
  // 바인딩하도록 막습니다.
  if (window.__eventsBound) return;
  window.__eventsBound = true;

  qs('onboardSaveBtn').addEventListener('click', onOnboardSave);
  qs('adminLoginForm').addEventListener('submit', onAdminLoginSubmit);
  qs('setBackBtn').addEventListener('click', () => showScreen('screen-home'));
  qs('setSaveBtn').addEventListener('click', onSettingsSave);
  qs('setLogoutBtn').addEventListener('click', () => onLogout());
  qs('setAccountMgmtBtn').addEventListener('click', openAccountDevices);
  qs('menuBtn').addEventListener('click', openDrawer);
  qs('drawerOverlay').addEventListener('click', closeDrawer);
  qs('drawerHome').addEventListener('click', () => { closeDrawer(); showScreen('screen-home'); loadHistory(); });
  qs('drawerServerRoom').addEventListener('click', () => { closeDrawer(); showScreen('screen-server'); });
  qs('drawerEquipRoom').addEventListener('click', () => { closeDrawer(); showScreen('screen-equipment'); });
  qs('drawerRecords').addEventListener('click', () => { closeDrawer(); openRecords(); });
  qs('drawerSettings').addEventListener('click', () => { closeDrawer(); openSettings(); });
  qs('drawerUserMgmt').addEventListener('click', () => { closeDrawer(); openUserManagement(); });
  qs('drawerRoomsToggle').addEventListener('click', toggleRoomsSubmenu);
  // 사이드바 메뉴 항목 클릭 시 중앙에서 원이 퍼지는 리플 효과
  document.querySelectorAll('.drawer-item').forEach((btn) => {
    btn.addEventListener('click', () => rippleEffect(btn));
  });
  document.querySelectorAll('.drawer-subitem').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = btn.dataset.room;
      closeDrawer();
      openRoomChecklist(room);
    });
  });
  qs('scanBtn').addEventListener('click', () => startNfcScan('server'));
  qs('manualBtn').addEventListener('click', () => startManualCheckIn('server'));
  qs('scanBtn2').addEventListener('click', () => startNfcScan('equipment'));
  qs('manualBtn2').addEventListener('click', () => startManualCheckIn('equipment'));
  // PC용, 모바일용 새로고침 버튼 둘 다 같은 동작을 합니다 (화면 폭에 따라 둘 중 하나만 보임).
  qs('refreshBtn').addEventListener('click', () => { spinRefreshIcon(); loadHistory(); });
  qs('refreshBtnMobile').addEventListener('click', () => { spinRefreshIcon(); loadHistory(); });
  ['refreshIcon', 'refreshIconMobile'].forEach((iconId) => {
    qs(iconId).addEventListener('transitionend', (e) => {
      if (e.propertyName !== 'transform') return;
      qs('refreshBtn').disabled = false;
      qs('refreshBtnMobile').disabled = false;
    });
  });
  qs('cancelBtn').addEventListener('click', () => showScreen('screen-home'));
  qs('doneHomeBtn').addEventListener('click', () => { showScreen('screen-home'); loadHistory(); });
  qs('checklistForm').addEventListener('submit', onSubmitChecklist);
  qs('fPhoto').addEventListener('change', onPhotoChange);

  qs('recordsBackBtn').addEventListener('click', () => showScreen('screen-home'));
  qs('recordsMoreBtn').addEventListener('click', loadMoreRecords);
  qs('recPlaceFilter').addEventListener('change', () => {
    recordsState.place = qs('recPlaceFilter').value;
    renderRecordsList();
    if (calState) renderCalendarMonth();
  });
  qs('recDateFilter').addEventListener('change', () => {
    recordsState.date = qs('recDateFilter').value;
    renderRecordsList();
    if (calState) renderCalendarMonth();
  });
  document.querySelectorAll('#screen-records .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-records .chip').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      recordsState.filter = btn.dataset.filter;
      renderRecordsList();
      if (calState) renderCalendarMonth();
    });
  });

  qs('calPrevBtn').addEventListener('click', () => {
    calState.monthDate = new Date(calState.monthDate.getFullYear(), calState.monthDate.getMonth() - 1, 1);
    renderCalendarMonth();
  });
  qs('calNextBtn').addEventListener('click', () => {
    calState.monthDate = new Date(calState.monthDate.getFullYear(), calState.monthDate.getMonth() + 1, 1);
    renderCalendarMonth();
  });
  qs('calLoadMoreBtn').addEventListener('click', () => loadCalendarBatch(false));
}

// 사이드바 메뉴 항목을 누르면 클릭한 항목의 정중앙에서 진짜 원(도형) 하나가 커지면서
// 퍼지고, 다 퍼진 직후 잠깐 테두리가 나타났다가 사라지는 클릭 피드백 효과입니다.
// (clip-path 방식은 가로로 긴 박스에서 원이 찌그러져 보여서, 실제 원형 div를 키우는
// 방식으로 만들었습니다.)
function rippleEffect(el) {
  const old = el.querySelector('.ripple-el');
  if (old) old.remove();

  const ripple = document.createElement('div');
  ripple.className = 'ripple-el';
  el.appendChild(ripple);

  const rect = el.getBoundingClientRect();
  const size = Math.sqrt(rect.width * rect.width + rect.height * rect.height) * 1.15;

  requestAnimationFrame(() => {
    ripple.style.width = size + 'px';
    ripple.style.height = size + 'px';
  });

  el.classList.add('ripple-active');
  setTimeout(() => { ripple.style.opacity = '0'; }, 1150);
  setTimeout(() => {
    el.classList.remove('ripple-active');
    ripple.remove();
  }, 1350);
}

// 새로고침 아이콘을 클릭할 때마다 항상 화살표 방향(정방향)으로만 720도씩 더 돌립니다.
// 값을 절대 줄이지 않고 누적만 시키기 때문에 역방향으로 튀는 일이 없고, 회전이 끝날
// 때까지는 버튼을 잠가서 연타해도 애니메이션이 꼬이지 않게 합니다.
let refreshRotation = 0;
function spinRefreshIcon() {
  qs('refreshBtn').disabled = true;
  qs('refreshBtnMobile').disabled = true;
  refreshRotation += 720;
  qs('refreshIcon').style.transform = `rotate(${refreshRotation}deg)`;
  qs('refreshIconMobile').style.transform = `rotate(${refreshRotation}deg)`;
}

function onOnboardSave() {
  if (!pendingGoogleUser) {
    toast('로그인 정보가 없습니다. 처음부터 다시 진행해주세요.');
    showScreen('screen-onboard');
    startGoogleSignIn();
    return;
  }

  // 직원명단 시트에 있던 사람은 자동으로 채워진 직책을 그대로 쓰고,
  // 명단에 없던 사람은 드롭다운에서 고른 값을 써야 합니다.
  let team = pendingGoogleUser.position || '';
  if (!team) {
    team = qs('onboardTeamSelect').value;
    if (!team) {
      toast('직책을 선택해주세요.');
      return;
    }
  }

  localStorage.removeItem(LS.isAdmin);
  localStorage.setItem(LS.name, pendingGoogleUser.name);
  localStorage.setItem(LS.email, pendingGoogleUser.email);
  localStorage.setItem(LS.team, team);
  saveKnownUser(pendingGoogleUser.email, pendingGoogleUser.name, team);
  registerDeviceRequest(pendingGoogleUser.email, getDeviceId(), getDeviceName(), pendingGoogleUser.name, team);
  pendingGoogleUser = null;
  init();
}

// skipConfirm: 계정관리 화면에서 "이 기기" 로그아웃을 누른 경우, 거기서 이미 확인을
// 받았으므로 여기서 또 confirm 창을 띄우지 않기 위한 옵션입니다.
function onLogout(skipConfirm) {
  if (!skipConfirm && !confirm('로그아웃하고 다른 Google 계정으로 로그인하시겠습니까?\n이 기기에 저장된 이름/직책 정보가 지워집니다.')) return;
  const user = getUser();
  logoutDeviceRequest(user.email, getDeviceId()); // 서버 기록용(베스트에포트, 실패해도 로그아웃은 진행)
  localStorage.removeItem(LS.name);
  localStorage.removeItem(LS.email);
  localStorage.removeItem(LS.team);
  localStorage.removeItem(LS.isAdmin);
  // LS.knownUsers(이 기기에서 예전에 등록했던 사람 기록)는 일부러 지우지 않습니다 —
  // 같은 이메일로 다시 로그인할 때 직책 확인 화면을 건너뛰기 위해 남겨둡니다.
  if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
    try { google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
  }
  init();
}

/* ---------------- Google 로그인 ----------------
 * Google Identity Services(GSI) 버튼을 렌더링하고, 로그인 성공 시 받은 ID 토큰을
 * Apps Script 백엔드로 보내 "학교 이메일(@ync.ac.kr)이 맞는지" 검증합니다.
 * 검증은 반드시 서버(Apps Script)에서 하며, 브라우저에서 받은 값만 믿지 않습니다.
 */

function startGoogleSignIn(retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 20; // 최대 약 4초 대기

  qs('onboardStep1').classList.remove('hidden');
  qs('onboardStep2').classList.add('hidden');

  if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
    if (retriesLeft <= 0) {
      qs('onboardLoginStatus').className = 'scan-status error';
      qs('onboardLoginStatus').textContent = 'Google 로그인 스크립트를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해주세요.';
      return;
    }
    setTimeout(() => startGoogleSignIn(retriesLeft - 1), 200);
    return;
  }

  qs('onboardLoginStatus').className = 'scan-status';
  qs('onboardLoginStatus').textContent = '';

  if (!window.__gsiInited) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      // 사파리(ITP) 브라우저에서도 팝업 리다이렉트 없이 지금과 같은 방식으로
      // 로그인 결과를 콜백으로 받을 수 있도록 해주는 옵션입니다.
      itp_support: true,
    });
    window.__gsiInited = true;
  }
  qs('gsiButtonContainer').innerHTML = '';
  google.accounts.id.renderButton(qs('gsiButtonContainer'), {
    theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ko', width: 280,
  });
}

async function handleGoogleCredential(response) {
  console.log('[진단] Google 응답:', response);
  console.log('[진단] credential 길이:', response && response.credential ? response.credential.length : '(없음)');

  const statusEl = qs('onboardLoginStatus');
  statusEl.className = 'scan-status';
  statusEl.textContent = '로그인 확인 중...';

  const endpoint = getEndpoint();
  if (!endpoint) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '서버 주소가 설정되지 않아 로그인을 확인할 수 없습니다.';
    return;
  }

  showLoginLoading();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', idToken: response.credential }),
    });
    const data = await res.json();

    if (!data.ok) {
      hideLoginLoading();
      statusEl.className = 'scan-status error';
      statusEl.textContent = data.error === 'domain_not_allowed'
        ? '학교 이메일(@ync.ac.kr) 계정으로만 로그인할 수 있습니다. 다른 계정으로 다시 시도해주세요.'
        : data.error === 'blocked'
          ? '이 계정은 관리자에 의해 로그인이 제한되었습니다. 관리자에게 문의해주세요.'
          : '로그인 확인에 실패했습니다. 다시 시도해주세요.';
      return;
    }

    hideLoginLoading();

    // 이 기기에서 예전에 이미 등록했던(직책까지 입력했던) 이메일이면, 직책 확인 화면을
    // 다시 보여줄 필요 없이 바로 로그인을 완료합니다.
    const known = getKnownUser(data.email);
    if (known) {
      const position = known.position || data.position || '';
      localStorage.removeItem(LS.isAdmin);
      localStorage.setItem(LS.name, data.name);
      localStorage.setItem(LS.email, data.email);
      localStorage.setItem(LS.team, position);
      saveKnownUser(data.email, data.name, position);
      registerDeviceRequest(data.email, getDeviceId(), getDeviceName(), data.name, position);
      init();
      return;
    }

    pendingGoogleUser = { name: data.name, email: data.email, position: data.position || '' };
    qs('onboardConfirmedName').textContent = data.name;
    qs('onboardConfirmedEmail').textContent = data.email;
    qs('onboardStep1').classList.add('hidden');
    qs('onboardStep2').classList.remove('hidden');

    // 직원명단 시트에서 이메일로 직책을 찾았으면 자동으로 채워서 보여주고,
    // 못 찾았으면 직접 골라야 하는 드롭다운을 보여줍니다.
    if (pendingGoogleUser.position) {
      qs('onboardTeamAuto').value = pendingGoogleUser.position;
      qs('onboardTeamAutoWrap').classList.remove('hidden');
      qs('onboardTeamSelectWrap').classList.add('hidden');
    } else {
      qs('onboardTeamAutoWrap').classList.add('hidden');
      qs('onboardTeamSelectWrap').classList.remove('hidden');
      qs('onboardTeamSelect').value = '';
    }
  } catch (err) {
    hideLoginLoading();
    statusEl.className = 'scan-status error';
    statusEl.textContent = '네트워크 오류로 로그인 확인에 실패했습니다. 다시 시도해주세요.';
  }
}

/* ---------------- 관리자 아이디/비밀번호 로그인 ----------------
 * 구글 로그인 없이도 쓸 수 있게 만든 보조 로그인입니다. 아이디/비밀번호는 화면(이 파일)에는
 * 전혀 들어있지 않고, 입력값을 서버(Apps Script)로 보내서 거기서만 맞는지 확인합니다.
 * (F12로 이 파일을 봐도 실제 비밀번호는 어디에도 보이지 않습니다.)
 */
async function onAdminLoginSubmit(e) {
  e.preventDefault();

  const id = qs('adminId').value.trim();
  const pw = qs('adminPw').value;
  const statusEl = qs('adminLoginStatus');
  const btn = qs('adminLoginBtn');

  if (!id || !pw) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '아이디와 비밀번호를 입력해주세요.';
    return;
  }

  const endpoint = getEndpoint();
  if (!endpoint) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '서버 주소가 설정되지 않아 로그인을 확인할 수 없습니다.';
    return;
  }

  btn.disabled = true;
  statusEl.className = 'scan-status';
  statusEl.textContent = '로그인 확인 중...';
  showLoginLoading();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'adminLogin', id, pw }),
    });
    const data = await res.json();

    if (!data.ok) {
      hideLoginLoading();
      statusEl.className = 'scan-status error';
      statusEl.textContent = data.error === 'admin_not_configured'
        ? '관리자 계정이 아직 설정되지 않았습니다. 관리자에게 문의해주세요.'
        : '아이디 또는 비밀번호가 올바르지 않습니다.';
      btn.disabled = false;
      return;
    }

    hideLoginLoading();
    // 관리자는 직책이 이미 정해져 있어(항상 "관리자") 직책 선택 단계 없이 바로 로그인 처리합니다.
    // 이메일이 없는 계정이라, 입력한 아이디를 식별자로 대신 저장합니다.
    localStorage.setItem(LS.name, data.name || '관리자');
    localStorage.setItem(LS.email, id);
    localStorage.setItem(LS.team, data.position || '');
    localStorage.setItem(LS.isAdmin, '1');
    registerDeviceRequest(id, getDeviceId(), getDeviceName(), data.name || '관리자', data.position || '');
    init();
  } catch (err) {
    hideLoginLoading();
    statusEl.className = 'scan-status error';
    statusEl.textContent = '네트워크 오류로 로그인 확인에 실패했습니다. 다시 시도해주세요.';
    btn.disabled = false;
  }
}

function openDrawer() {
  qs('drawer').classList.remove('hidden');
  qs('drawerOverlay').classList.remove('hidden');
}
function closeDrawer() {
  qs('drawer').classList.add('hidden');
  qs('drawerOverlay').classList.add('hidden');
}

function toggleRoomsSubmenu() {
  qs('roomsSubmenu').classList.toggle('hidden');
  qs('roomsCaret').classList.toggle('open');
}

// 강의실 목록에서 방을 선택하면, NFC 스캔 없이 바로 체크리스트 입력 화면으로 이동합니다.
function openRoomChecklist(roomLabel) {
  openChecklist({ tagId: '강의실:' + roomLabel, tagLabel: roomLabel, method: 'manual' });
}

function openSettings() {
  const user = getUser();
  qs('setName').value = user.name;
  qs('setEmail').value = user.email;
  showScreen('screen-settings');
}

// 설정 화면에서 직책 입력칸을 없애서(이름/이메일처럼 읽기 전용 정보만 남음),
// 이제 저장 버튼은 딱히 바꿀 값이 없어 확인 후 홈으로 돌아가는 역할만 합니다.
function onSettingsSave() {
  toast('저장되었습니다.');
  showScreen('screen-home');
  loadHistory();
}

/* ---------------- 계정관리: 이 계정에 연결된 기기 ----------------
 * 하트비트(주기적 접속 확인) 없이, "로그인 기록은 있는데 그 뒤로 로그아웃 기록이 없는
 * 기기 = 로그인 중"으로 판단합니다. 기기 목록은 서버(앱스 스크립트)의 기기세션 시트에서
 * 가져오고, 다른 기기 로그아웃은 그 기기가 다음에 온라인 상태가 될 때 반영됩니다.
 */

function registerDeviceRequest(account, deviceId, deviceName, name, position) {
  const endpoint = getEndpoint();
  if (!endpoint || !account) return;
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'registerDevice', account, deviceId, deviceName, name, position }),
  }).catch(() => { /* 베스트에포트 — 실패해도 로그인 자체는 그대로 진행됩니다 */ });
}

async function logoutDeviceRequest(account, deviceId) {
  const endpoint = getEndpoint();
  if (!endpoint || !account) return false;
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'logoutDevice', account, deviceId }),
    });
    return true;
  } catch (err) {
    return false;
  }
}

function openAccountDevices() {
  showScreen('screen-account-devices');
  loadDevices();
}

async function loadDevices() {
  const listEl = qs('devicesList');
  const endpoint = getEndpoint();
  if (!endpoint) {
    listEl.innerHTML = '<p class="muted small">설정에서 서버 저장 주소를 입력하면 기기 목록을 볼 수 있습니다.</p>';
    return;
  }

  const account = getUser().email;
  listEl.innerHTML = '<p class="muted small">불러오는 중...</p>';

  try {
    const url = endpoint + (endpoint.includes('?') ? '&' : '?') +
      'action=listDevices&account=' + encodeURIComponent(account);
    const res = await fetch(url);
    const data = await res.json();
    renderDevicesList((data && data.devices) || []);
  } catch (err) {
    listEl.innerHTML = '<p class="muted small">기기 목록을 불러오지 못했습니다. 네트워크를 확인해주세요.</p>';
  }
}

function renderDevicesList(devices) {
  const listEl = qs('devicesList');
  listEl.innerHTML = '';

  if (!devices.length) {
    listEl.innerHTML = '<p class="muted small">연결된 기기 기록이 없습니다.</p>';
    return;
  }

  const myDeviceId = getDeviceId();
  devices.forEach((dev) => {
    const isThis = dev.deviceId === myDeviceId;
    const loginDate = dev.loginAt ? formatDateTime(new Date(dev.loginAt)) : '-';

    const row = document.createElement('div');
    row.className = 'device-item';
    row.innerHTML = `
      <div class="device-main">
        <div class="device-name">${dev.deviceName || '알 수 없는 기기'}${isThis ? '<span class="badge-me">이 기기</span>' : ''}</div>
        <div class="device-sub">로그인: ${loginDate}</div>
      </div>
      <button type="button" class="btn btn-ghost device-logout-btn">로그아웃</button>
    `;
    row.querySelector('.device-logout-btn').addEventListener('click', () => onDeviceLogoutClick(dev, isThis));
    listEl.appendChild(row);
  });
}

async function onDeviceLogoutClick(dev, isThis) {
  const msg = isThis
    ? '이 기기를 로그아웃하시겠습니까?'
    : `"${dev.deviceName || '이 기기'}"를 로그아웃 처리하시겠습니까?\n다음에 그 기기가 인터넷에 연결될 때 반영됩니다.`;
  if (!confirm(msg)) return;

  if (isThis) {
    // onLogout이 서버 기록(logoutDeviceRequest)까지 알아서 처리합니다.
    onLogout(true);
    return;
  }

  const account = getUser().email;
  await logoutDeviceRequest(account, dev.deviceId);
  toast('로그아웃 처리했습니다.');
  loadDevices();
}

/* ---------------- 가입자 관리 (관리자 전용) ----------------
 * 구글 계정으로 로그인한 사람 전체 명단을 보여주고, 특정 계정을 삭제하거나 차단할 수 있게
 * 합니다. 차단하면 다음 로그인 시도부터 서버(verifyGoogleIdToken)에서 거부됩니다.
 */

function openUserManagement() {
  showScreen('screen-user-management');
  loadUsers();
}

async function loadUsers() {
  const listEl = qs('usersList');
  const endpoint = getEndpoint();
  if (!endpoint) {
    listEl.innerHTML = '<p class="muted small">설정에서 서버 저장 주소를 입력하면 가입자 목록을 볼 수 있습니다.</p>';
    return;
  }

  listEl.innerHTML = '<p class="muted small">불러오는 중...</p>';

  try {
    const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'action=listUsers';
    const res = await fetch(url);
    const data = await res.json();
    renderUsersList((data && data.users) || []);
  } catch (err) {
    listEl.innerHTML = '<p class="muted small">가입자 목록을 불러오지 못했습니다. 네트워크를 확인해주세요.</p>';
  }
}

function renderUsersList(users) {
  const listEl = qs('usersList');
  listEl.innerHTML = '';

  if (!users.length) {
    listEl.innerHTML = '<p class="muted small">아직 구글로 가입한 사용자가 없습니다.</p>';
    return;
  }

  users.forEach((u) => {
    const joined = u.joinedAt ? formatDateTime(new Date(u.joinedAt)) : '-';
    const lastLogin = u.lastLoginAt ? formatDateTime(new Date(u.lastLoginAt)) : '-';
    const isBlocked = u.status === 'blocked';

    const row = document.createElement('div');
    row.className = 'user-item';
    row.innerHTML = `
      <div class="user-main">
        <div class="user-name">${u.name || '(이름 없음)'} <span class="user-email">${u.email}</span>${isBlocked ? '<span class="badge-blocked">차단됨</span>' : ''}</div>
        <div class="user-sub">직책: ${u.position || '-'} · 가입일: ${joined} · 최근 로그인: ${lastLogin}</div>
      </div>
      <div class="user-actions">
        <button type="button" class="btn btn-ghost user-block-btn">${isBlocked ? '차단 해제' : '차단'}</button>
        <button type="button" class="btn btn-ghost user-delete-btn">삭제</button>
      </div>
    `;
    row.querySelector('.user-block-btn').addEventListener('click', () => onUserBlockClick(u, isBlocked));
    row.querySelector('.user-delete-btn').addEventListener('click', () => onUserDeleteClick(u));
    listEl.appendChild(row);
  });
}

async function onUserBlockClick(u, isBlocked) {
  const msg = isBlocked
    ? `"${u.name || u.email}" 계정의 차단을 해제하시겠습니까?`
    : `"${u.name || u.email}" 계정을 차단하시겠습니까?\n다음 로그인 시도부터 거부됩니다.`;
  if (!confirm(msg)) return;

  const endpoint = getEndpoint();
  if (!endpoint) return;

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'setUserStatus', email: u.email, blocked: !isBlocked }),
    });
    toast(isBlocked ? '차단을 해제했습니다.' : '차단 처리했습니다.');
    loadUsers();
  } catch (err) {
    toast('처리 중 오류가 발생했습니다.');
  }
}

async function onUserDeleteClick(u) {
  if (!confirm(`"${u.name || u.email}" 계정을 가입자 목록에서 삭제하시겠습니까?\n이미 제출된 점검 기록은 삭제되지 않습니다.`)) return;

  const endpoint = getEndpoint();
  if (!endpoint) return;

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'deleteUser', email: u.email }),
    });
    toast('삭제했습니다.');
    loadUsers();
  } catch (err) {
    toast('처리 중 오류가 발생했습니다.');
  }
}

/* ---------------- NFC 스캔 ----------------
 * 서버실/장비실처럼 NFC로 확인하는 화면이 여러 개일 수 있어서, 화면별로 다른
 * scanStatus/버튼 id를 쓰더라도 이 함수들을 그대로 재사용할 수 있게 구성했습니다.
 */

const NFC_SCREENS = {
  server: { statusId: 'scanStatus', defaultLabel: '서버실' },
  equipment: { statusId: 'scanStatus2', defaultLabel: '장비실' },
};

async function startNfcScan(screenKey) {
  const cfg = NFC_SCREENS[screenKey];
  const statusEl = qs(cfg.statusId);
  statusEl.className = 'scan-status';
  statusEl.textContent = '';

  if (!('NDEFReader' in window)) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '이 브라우저/기기는 NFC 스캔을 지원하지 않습니다. 안드로이드 기기의 크롬 브라우저에서 열어주세요. 아래 "수동으로 확인"을 이용해주세요.';
    return;
  }

  try {
    statusEl.textContent = '태그를 기다리는 중... 휴대폰 뒷면을 태그에 가까이 대주세요.';
    const ndef = new NDEFReader();
    await ndef.scan();

    const onReading = (event) => {
      ndef.removeEventListener('reading', onReading);
      const serial = event.serialNumber || 'unknown-tag';
      handleTagRead(serial, screenKey);
    };
    ndef.addEventListener('reading', onReading, { once: true });

    ndef.addEventListener('readingerror', () => {
      statusEl.className = 'scan-status error';
      statusEl.textContent = '태그를 읽지 못했습니다. 다시 시도해주세요.';
    });
  } catch (err) {
    statusEl.className = 'scan-status error';
    if (err && err.name === 'NotAllowedError') {
      statusEl.textContent = 'NFC 권한이 거부되었습니다. 브라우저 설정에서 이 사이트의 NFC 권한을 허용해주세요.';
    } else {
      statusEl.textContent = 'NFC를 시작할 수 없습니다: ' + (err && err.message ? err.message : err);
    }
  }
}

function handleTagRead(serial, screenKey) {
  const cfg = NFC_SCREENS[screenKey];
  const statusEl = qs(cfg.statusId);
  const expected = FIXED_NFC_TAGS[screenKey];

  if (!expected || expected.startsWith('여기에_')) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '이 위치의 NFC 태그가 아직 코드에 등록되지 않았습니다. 관리자에게 문의해주세요.';
    return;
  }

  if (serial !== expected) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '이 태그는 ' + cfg.defaultLabel + ' 태그가 아닙니다. 올바른 위치의 태그를 찍어주세요.';
    return;
  }

  statusEl.className = 'scan-status ok';
  statusEl.textContent = '✔ 위치가 확인되었습니다: ' + cfg.defaultLabel;

  openChecklist({ tagId: serial, tagLabel: cfg.defaultLabel, method: 'nfc' });
}

function startManualCheckIn(screenKey) {
  if (!confirm('NFC 없이 수동으로 확인하시겠습니까?\n이 방법은 실제 위치 증빙이 약해집니다. 가능하면 NFC 스캔을 이용해주세요.')) {
    return;
  }
  const cfg = NFC_SCREENS[screenKey];
  openChecklist({ tagId: 'manual', tagLabel: (cfg ? cfg.defaultLabel + ' ' : '') + '수동 확인 (NFC 미사용)', method: 'manual' });
}

function openChecklist(scanInfo) {
  const user = getUser();
  const now = new Date();
  pendingChecklist = {
    ...scanInfo,
    userName: user.name,
    userTeam: user.team,
    userEmail: user.email,
    timestamp: now.toISOString(),
  };

  qs('checklistForm').reset();
  qs('photoPreview').classList.add('hidden');
  qs('submitStatus').textContent = '';
  // re-check equipment boxes to default true after reset
  ['eqAircon', 'eqNoise'].forEach((id) => { qs(id).checked = true; });

  // 선택적으로 GPS 좌표도 같이 시도(실패해도 무시)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { pendingChecklist.lat = pos.coords.latitude; pendingChecklist.lng = pos.coords.longitude; },
      () => {},
      { timeout: 4000 }
    );
  }

  showScreen('screen-checklist');
}

function onPhotoChange(e) {
  const file = e.target.files && e.target.files[0];
  const preview = qs('photoPreview');
  if (!file) { preview.classList.add('hidden'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    preview.src = reader.result;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

/* ---------------- 제출 ---------------- */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function onSubmitChecklist(e) {
  e.preventDefault();
  if (!pendingChecklist) { toast('스캔 정보가 없습니다. 처음부터 다시 해주세요.'); return; }

  const submitBtn = qs('submitBtn');
  const statusEl = qs('submitStatus');
  submitBtn.disabled = true;
  statusEl.className = 'scan-status';
  statusEl.textContent = '제출 중...';

  const temp = qs('fTemp').value;
  if (temp === '') {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '온도를 입력해주세요.';
    submitBtn.disabled = false;
    return;
  }

  const photoFile = qs('fPhoto').files && qs('fPhoto').files[0];
  let photoBase64 = '';
  let photoName = '';
  if (photoFile) {
    try {
      photoBase64 = await fileToBase64(photoFile);
      photoName = photoFile.name;
    } catch (err) { /* 사진 변환 실패해도 제출은 진행 */ }
  }

  const record = {
    ...pendingChecklist,
    temperature: parseFloat(temp),
    equipment: {
      aircon: qs('eqAircon').checked,
      noiseOk: qs('eqNoise').checked,
    },
    note: qs('fNote').value.trim(),
    photoBase64,
    photoName,
    submittedAt: new Date().toISOString(),
    clientId: 'srv-checklist-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  };

  const ok = await sendRecord(record);
  submitBtn.disabled = false;

  if (ok) {
    statusEl.className = 'scan-status ok';
    pendingChecklist = null;
    showScreen('screen-done');
  } else {
    queuePending(record);
    statusEl.className = 'scan-status';
    statusEl.textContent = '온라인 저장에 실패해 기기에 임시 저장했습니다. 온라인이 되면 자동으로 전송됩니다.';
    pendingChecklist = null;
    setTimeout(() => showScreen('screen-done'), 1400);
  }
}

async function sendRecord(record) {
  const endpoint = getEndpoint();
  if (!endpoint) return false;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script와의 CORS 단순 요청 호환을 위해 text/plain 사용
      body: JSON.stringify({ action: 'submit', record }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({ ok: true }));
    return data.ok !== false;
  } catch (err) {
    return false;
  }
}

function queuePending(record) {
  const list = loadJSON(LS.pending, []);
  list.push(record);
  saveJSON(LS.pending, list);
}

async function flushPending() {
  const list = loadJSON(LS.pending, []);
  if (!list.length) return;
  if (!navigator.onLine) return;
  const remaining = [];
  for (const rec of list) {
    const ok = await sendRecord(rec);
    if (!ok) remaining.push(rec);
  }
  saveJSON(LS.pending, remaining);
  if (remaining.length !== list.length) {
    toast(`밀렸던 기록 ${list.length - remaining.length}건이 전송되었습니다.`);
    loadHistory();
  }
}

/* ---------------- 최근 기록 ---------------- */

async function loadHistory() {
  const endpoint = getEndpoint();
  const pending = loadJSON(LS.pending, []);

  if (!endpoint) {
    const msg = '<p class="muted small">설정에서 서버 저장 주소를 입력하면 최근 기록을 볼 수 있습니다.</p>';
    qs('historyPcBody').innerHTML = msg;
    qs('historyMobileBody').innerHTML = msg;
    renderPendingBadge(pending);
    return;
  }

  try {
    // 날짜별로 묶어서 보여주다 보니 하루당 기록이 있는지 판단하려면 예전보다 더 넉넉히 받아둡니다.
    const res = await fetch(endpoint + (endpoint.includes('?') ? '&' : '?') + 'action=list&limit=40');
    const data = await res.json();
    const records = (data && data.records) || [];
    saveJSON(LS.historyCache, records);
    renderHistory(records, pending);
  } catch (err) {
    const cached = loadJSON(LS.historyCache, []);
    renderHistory(cached, pending, true);
  }
}

function renderPendingBadge(pending) {
  if (pending.length) {
    const msg = `<p class="muted small">기기에 대기 중인 기록 ${pending.length}건 (온라인이 되면 자동 전송)</p>`;
    qs('historyPcBody').innerHTML += msg;
    qs('historyMobileBody').innerHTML += msg;
  }
}

// 홈 화면 "최근 점검 기록" 미리보기 설정: 오늘 + 주말을 뺀 평일 며칠치를 보여줄지,
// 하루에 몇 건까지는 그냥 다 보여주고 그 이상이면 "더보기"로 접어둘지.
const HOME_PREVIEW_DAYS = 5;
const HOME_GROUP_LIMIT = 3;

// 오늘(요일 상관없이 항상 포함) + 주말을 건너뛴 과거 평일들을, 최신순으로 count개 돌려줍니다.
function homePreviewDates(count) {
  const days = [];
  const today = new Date();
  days.push(new Date(today));
  const cursor = new Date(today);
  while (days.length < count) {
    cursor.setDate(cursor.getDate() - 1);
    const dow = cursor.getDay(); // 0=일, 6=토
    if (dow !== 0 && dow !== 6) {
      days.push(new Date(cursor));
    }
  }
  return days;
}

function dateKeyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 홈 화면 "최근 점검 기록"은 PC와 모바일이 서로 다른 방식으로 보여줍니다.
// - PC(historyPcBody): 카드 안에서 날짜별로 가로 그리드, 3건 넘으면 더보기/접기
// - 모바일(historyMobileBody): 상자 밖 제목 + 날짜별로 독립된 버튼, 눌러야 그 날짜 기록이 펼쳐짐
// 화면 폭에 따라 둘 중 하나만 CSS로 보이게 하고(.records-card / .mobile-history),
// 데이터는 같은 records 배열로 둘 다 채워둡니다.
function renderHistory(records, pending, offline) {
  const pcBody = qs('historyPcBody');
  const mobileBody = qs('historyMobileBody');
  pcBody.innerHTML = '';
  mobileBody.innerHTML = '';

  if (offline) {
    [pcBody, mobileBody].forEach((wrap) => {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = '네트워크 연결이 안 되어 마지막으로 불러온 기록을 표시합니다.';
      wrap.appendChild(p);
    });
  }

  const todayKey = dateKeyOf(new Date());
  const days = homePreviewDates(HOME_PREVIEW_DAYS);

  days.forEach((d) => {
    const key = dateKeyOf(d);
    const isToday = key === todayKey;
    const dayRecords = records.filter((r) => recordDateKey(r) === key);
    const labelText = `${isToday ? '오늘 · ' : ''}${formatDateLabel(key)}`;

    /* ---- PC: 날짜 라벨 + 가로 그리드 (3건 넘으면 더보기/접기) ---- */
    const pcLabel = document.createElement('div');
    pcLabel.className = 'section-label' + (isToday ? ' today' : '');
    pcLabel.innerHTML = `${labelText} <span class="count">${dayRecords.length}건</span>`;
    pcBody.appendChild(pcLabel);

    const pcGroup = document.createElement('div');
    pcGroup.className = 'date-records';

    if (!dayRecords.length) {
      const empty = document.createElement('div');
      empty.className = 'record-item empty';
      empty.textContent = '점검 기록 없음';
      pcGroup.appendChild(empty);
    } else {
      const groupId = 'home-' + key;
      dayRecords.forEach((r, idx) => {
        const item = buildRecordItem(r);
        if (idx >= HOME_GROUP_LIMIT) {
          item.classList.add('hidden-extra');
          item.dataset.group = groupId;
        }
        pcGroup.appendChild(item);
      });

      if (dayRecords.length > HOME_GROUP_LIMIT) {
        const extraCount = dayRecords.length - HOME_GROUP_LIMIT;
        const moreTile = document.createElement('div');
        moreTile.className = 'more-tile';
        moreTile.dataset.group = groupId;
        moreTile.innerHTML = `<span class="more-label">더보기 (${extraCount}건 더)</span><span class="chev">⌄</span>`;
        moreTile.addEventListener('click', () => toggleHomeGroup(groupId, extraCount));
        pcGroup.appendChild(moreTile);
      }
    }
    pcBody.appendChild(pcGroup);

    /* ---- 모바일: 날짜별로 독립된 버튼(카드) — 누르면 그 아래로 전부 펼쳐짐 ---- */
    const dateCard = document.createElement('div');
    dateCard.className = 'date-card' + (dayRecords.length ? '' : ' empty');

    if (!dayRecords.length) {
      const row = document.createElement('div');
      row.className = 'date-btn' + (isToday ? ' today' : '');
      row.innerHTML = `<span>${labelText}</span><span class="count">0건</span>`;
      dateCard.appendChild(row);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'date-btn' + (isToday ? ' today' : '');
      btn.innerHTML = `<span>${labelText}</span><span class="date-row-right"><span class="count">${dayRecords.length}건</span><span class="chev">›</span></span>`;

      const body = document.createElement('div');
      body.className = 'date-body hidden';
      dayRecords.forEach((r) => body.appendChild(buildRecordItem(r)));

      btn.addEventListener('click', () => {
        const opening = body.classList.contains('hidden');
        body.classList.toggle('hidden', !opening);
        dateCard.classList.toggle('open', opening);
      });

      dateCard.appendChild(btn);
      dateCard.appendChild(body);
    }
    mobileBody.appendChild(dateCard);
  });

  if (!records.length && !pending.length) {
    [pcBody, mobileBody].forEach((wrap) => {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = '아직 점검 기록이 없습니다.';
      wrap.appendChild(p);
    });
  }

  if (pending.length) {
    renderPendingBadge(pending);
  }
}

// 날짜별로 3건 넘게 있을 때 나타나는 "더보기"를 누르면 나머지를 펼치고,
// 다시 누르면(이제 "접기") 접습니다. 펼쳐지면 타일이 그 날짜 줄의 맨 끝(오른쪽)으로 이동합니다.
function toggleHomeGroup(groupId, extraCount) {
  const tile = document.querySelector(`.more-tile[data-group="${groupId}"]`);
  if (!tile) return;
  // 처음 펼칠 때 이 요소들에서 hidden-extra 클래스를 떼어내므로, 다시 접을 때 찾으려면
  // (.hidden-extra가 이미 없는 상태이니) hidden-extra 유무와 상관없이 data-group으로만 찾아야 합니다.
  // 이전에는 ".record-item.hidden-extra[data-group=...]"로 찾아서, 펼친 뒤 두 번째 클릭(접기)
  // 때는 조건에 안 맞아 아무것도 못 찾는 버그가 있었습니다.
  const extras = document.querySelectorAll(`.record-item[data-group="${groupId}"]`);
  const expanding = !tile.classList.contains('expanded');
  tile.classList.toggle('expanded', expanding);
  extras.forEach((el) => el.classList.toggle('hidden-extra', !expanding));
  tile.querySelector('.more-label').textContent = expanding ? '접기' : `더보기 (${extraCount}건 더)`;
}

/* ---------------- 전체 기록 화면 ----------------
 * 홈 화면의 "최근 점검 기록"은 15개만 미리보기로 보여주는 반면, 여기서는 "더 보기"를
 * 눌러 계속 이어서 불러올 수 있고, 장소/날짜/이상유무/NFC 여부로 걸러볼 수 있습니다.
 * 필터는 지금까지 불러온 기록(recordsState.items) 안에서만 적용됩니다 — 더 보기를 눌러
 * 기록을 더 불러올수록 필터가 적용되는 범위도 함께 넓어집니다.
 */

let recordsState = { items: [], offset: 0, hasMore: true, filter: 'all', place: '', date: '' };
let calState = null; // PC(달력형 전체기록)에서만 초기화됩니다. 모바일 폭에서는 null로 유지.

function openRecords() {
  recordsState = { items: [], offset: 0, hasMore: true, filter: 'all', place: '', date: '' };
  calState = null;
  qs('recPlaceFilter').innerHTML = '<option value="">장소 전체</option>';
  qs('recDateFilter').value = '';
  document.querySelectorAll('#screen-records .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
  qs('recordsList').innerHTML = '<p class="muted small">불러오는 중...</p>';
  qs('recordsMoreBtn').classList.add('hidden');
  showScreen('screen-records');
  loadMoreRecords();
  initCalendarIfNeeded();
}

async function loadMoreRecords() {
  const endpoint = getEndpoint();
  if (!endpoint) {
    qs('recordsList').innerHTML = '<p class="muted small">설정에서 서버 저장 주소를 입력하면 기록을 볼 수 있습니다.</p>';
    qs('recordsMoreBtn').classList.add('hidden');
    return;
  }

  const moreBtn = qs('recordsMoreBtn');
  const alreadyHadItems = recordsState.items.length > 0;
  moreBtn.disabled = true;
  moreBtn.textContent = '불러오는 중...';

  try {
    const url = endpoint + (endpoint.includes('?') ? '&' : '?') +
      'action=list&limit=20&offset=' + recordsState.offset;
    const res = await fetch(url);
    const data = await res.json();
    const newRecords = (data && data.records) || [];

    recordsState.items = recordsState.items.concat(newRecords);
    recordsState.offset += newRecords.length;
    recordsState.hasMore = !!(data && data.hasMore) && newRecords.length > 0;

    refreshPlaceFilterOptions();
    renderRecordsList();
  } catch (err) {
    if (!alreadyHadItems) {
      qs('recordsList').innerHTML = '<p class="muted small">기록을 불러오지 못했습니다. 네트워크를 확인해주세요.</p>';
    } else {
      toast('추가 기록을 불러오지 못했습니다.');
    }
  } finally {
    moreBtn.disabled = false;
    moreBtn.textContent = '더 보기';
  }
}

function updatePlaceFilterOptions(items) {
  const select = qs('recPlaceFilter');
  const current = select.value;
  const places = Array.from(new Set(items.map((r) => r.tagLabel).filter(Boolean)));
  select.innerHTML = '<option value="">장소 전체</option>' +
    places.map((p) => `<option value="${p}">${p}</option>`).join('');
  select.value = places.includes(current) ? current : '';
}

// 모바일 리스트(recordsState.items)와 PC 달력(calState.records)이 서로 다른 배치로
// 기록을 불러오다 보니, 장소 필터 옵션은 둘을 합쳐서 만들어야 어느 화면 폭에서든
// 빠짐없이 나타납니다.
function refreshPlaceFilterOptions() {
  const merged = recordsState.items.concat(calState ? calState.records : []);
  updatePlaceFilterOptions(merged);
}

function recordDateKey(r) {
  if (!r.timestamp) return '';
  const d = new Date(r.timestamp);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
function formatDateLabel(dateKey) {
  const parts = dateKey.split('-').map(Number);
  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
  return `${parts[1]}월 ${parts[2]}일 (${WEEKDAY_KO[dt.getDay()]})`;
}

function recordHasAnomaly(r) {
  return !!(r.note || (r.equipment && Object.values(r.equipment).some((v) => v === false)));
}

function recordMatchesFilters(r) {
  if (recordsState.place && r.tagLabel !== recordsState.place) return false;
  if (recordsState.date && recordDateKey(r) !== recordsState.date) return false;
  if (recordsState.filter === 'nfc' && r.method !== 'nfc') return false;
  if (recordsState.filter === 'anomaly' && !recordHasAnomaly(r)) return false;
  return true;
}

function renderRecordsList() {
  const wrap = qs('recordsList');
  const filtered = recordsState.items.filter(recordMatchesFilters);
  wrap.innerHTML = '';

  if (!filtered.length) {
    wrap.innerHTML = '<p class="muted small">조건에 맞는 기록이 없습니다.</p>';
  } else {
    let lastDateKey = null;
    filtered.forEach((r) => {
      const dateKey = recordDateKey(r);
      if (dateKey !== lastDateKey) {
        const label = document.createElement('div');
        label.className = 'section-label';
        label.textContent = dateKey ? formatDateLabel(dateKey) : '날짜 미상';
        wrap.appendChild(label);
        lastDateKey = dateKey;
      }
      wrap.appendChild(buildRecordItem(r));
    });
  }

  qs('recordsMoreBtn').classList.toggle('hidden', !recordsState.hasMore);
}

/* ---------------- 전체 기록: 웹(PC) 전용 달력형 ----------------
 * 모바일 리스트(recordsState)와는 별개로, 달력은 최근 기록을 최대 200건씩 통째로
 * 받아와(action=list&limit=200) 클라이언트에서 날짜별로 묶어 보여줍니다. 더 오래된
 * 달로 이동했는데 그 기록이 아직 안 불러와졌으면 "이전 기록 더 불러오기" 버튼으로
 * 다음 200건을 이어서 받아옵니다. 장소/이상만/NFC 필터는 모바일 리스트와 같은
 * recordsState를 그대로 공유해서 씁니다(recordMatchesFilters 재사용).
 */
function isPcRecordsView() {
  return window.matchMedia('(min-width:860px)').matches;
}

function initCalendarIfNeeded() {
  if (!isPcRecordsView()) return;
  const today = new Date();
  calState = {
    records: [],
    offset: 0,
    hasMore: true,
    monthDate: new Date(today.getFullYear(), today.getMonth(), 1),
    selectedKey: dateKeyOf(today),
  };
  loadCalendarBatch(true);
}

async function loadCalendarBatch(isFirst) {
  if (!calState) return;
  const endpoint = getEndpoint();
  const loadMoreBtn = qs('calLoadMoreBtn');

  if (!endpoint) {
    qs('calGrid').innerHTML = '<p class="muted small">설정에서 서버 저장 주소를 입력하면 기록을 볼 수 있습니다.</p>';
    return;
  }

  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = '불러오는 중...';

  try {
    const url = endpoint + (endpoint.includes('?') ? '&' : '?') +
      'action=list&limit=200&offset=' + calState.offset;
    const res = await fetch(url);
    const data = await res.json();
    const newRecords = (data && data.records) || [];

    calState.records = calState.records.concat(newRecords);
    calState.offset += newRecords.length;
    calState.hasMore = !!(data && data.hasMore) && newRecords.length > 0;

    refreshPlaceFilterOptions();
    renderCalendarMonth();
  } catch (err) {
    if (isFirst) {
      qs('calGrid').innerHTML = '<p class="muted small">기록을 불러오지 못했습니다. 네트워크를 확인해주세요.</p>';
    } else {
      toast('추가 기록을 불러오지 못했습니다.');
    }
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = '이전 기록 더 불러오기';
  }
}

function renderCalendarMonth() {
  if (!calState) return;
  const y = calState.monthDate.getFullYear();
  const m = calState.monthDate.getMonth();
  qs('calMonthLabel').textContent = `${y}년 ${m + 1}월`;

  const filtered = calState.records.filter(recordMatchesFilters);
  const byDate = {};
  filtered.forEach((r) => {
    const key = recordDateKey(r);
    if (!key) return;
    (byDate[key] = byDate[key] || []).push(r);
  });

  const firstOfMonth = new Date(y, m, 1);
  const startWeekday = firstOfMonth.getDay(); // 0=일요일
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDaysInMonth = new Date(y, m, 0).getDate();
  const todayKey = dateKeyOf(new Date());

  const grid = qs('calGrid');
  grid.innerHTML = '';

  // 이번 달 1일 앞의 빈칸은 지난 달 마지막 며칠로 채우되, 클릭은 안 되게 합니다.
  for (let i = 0; i < startWeekday; i++) {
    grid.appendChild(buildCalCell(prevDaysInMonth - startWeekday + 1 + i, null, true, [], false));
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    grid.appendChild(buildCalCell(d, key, false, byDate[key] || [], key === todayKey));
  }

  const totalCells = startWeekday + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    grid.appendChild(buildCalCell(i, null, true, [], false));
  }

  qs('calLoadMoreBtn').classList.toggle('hidden', !calState.hasMore);
  renderDayDetail(calState.selectedKey, byDate[calState.selectedKey] || []);
}

function buildCalCell(dayNum, key, isMuted, records, isToday) {
  const cell = document.createElement('div');
  const hasAnomaly = records.some(recordHasAnomaly);
  const isSelected = !isMuted && key === (calState && calState.selectedKey);
  cell.className = 'cal-cell'
    + (isMuted ? ' muted-cell empty' : (records.length ? '' : ' empty'))
    + (isToday ? ' today' : '')
    + (hasAnomaly ? ' has-anomaly' : '')
    + (isSelected ? ' selected' : '');

  const numEl = document.createElement('span');
  numEl.className = 'd-num';
  numEl.textContent = dayNum;
  cell.appendChild(numEl);

  if (hasAnomaly && !isMuted) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = '⚠';
    cell.appendChild(warn);
  }

  if (!isMuted && records.length) {
    const countEl = document.createElement('span');
    countEl.className = 'd-count';
    countEl.textContent = records.length + '건';
    cell.appendChild(countEl);
  }

  if (!isMuted) {
    cell.addEventListener('click', () => {
      calState.selectedKey = key;
      renderCalendarMonth();
    });
  }
  return cell;
}

function renderDayDetail(dateKey, records) {
  const titleEl = qs('dayCardTitle');
  const subEl = qs('dayCardSub');
  const listEl = qs('dayCardList');
  listEl.innerHTML = '';

  if (!dateKey) {
    titleEl.textContent = '날짜를 선택해주세요';
    subEl.textContent = '';
    return;
  }

  titleEl.textContent = formatDateLabel(dateKey);
  const anomalyCount = records.filter(recordHasAnomaly).length;
  subEl.textContent = `총 ${records.length}건 · 이상 ${anomalyCount}건`;

  if (!records.length) {
    listEl.innerHTML = '<p class="muted small">이 날짜에는 점검 기록이 없습니다.</p>';
    return;
  }

  records
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .forEach((r) => listEl.appendChild(buildRecordItem(r)));
}

function buildRecordItem(r) {
  const hasAnomaly = recordHasAnomaly(r);
  const item = document.createElement('div');
  item.className = 'record-item' + (hasAnomaly ? ' anomaly' : '');
  const time = r.timestamp ? formatDateTime(new Date(r.timestamp)).slice(11) : '';
  const methodBadge = r.method === 'nfc'
    ? '<span class="badge badge-nfc">NFC</span>'
    : '<span class="badge badge-manual">수동</span>';
  const anomalyBadge = hasAnomaly ? '<span class="badge badge-anomaly">⚠ 이상 있음</span>' : '';
  item.innerHTML = `
    <div class="record-top">
      <div class="record-main">${r.userName || '이름없음'} · ${r.tagLabel || ''}</div>
      <div class="record-temp">${r.temperature != null ? r.temperature + '°C' : ''}</div>
    </div>
    <div class="record-sub">
      <span>${time}</span>
      ${methodBadge}
      ${anomalyBadge}
    </div>
  `;
  return item;
}

document.addEventListener('DOMContentLoaded', init);
