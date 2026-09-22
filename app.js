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
  tags: 'src_tags',
  pending: 'src_pending',
  historyCache: 'src_history_cache',
};

// 관리자용: 여기에 배포한 Apps Script 웹앱 주소를 미리 채워두면, 사용자가 설정에서
// 따로 입력하지 않아도 자동으로 이 주소를 씁니다. 비워두면(빈 문자열) 기존처럼
// 각자 기기의 설정 화면에서 입력해야 합니다.
const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzpXMmpLUMaGom-CtWO7jvj-H9Cxx2B58MyDwZL3q_7ru4o7VprSueVd9F-vYq3eP6P/exec';

// Google 로그인 설정: 학교 이메일(@ync.ac.kr) 계정만 로그인을 허용합니다.
// Google Cloud Console에서 만든 OAuth 클라이언트(웹 애플리케이션)의 "클라이언트 ID"를
// 아래에 붙여넣으세요. (예: 1234567890-abcxyz.apps.googleusercontent.com)
const GOOGLE_CLIENT_ID = '904845440598-a9sul7p4reug9rcre031im6e0mjdunce.apps.googleusercontent.com';

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
function getTags() {
  return loadJSON(LS.tags, []); // [{id, label, createdAt}]
}
function saveTags(tags) {
  saveJSON(LS.tags, tags);
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  qs(id).classList.remove('hidden');
}

let toastTimer = null;
function toast(msg) {
  const el = qs('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ---------------- 초기화 ---------------- */

let pendingChecklist = null; // 스캔 확인 후 checklist 화면에 넘길 정보
let pendingGoogleUser = null; // Google 로그인 확인 후, 직책 입력 전까지 임시로 들고 있는 사용자 정보

function init() {
  registerServiceWorker();
  updateOnlineDot();
  window.addEventListener('online', () => { updateOnlineDot(); flushPending(); });
  window.addEventListener('offline', updateOnlineDot);

  const user = getUser();
  if (!user.name || !user.email) {
    showScreen('screen-onboard');
    startGoogleSignIn();
  } else {
    showScreen('screen-home');
    qs('homeUserName').textContent = user.name + (user.team ? ` · ${user.team}` : '');
    startClock();
    loadHistory();
    flushPending();
  }

  bindEvents();
}

function updateOnlineDot() {
  const dot = qs('statusDot');
  if (navigator.onLine) dot.classList.remove('offline');
  else dot.classList.add('offline');
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
  qs('onboardSaveBtn').addEventListener('click', onOnboardSave);
  qs('settingsBtn').addEventListener('click', openSettings);
  qs('setBackBtn').addEventListener('click', () => showScreen('screen-home'));
  qs('setSaveBtn').addEventListener('click', onSettingsSave);
  qs('setLogoutBtn').addEventListener('click', onLogout);
  qs('clearTagsBtn').addEventListener('click', () => {
    if (confirm('등록된 NFC 태그를 모두 초기화할까요? 다음 스캔 시 다시 등록해야 합니다.')) {
      saveTags([]);
      renderTagList();
      toast('태그 목록을 초기화했습니다.');
    }
  });
  qs('menuBtn').addEventListener('click', openDrawer);
  qs('drawerOverlay').addEventListener('click', closeDrawer);
  qs('drawerHome').addEventListener('click', () => { closeDrawer(); showScreen('screen-home'); loadHistory(); });
  qs('drawerServerRoom').addEventListener('click', () => { closeDrawer(); showScreen('screen-server'); });
  qs('drawerEquipRoom').addEventListener('click', () => { closeDrawer(); showScreen('screen-equipment'); });
  qs('drawerSettings').addEventListener('click', () => { closeDrawer(); openSettings(); });
  qs('drawerRoomsToggle').addEventListener('click', toggleRoomsSubmenu);
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
  qs('refreshBtn').addEventListener('click', loadHistory);
  qs('cancelBtn').addEventListener('click', () => showScreen('screen-home'));
  qs('doneHomeBtn').addEventListener('click', () => { showScreen('screen-home'); loadHistory(); });
  qs('checklistForm').addEventListener('submit', onSubmitChecklist);
  qs('fPhoto').addEventListener('change', onPhotoChange);
}

function onOnboardSave() {
  if (!pendingGoogleUser) {
    toast('로그인 정보가 없습니다. 처음부터 다시 진행해주세요.');
    showScreen('screen-onboard');
    startGoogleSignIn();
    return;
  }
  localStorage.setItem(LS.name, pendingGoogleUser.name);
  localStorage.setItem(LS.email, pendingGoogleUser.email);
  localStorage.setItem(LS.team, qs('onboardTeam').value.trim());
  pendingGoogleUser = null;
  init();
}

function onLogout() {
  if (!confirm('로그아웃하고 다른 Google 계정으로 로그인하시겠습니까?\n이 기기에 저장된 이름/직책 정보가 지워집니다.')) return;
  localStorage.removeItem(LS.name);
  localStorage.removeItem(LS.email);
  localStorage.removeItem(LS.team);
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
    });
    window.__gsiInited = true;
  }
  qs('gsiButtonContainer').innerHTML = '';
  google.accounts.id.renderButton(qs('gsiButtonContainer'), {
    theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ko', width: 280,
  });
}

async function handleGoogleCredential(response) {
  const statusEl = qs('onboardLoginStatus');
  statusEl.className = 'scan-status';
  statusEl.textContent = '로그인 확인 중...';

  const endpoint = getEndpoint();
  if (!endpoint) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '서버 주소가 설정되지 않아 로그인을 확인할 수 없습니다.';
    return;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', idToken: response.credential }),
    });
    const data = await res.json();

    if (!data.ok) {
      statusEl.className = 'scan-status error';
      statusEl.textContent = data.error === 'domain_not_allowed'
        ? '학교 이메일(@ync.ac.kr) 계정으로만 로그인할 수 있습니다. 다른 계정으로 다시 시도해주세요.'
        : '로그인 확인에 실패했습니다. 다시 시도해주세요.';
      return;
    }

    pendingGoogleUser = { name: data.name, email: data.email };
    qs('onboardConfirmedName').textContent = data.name;
    qs('onboardConfirmedEmail').textContent = data.email;
    qs('onboardStep1').classList.add('hidden');
    qs('onboardStep2').classList.remove('hidden');
  } catch (err) {
    statusEl.className = 'scan-status error';
    statusEl.textContent = '네트워크 오류로 로그인 확인에 실패했습니다. 다시 시도해주세요.';
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
  qs('setTeam').value = user.team;
  renderTagList();
  showScreen('screen-settings');
}

function renderTagList() {
  const tags = getTags();
  const wrap = qs('tagList');
  wrap.innerHTML = '';
  if (!tags.length) {
    wrap.innerHTML = '<p class="muted small">등록된 태그가 없습니다. 서버실에서 NFC 스캔을 한 번 하면 자동으로 등록할 수 있습니다.</p>';
    return;
  }
  tags.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'tag-chip';
    row.innerHTML = `<span>${t.label} (${t.id})</span>`;
    const btn = document.createElement('button');
    btn.textContent = '삭제';
    btn.addEventListener('click', () => {
      saveTags(getTags().filter((x) => x.id !== t.id));
      renderTagList();
    });
    row.appendChild(btn);
    wrap.appendChild(row);
  });
}

function onSettingsSave() {
  const team = qs('setTeam').value.trim();
  localStorage.setItem(LS.team, team);
  const user = getUser();
  qs('homeUserName').textContent = user.name + (team ? ` · ${team}` : '');
  toast('저장되었습니다.');
  showScreen('screen-home');
  loadHistory();
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
  const tags = getTags();
  let tag = tags.find((t) => t.id === serial);

  if (!tag) {
    const label = prompt('처음 인식된 태그입니다. 이 위치의 이름을 입력해주세요 (예: 본관 서버실 입구)', cfg.defaultLabel);
    if (label === null) {
      statusEl.className = 'scan-status';
      statusEl.textContent = '등록이 취소되었습니다.';
      return;
    }
    tag = { id: serial, label: label.trim() || cfg.defaultLabel, createdAt: Date.now() };
    tags.push(tag);
    saveTags(tags);
    toast('새 태그가 등록되었습니다: ' + tag.label);
  }

  statusEl.className = 'scan-status ok';
  statusEl.textContent = '✔ 위치가 확인되었습니다: ' + tag.label;

  openChecklist({ tagId: tag.id, tagLabel: tag.label, method: 'nfc' });
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
  const wrap = qs('historyList');
  const endpoint = getEndpoint();
  const pending = loadJSON(LS.pending, []);

  if (!endpoint) {
    wrap.innerHTML = '<p class="muted small">설정에서 서버 저장 주소를 입력하면 최근 기록을 볼 수 있습니다.</p>';
    renderPendingBadge(pending);
    return;
  }

  try {
    const res = await fetch(endpoint + (endpoint.includes('?') ? '&' : '?') + 'action=list&limit=15');
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
    qs('historyList').innerHTML += `<p class="muted small">기기에 대기 중인 기록 ${pending.length}건 (온라인이 되면 자동 전송)</p>`;
  }
}

function renderHistory(records, pending, offline) {
  const wrap = qs('historyList');
  wrap.innerHTML = '';

  if (offline) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '네트워크 연결이 안 되어 마지막으로 불러온 기록을 표시합니다.';
    wrap.appendChild(p);
  }

  if (!records.length && !pending.length) {
    wrap.innerHTML += '<p class="muted small">아직 점검 기록이 없습니다.</p>';
    return;
  }

  records.slice(0, 15).forEach((r) => {
    const item = document.createElement('div');
    const hasAnomaly = r.note || (r.equipment && Object.values(r.equipment).some((v) => v === false));
    item.className = 'history-item' + (hasAnomaly ? ' anomaly' : '');
    const t = r.timestamp ? formatDateTime(new Date(r.timestamp)) : '';
    item.innerHTML = `
      <div>
        <div class="hi-main">${r.userName || '이름없음'} · ${r.tagLabel || ''}</div>
        <div class="hi-sub">${t}${hasAnomaly ? ' · ⚠ 이상 있음' : ''}</div>
      </div>
      <div class="hi-temp">${r.temperature != null ? r.temperature + '°C' : ''}</div>
    `;
    wrap.appendChild(item);
  });

  if (pending.length) {
    renderPendingBadge(pending);
  }
}

document.addEventListener('DOMContentLoaded', init);
