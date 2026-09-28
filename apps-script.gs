/**
 * 서버실 점검 체크리스트 - Google Apps Script 백엔드
 *
 * 사용법:
 * 1. script.google.com 에서 새 프로젝트를 만들고 이 파일 내용을 Code.gs 에 붙여넣습니다.
 * 2. 아래 SHEET_ID 를 본인의 구글 시트 ID로 바꿉니다. (시트가 없으면 새로 만들고 ID를 복사)
 *    - 구글 시트 URL 중 https://docs.google.com/spreadsheets/d/[여기부분]/edit 의 [여기부분]
 * 3. (선택) SHARED_SECRET 값을 임의의 문자열로 바꾸면, 이 값을 아는 사람/기기만 기록을 볼 수 있습니다.
 *    비워두면(빈 문자열) 인증 없이 누구나 웹앱 URL로 읽고 쓸 수 있으니, 내부망 전용으로만 쓰거나
 *    URL을 외부에 노출하지 마세요.
 * 4. 상단 메뉴 배포 > 새 배포 > 유형: 웹앱
 *    - 실행 계정: 나(작성자)
 *    - 액세스 권한: 전체(Anyone) 또는 조직 내 전체(Google Workspace 도메인 보유 시 권장)
 *    - 배포 후 나오는 웹앱 URL을 복사해서 PWA 설정 화면의 "서버 저장 주소"에 붙여넣습니다.
 * 5. 코드를 수정할 때마다 배포 > 배포 관리 > 수정(연필 아이콘) > 새 버전으로 배포해야 반영됩니다.
 * 6. (Google 로그인용) 아래 GOOGLE_CLIENT_ID 를 app.js와 동일한 값으로 채워 넣고,
 *    ALLOWED_EMAIL_DOMAIN 이 학교 이메일 도메인(ync.ac.kr)인지 확인하세요.
 */

const SHEET_ID = '1WVAuienku00RmEecZR9ZAIRueXf6LF7dy3NPHoG4Bz8';
const SHEET_NAME = 'Log';
const PHOTO_FOLDER_NAME = '서버실점검_사진첨부';
const SHARED_SECRET = ''; // 예: 'univ-server-room-2026' 처럼 바꾸면 보안이 강화됩니다.

// Google 로그인: 이 도메인으로 끝나는 이메일만 로그인을 허용합니다.
const ALLOWED_EMAIL_DOMAIN = 'ync.ac.kr';
// app.js의 GOOGLE_CLIENT_ID와 반드시 동일한 값을 붙여넣으세요.
// (비워두면 발급 대상(aud) 검증을 건너뛰므로, 반드시 채워 넣는 것을 권장합니다.)
const GOOGLE_CLIENT_ID = '904845440598-a9sul7p4reug9rcre031im6e0mjdunce.apps.googleusercontent.com';

// 관리자(비상용) 로그인 계정: 구글 로그인 없이 이 아이디/비밀번호로도 로그인할 수 있게 합니다.
// 이 값은 서버(앱스 스크립트) 쪽에만 저장되고 화면(브라우저)으로는 절대 전달되지 않으므로,
// F12(개발자 도구)로 봐도 보이지 않습니다. 아래 두 값을 원하는 아이디/비밀번호로 바꾸고
// 배포 > 배포 관리 > 새 버전으로 다시 배포해야 반영됩니다.
const ADMIN_ID = 'admin';
const ADMIN_PW = 'a1234567!';

// 직책 자동 채우기용 시트: 같은 스프레드시트(SHEET_ID) 안에 이 이름의 탭을 만들고
// A열=이메일, B열=이름, C열=직책 형태로 한 줄씩 채워두면, 로그인할 때 이메일로 찾아서
// 직책을 자동으로 채워줍니다. 시트가 없거나 명단에 없는 사람은 빈 값을 돌려주고,
// 프론트엔드에서 직접 드롭다운으로 고르게 안내합니다.
const STAFF_SHEET_NAME = '직원명단';

// 계정관리(연결된 기기 목록)용 시트: 로그인/로그아웃 "기록"만 남깁니다. 하트비트(주기적
// 접속 확인) 없이, 계정+기기ID 조합으로 로그인 기록은 있는데 그 뒤로 로그아웃 기록이
// 없으면 "지금 로그인 중"으로 간주하는 방식입니다. A열=계정, B열=기기ID, C열=기기이름,
// D열=로그인시각, E열=로그아웃시각(비어있으면 아직 로그인 중).
const DEVICE_SHEET_NAME = '기기세션';

// 가입자 관리(관리자 전용)용 시트: 구글로 로그인한 사람 전체 명단입니다. 로그인/재로그인할
// 때마다 registerDevice 호출에 이름/직책을 함께 실어 보내 여기 upsert합니다.
// A열=이메일, B열=이름, C열=직책, D열=최초가입일, E열=최근로그인, F열=상태(active/blocked).
const USER_SHEET_NAME = '가입자';

const HEADERS = [
  '제출시각', '점검시각', '이름', '소속', '태그ID', '위치', '확인방법',
  '위도', '경도', '온도(C)', '습도(%)',
  'UPS정상', '항온항습기정상', '소화설비정상', '소음없음', '출입문정상',
  '메모', '사진링크', 'ClientID', '이메일',
];

function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function checkAuth(payload) {
  if (!SHARED_SECRET) return true;
  return payload && payload.secret === SHARED_SECRET;
}

// Google이 발급한 ID 토큰(idToken)을 구글 서버에 직접 물어봐서 진짜인지, 학교 이메일이
// 맞는지 확인합니다. 여기서 통과된 이메일/이름만 신뢰할 수 있는 값으로 취급합니다.
function verifyGoogleIdToken(idToken) {
  if (!idToken) return { ok: false, error: 'missing_token' };

  let data;
  try {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    Logger.log('tokeninfo 응답 코드: ' + res.getResponseCode());
    Logger.log('tokeninfo 응답 내용: ' + res.getContentText());
    if (res.getResponseCode() !== 200) return { ok: false, error: 'invalid_token' };
    data = JSON.parse(res.getContentText());
  } catch (err) {
    Logger.log('verify_failed 예외: ' + err);
    return { ok: false, error: 'verify_failed' };
  }

  Logger.log('GOOGLE_CLIENT_ID(우리코드): ' + GOOGLE_CLIENT_ID);
  Logger.log('aud(토큰 발급 대상): ' + data.aud);

  if (GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('여기에') && data.aud !== GOOGLE_CLIENT_ID) {
    return { ok: false, error: 'aud_mismatch' };
  }
  if (data.email_verified !== 'true' && data.email_verified !== true) {
    return { ok: false, error: 'email_not_verified' };
  }
  const email = String(data.email || '').toLowerCase();
  if (!email.endsWith('@' + ALLOWED_EMAIL_DOMAIN.toLowerCase())) {
    return { ok: false, error: 'domain_not_allowed' };
  }

  const name = data.name || email.split('@')[0];

  if (isUserBlocked(email)) {
    return { ok: false, error: 'blocked' };
  }

  return {
    ok: true,
    email: data.email,
    name: name,
    position: getStaffPosition(data.email, name),
  };
}

// 직원명단 시트에서 직책을 찾아 돌려줍니다. 못 찾으면 빈 문자열.
// 1순위: 이메일이 적혀있는 행 중에서 이메일이 정확히 일치하는 사람 (가장 정확함)
// 2순위: 이메일 칸이 비어있는 행 중에서 이름이 정확히 일치하는 사람 (이메일 아직 안 채운 경우 대비)
function getStaffPosition(email, name) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(STAFF_SHEET_NAME);
    if (!sheet) return '';
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return '';
    const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // 이메일, 이름, 직책

    const targetEmail = String(email || '').trim().toLowerCase();
    const targetName = String(name || '').trim();

    for (let i = 0; i < values.length; i++) {
      const rowEmail = String(values[i][0] || '').trim().toLowerCase();
      if (rowEmail && rowEmail === targetEmail) {
        return String(values[i][2] || '').trim();
      }
    }

    if (targetName) {
      for (let i = 0; i < values.length; i++) {
        const rowEmail = String(values[i][0] || '').trim();
        const rowName = String(values[i][1] || '').trim();
        if (!rowEmail && rowName === targetName) {
          return String(values[i][2] || '').trim();
        }
      }
    }

    return '';
  } catch (err) {
    return '';
  }
}

// 관리자 아이디/비밀번호가 맞는지 확인합니다. 위의 ADMIN_ID/ADMIN_PW와 정확히 일치해야 통과됩니다.
function verifyAdminLogin(id, pw) {
  const inputId = String(id || '').trim();
  const inputPw = String(pw || '');
  if (!inputId || !inputPw) return { ok: false, error: 'missing_credentials' };
  if (ADMIN_ID.startsWith('여기에') || ADMIN_PW.startsWith('여기에')) {
    return { ok: false, error: 'admin_not_configured' };
  }
  if (inputId !== ADMIN_ID || inputPw !== ADMIN_PW) {
    return { ok: false, error: 'invalid_credentials' };
  }
  return { ok: true, email: '', name: '관리자', position: '' };
}

function getDeviceSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(DEVICE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DEVICE_SHEET_NAME);
    sheet.appendRow(['계정', '기기ID', '기기이름', '로그인시각', '로그아웃시각']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 로그인할 때마다 새 줄을 하나 추가합니다(그 기기의 새 "세션"). 로그아웃 시각은 비워둡니다.
// account가 이메일 형태(구글 로그인)이면 가입자 시트도 함께 최신화합니다(관리자 계정처럼
// 이메일이 아닌 경우는 가입자 명단에 넣지 않습니다).
function registerDevice(account, deviceId, deviceName, name, position) {
  if (!account || !deviceId) return { ok: false, error: 'missing_params' };
  const sheet = getDeviceSheet();
  sheet.appendRow([account, deviceId, deviceName || '', new Date(), '']);
  if (String(account).indexOf('@') !== -1) {
    upsertUser(account, name, position);
  }
  return { ok: true };
}

// 그 계정의 기기들 중, 로그아웃 기록이 아직 없는(=로그인 중인) 기기만 돌려줍니다.
// 같은 기기가 여러 번 로그인했을 수 있어, 기기ID별로 가장 최근 로그인 줄만 봅니다.
function listDevices(account) {
  if (!account) return { ok: false, error: 'missing_account' };
  const sheet = getDeviceSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, devices: [] };

  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const activeByDevice = {};

  values.forEach((row) => {
    const acc = row[0], deviceId = row[1], deviceName = row[2], loginAt = row[3], logoutAt = row[4];
    if (String(acc) !== String(account)) return;
    if (logoutAt) return; // 이미 로그아웃 기록이 있는 세션은 제외

    const existing = activeByDevice[deviceId];
    if (!existing || new Date(loginAt) > new Date(existing.loginAt)) {
      activeByDevice[deviceId] = { deviceId: String(deviceId), deviceName: String(deviceName || ''), loginAt: loginAt };
    }
  });

  const devices = Object.keys(activeByDevice)
    .map((k) => activeByDevice[k])
    .sort((a, b) => new Date(b.loginAt) - new Date(a.loginAt));

  return { ok: true, devices: devices };
}

// 그 계정+기기ID의 "아직 로그아웃 안 된" 줄 중 가장 최근 것에 로그아웃 시각을 채웁니다.
function logoutDevice(account, deviceId) {
  if (!account || !deviceId) return { ok: false, error: 'missing_params' };
  const sheet = getDeviceSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true };

  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  let targetRow = -1;
  let targetTime = null;

  values.forEach((row, idx) => {
    const acc = row[0], devId = row[1], loginAt = row[3], logoutAt = row[4];
    if (String(acc) !== String(account) || String(devId) !== String(deviceId) || logoutAt) return;
    const t = new Date(loginAt);
    if (!targetTime || t > targetTime) {
      targetTime = t;
      targetRow = idx + 2; // 헤더 줄 + 0-index 보정
    }
  });

  if (targetRow > 0) {
    sheet.getRange(targetRow, 5).setValue(new Date());
  }
  return { ok: true };
}

/* ---------------- 가입자 관리(관리자 전용) ----------------
 * 구글로 로그인한 사람 전체 명단을 별도 시트에 관리합니다. 로그인/재로그인마다 upsertUser로
 * 최신화되고, 관리자는 이 명단을 보면서 특정 계정을 삭제하거나 차단할 수 있습니다.
 * 차단된 계정은 다음 로그인 시도부터 verifyGoogleIdToken에서 거부됩니다.
 */

function getUserSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(USER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(USER_SHEET_NAME);
    sheet.appendRow(['이메일', '이름', '직책', '최초가입일', '최근로그인', '상태']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 이미 있는 이메일이면 이름/직책/최근로그인만 갱신(가입일·상태는 그대로 유지)하고,
// 처음 보는 이메일이면 새 줄을 추가합니다.
function upsertUser(email, name, position) {
  if (!email) return;
  const sheet = getUserSheet();
  const lastRow = sheet.getLastRow();
  const now = new Date();

  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0]).toLowerCase() === String(email).toLowerCase()) {
        const row = i + 2;
        sheet.getRange(row, 2).setValue(name || values[i][1]);
        sheet.getRange(row, 3).setValue(position || values[i][2]);
        sheet.getRange(row, 5).setValue(now);
        return;
      }
    }
  }
  sheet.appendRow([email, name || '', position || '', now, now, 'active']);
}

// 그 이메일이 현재 차단 상태인지 확인합니다.
function isUserBlocked(email) {
  if (!email) return false;
  const sheet = getUserSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).toLowerCase() === String(email).toLowerCase()) {
      return String(values[i][5]) === 'blocked';
    }
  }
  return false;
}

// 가입자 관리 화면에서 전체 목록을 봅니다.
function listUsers() {
  const sheet = getUserSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, users: [] };
  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const users = values.map((row) => ({
    email: String(row[0] || ''),
    name: String(row[1] || ''),
    position: String(row[2] || ''),
    joinedAt: row[3] || '',
    lastLoginAt: row[4] || '',
    status: String(row[5] || 'active'),
  })).sort((a, b) => new Date(b.lastLoginAt) - new Date(a.lastLoginAt));
  return { ok: true, users: users };
}

// 가입자 목록에서 특정 계정을 삭제합니다(명단에서만 제거 — 이미 제출된 점검 기록은 그대로 남습니다).
function deleteUser(email) {
  if (!email) return { ok: false, error: 'missing_email' };
  const sheet = getUserSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true };
  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).toLowerCase() === String(email).toLowerCase()) {
      sheet.deleteRow(i + 2);
      return { ok: true };
    }
  }
  return { ok: true };
}

// 가입자를 차단하거나 차단 해제합니다.
function setUserStatus(email, blocked) {
  if (!email) return { ok: false, error: 'missing_email' };
  const sheet = getUserSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'not_found' };
  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).toLowerCase() === String(email).toLowerCase()) {
      sheet.getRange(i + 2, 6).setValue(blocked ? 'blocked' : 'active');
      return { ok: true };
    }
  }
  return { ok: false, error: 'not_found' };
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function savePhoto(base64DataUrl, fileNameHint) {
  if (!base64DataUrl) return '';
  try {
    const match = base64DataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!match) return '';
    const mimeType = match[1];
    const base64 = match[2];
    const bytes = Utilities.base64Decode(base64);
    const blob = Utilities.newBlob(bytes, mimeType, fileNameHint || ('photo_' + Date.now()));

    const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
    const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return '';
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.action === 'login') {
      return jsonOut(verifyGoogleIdToken(body.idToken));
    }

    if (body.action === 'adminLogin') {
      return jsonOut(verifyAdminLogin(body.id, body.pw));
    }

    if (body.action === 'registerDevice') {
      return jsonOut(registerDevice(body.account, body.deviceId, body.deviceName, body.name, body.position));
    }

    if (body.action === 'logoutDevice') {
      return jsonOut(logoutDevice(body.account, body.deviceId));
    }

    if (body.action === 'deleteUser') {
      return jsonOut(deleteUser(body.email));
    }

    if (body.action === 'setUserStatus') {
      return jsonOut(setUserStatus(body.email, !!body.blocked));
    }

    if (body.action !== 'submit' || !body.record) {
      return jsonOut({ ok: false, error: 'invalid_action' });
    }
    if (!checkAuth(body)) {
      return jsonOut({ ok: false, error: 'unauthorized' });
    }

    const r = body.record;
    const sheet = getSheet();
    const photoUrl = savePhoto(r.photoBase64, r.photoName);

    sheet.appendRow([
      new Date(),
      r.timestamp || '',
      r.userName || '',
      r.userTeam || '',
      r.tagId || '',
      r.tagLabel || '',
      r.method || '',
      r.lat != null ? r.lat : '',
      r.lng != null ? r.lng : '',
      r.temperature != null ? r.temperature : '',
      r.humidity != null ? r.humidity : '',
      r.equipment ? r.equipment.ups : '',
      r.equipment ? r.equipment.aircon : '',
      r.equipment ? r.equipment.fire : '',
      r.equipment ? r.equipment.noiseOk : '',
      r.equipment ? r.equipment.door : '',
      r.note || '',
      photoUrl,
      r.clientId || '',
      r.userEmail || '',
    ]);

    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || 'list';

  if (SHARED_SECRET && params.secret !== SHARED_SECRET) {
    return jsonOut({ ok: false, error: 'unauthorized' });
  }

  if (action === 'list') {
    const limit = Math.min(parseInt(params.limit, 10) || 15, 200);
    const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
    const sheet = getSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonOut({ ok: true, records: [], hasMore: false });

    // offset은 "이미 불러온 최신순 기록 개수"입니다. 시트는 오래된 순으로 쌓이므로
    // 맨 아래(최신)에서 offset만큼 건너뛴 지점을 이번 페이지의 끝으로 봅니다.
    const endRow = lastRow - offset;
    if (endRow < 2) return jsonOut({ ok: true, records: [], hasMore: false });

    const startRow = Math.max(2, endRow - limit + 1);
    const numRows = endRow - startRow + 1;
    const values = sheet.getRange(startRow, 1, numRows, HEADERS.length).getValues();
    const hasMore = startRow > 2;

    const records = values.map((row) => ({
      submittedAt: row[0],
      timestamp: row[1],
      userName: row[2],
      userTeam: row[3],
      tagId: row[4],
      tagLabel: row[5],
      method: row[6],
      lat: row[7],
      lng: row[8],
      temperature: row[9],
      humidity: row[10],
      equipment: {
        ups: row[11],
        aircon: row[12],
        fire: row[13],
        noiseOk: row[14],
        door: row[15],
      },
      note: row[16],
      photoUrl: row[17],
      clientId: row[18],
      userEmail: row[19],
    })).reverse(); // 최신순

    return jsonOut({ ok: true, records, hasMore });
  }

  if (action === 'listDevices') {
    return jsonOut(listDevices(params.account));
  }

  if (action === 'listUsers') {
    return jsonOut(listUsers());
  }

  return jsonOut({ ok: false, error: 'unknown_action' });
}
