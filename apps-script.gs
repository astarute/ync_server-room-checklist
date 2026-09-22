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

// 직책 자동 채우기용 시트: 같은 스프레드시트(SHEET_ID) 안에 이 이름의 탭을 만들고
// A열=이메일, B열=이름, C열=직책 형태로 한 줄씩 채워두면, 로그인할 때 이메일로 찾아서
// 직책을 자동으로 채워줍니다. 시트가 없거나 명단에 없는 사람은 빈 값을 돌려주고,
// 프론트엔드에서 직접 드롭다운으로 고르게 안내합니다.
const STAFF_SHEET_NAME = '직원명단';

const HEADERS = [
  '제출시각', '점검시각', '이름', '소속', '태그ID', '위치', '확인방법',
  '위도', '경도', '온도(C)', '습도(%)',
  'UPS정상', '항온항습기정상', '소화설비정상', '소음없음', '출입문정상',
  '메모', '사진링크', 'ClientID', '이메일',
];

function getSheet_() {
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

function checkAuth_(payload) {
  if (!SHARED_SECRET) return true;
  return payload && payload.secret === SHARED_SECRET;
}

// Google이 발급한 ID 토큰(idToken)을 구글 서버에 직접 물어봐서 진짜인지, 학교 이메일이
// 맞는지 확인합니다. 여기서 통과된 이메일/이름만 신뢰할 수 있는 값으로 취급합니다.
function verifyGoogleIdToken_(idToken) {
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
  return {
    ok: true,
    email: data.email,
    name: name,
    position: getStaffPosition_(data.email, name),
  };
}

// 직원명단 시트에서 직책을 찾아 돌려줍니다. 못 찾으면 빈 문자열.
// 1순위: 이메일이 적혀있는 행 중에서 이메일이 정확히 일치하는 사람 (가장 정확함)
// 2순위: 이메일 칸이 비어있는 행 중에서 이름이 정확히 일치하는 사람 (이메일 아직 안 채운 경우 대비)
function getStaffPosition_(email, name) {
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

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function savePhoto_(base64DataUrl, fileNameHint) {
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
      return jsonOut_(verifyGoogleIdToken_(body.idToken));
    }

    if (body.action !== 'submit' || !body.record) {
      return jsonOut_({ ok: false, error: 'invalid_action' });
    }
    if (!checkAuth_(body)) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }

    const r = body.record;
    const sheet = getSheet_();
    const photoUrl = savePhoto_(r.photoBase64, r.photoName);

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

    return jsonOut_({ ok: true });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || 'list';

  if (SHARED_SECRET && params.secret !== SHARED_SECRET) {
    return jsonOut_({ ok: false, error: 'unauthorized' });
  }

  if (action === 'list') {
    const limit = Math.min(parseInt(params.limit, 10) || 15, 200);
    const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
    const sheet = getSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonOut_({ ok: true, records: [], hasMore: false });

    // offset은 "이미 불러온 최신순 기록 개수"입니다. 시트는 오래된 순으로 쌓이므로
    // 맨 아래(최신)에서 offset만큼 건너뛴 지점을 이번 페이지의 끝으로 봅니다.
    const endRow = lastRow - offset;
    if (endRow < 2) return jsonOut_({ ok: true, records: [], hasMore: false });

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

    return jsonOut_({ ok: true, records, hasMore });
  }

  return jsonOut_({ ok: false, error: 'unknown_action' });
}
