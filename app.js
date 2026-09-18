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
  endpoint: 'src_endpoint',
  tags: 'src_tags',
  pending: 'src_pending',
  historyCache: 'src_history_cache',
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
  return localStorage.getItem(LS.endpoint) || '';
}
function getUser() {
  return {
    name: localStorage.getItem(LS.name) || '',
    team: localStorage.getItem(LS.team) || '',
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

function init() {
  registerServiceWorker();
  updateOnlineDot();
  window.addEventListener('online', () => { updateOnlineDot(); flushPending(); });
  window.addEventListener('offline', updateOnlineDot);

  const user = getUser();
  if (!user.name) {
    showScreen('screen-onboard');
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
  qs('clearTagsBtn').addEventListener('click', () => {
    if (confirm('등록된 NFC 태그를 모두 초기화할까요? 다음 스캔 시 다시 등록해야 합니다.')) {
      saveTags([]);
      renderTagList();
      toast('태그 목록을 초기화했습니다.');
    }
  });
  qs('scanBtn').addEventListener('click', startNfcScan);
  qs('manualBtn').addEventListener('click', startManualCheckIn);
  qs('refreshBtn').addEventListener('click', loadHistory);
  qs('cancelBtn').addEventListener('click', () => showScreen('screen-home'));
  qs('doneHomeBtn').addEventListener('click', () => { showScreen('screen-home'); loadHistory(); });
  qs('checklistForm').addEventListener('submit', onSubmitChecklist);
  qs('fPhoto').addEventListener('change', onPhotoChange);
}

function onOnboardSave() {
  const name = qs('onboardName').value.trim();
  if (!name) { toast('이름을 입력해주세요.'); return; }
  localStorage.setItem(LS.name, name);
  localStorage.setItem(LS.team, qs('onboardTeam').value.trim());
  init();
}

function openSettings() {
  const user = getUser();
  qs('setName').value = user.name;
  qs('setTeam').value = user.team;
  qs('setEndpoint').value = getEndpoint();
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
  const name = qs('setName').value.trim();
  if (!name) { toast('이름을 입력해주세요.'); return; }
  localStorage.setItem(LS.name, name);
  localStorage.setItem(LS.team, qs('setTeam').value.trim());
  localStorage.setItem(LS.endpoint, qs('setEndpoint').value.trim());
  qs('homeUserName').textContent = name + (qs('setTeam').value.trim() ? ` · ${qs('setTeam').value.trim()}` : '');
  toast('저장되었습니다.');
  showScreen('screen-home');
  loadHistory();
}

/* ---------------- NFC 스캔 ---------------- */

async function startNfcScan() {
  const statusEl = qs('scanStatus');
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
      handleTagRead(serial);
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

function handleTagRead(serial) {
  const statusEl = qs('scanStatus');
  const tags = getTags();
  let tag = tags.find((t) => t.id === serial);

  if (!tag) {
    const label = prompt('처음 인식된 태그입니다. 이 위치의 이름을 입력해주세요 (예: 본관 서버실 입구)', '서버실');
    if (label === null) {
      statusEl.className = 'scan-status';
      statusEl.textContent = '등록이 취소되었습니다.';
      return;
    }
    tag = { id: serial, label: label.trim() || '서버실', createdAt: Date.now() };
    tags.push(tag);
    saveTags(tags);
    toast('새 태그가 등록되었습니다: ' + tag.label);
  }

  statusEl.className = 'scan-status ok';
  statusEl.textContent = '✔ 위치가 확인되었습니다: ' + tag.label;

  openChecklist({ tagId: tag.id, tagLabel: tag.label, method: 'nfc' });
}

function startManualCheckIn() {
  if (!confirm('NFC 없이 수동으로 확인하시겠습니까?\n이 방법은 실제 위치 증빙이 약해집니다. 가능하면 NFC 스캔을 이용해주세요.')) {
    return;
  }
  openChecklist({ tagId: 'manual', tagLabel: '수동 확인 (NFC 미사용)', method: 'manual' });
}

function openChecklist(scanInfo) {
  const user = getUser();
  const now = new Date();
  pendingChecklist = {
    ...scanInfo,
    userName: user.name,
    userTeam: user.team,
    timestamp: now.toISOString(),
  };

  qs('ckUser').textContent = user.name + (user.team ? ` (${user.team})` : '');
  qs('ckTime').textContent = formatDateTime(now);
  qs('ckTag').textContent = scanInfo.tagLabel;

  qs('checklistForm').reset();
  qs('photoPreview').classList.add('hidden');
  qs('submitStatus').textContent = '';
  // re-check equipment boxes to default true after reset
  ['eqUps', 'eqAircon', 'eqFire', 'eqNoise', 'eqDoor'].forEach((id) => { qs(id).checked = true; });

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
    humidity: qs('fHumidity').value === '' ? null : parseFloat(qs('fHumidity').value),
    equipment: {
      ups: qs('eqUps').checked,
      aircon: qs('eqAircon').checked,
      fire: qs('eqFire').checked,
      noiseOk: qs('eqNoise').checked,
      door: qs('eqDoor').checked,
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
