// 2부 - 수강생 명단 파싱 (2-0b, "N. 인원 넣기 (성적DB)" 시트)
// 실제 구조: 헤더가 2행에 걸쳐 있다.
//   행0: 순번 | 번호(수험번호) | 이름 | (공백,학과는 행1) | (공백,계열은 행1) | 1차~12차(12칸) | (공백) | OO처리(마스킹이름) | (공백)
//   행1: (공백) | (공백) | (공백) | 학과 | 계열 | ...
// "1차"~"12차" 열 = 누적성적 백분위 (사용자 확인)
const XLSX = require('xlsx');

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

function scanHeader(rows, maxRow = 4, maxCol = 30) {
  let examNoCol = null, nameCol = null, deptCol = null, trackCol = null, maskedNameCol = null;
  const roundCols = {}; // { 1: colIndex, 2: colIndex, ... }
  let headerEndRow = 0;

  // 데이터 행의 마스킹 이름 값("강OO","곽OO" 등)도 "OO"를 포함하므로,
  // 헤더 라벨은 느슨한 includes가 아니라 알려진 라벨 텍스트와 정확히 일치해야만 인정한다.
  const MASKED_NAME_LABELS = new Set(['OO처리', '마스킹이름', '마스킹', '별칭']);

  for (let r = 0; r < Math.min(maxRow, rows.length); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < Math.min(maxCol, row.length); c++) {
      const text = norm(row[c]);
      if (!text) continue;
      if (text.includes('수험번호')) { examNoCol = c; headerEndRow = Math.max(headerEndRow, r); }
      else if (text === '이름') { nameCol = c; headerEndRow = Math.max(headerEndRow, r); }
      else if (text === '학과') { deptCol = c; headerEndRow = Math.max(headerEndRow, r); }
      else if (text === '계열') { trackCol = c; headerEndRow = Math.max(headerEndRow, r); }
      else if (MASKED_NAME_LABELS.has(text)) { maskedNameCol = c; headerEndRow = Math.max(headerEndRow, r); }
      else {
        const m = text.match(/^(\d+)차$/);
        if (m) { roundCols[Number(m[1])] = c; headerEndRow = Math.max(headerEndRow, r); }
      }
    }
  }

  if (examNoCol === null) {
    throw new Error('명단 시트에서 "수험번호" 라벨을 찾지 못했습니다. 시트 구조를 확인해주세요.');
  }

  return { examNoCol, nameCol, deptCol, trackCol, maskedNameCol, roundCols, dataStartRow: headerEndRow + 1 };
}

/**
 * 명단 시트(2차원 배열)를 파싱해 학생 목록을 반환한다.
 * @param {any[][]} rows
 * @returns {{ students: Array<{examNo, realName, dept, track, maskedName, roundPercentiles}>, header: object }}
 */
function parseRosterRows(rows) {
  const header = scanHeader(rows);
  const students = [];

  for (let r = header.dataStartRow; r < rows.length; r++) {
    const row = rows[r] || [];
    const examNoRaw = row[header.examNoCol];
    const examNo = examNoRaw === undefined ? '' : String(examNoRaw).trim();
    if (!examNo) continue; // 빈 행은 건너뜀

    const roundPercentiles = {};
    for (const [roundNo, col] of Object.entries(header.roundCols)) {
      const raw = row[col];
      if (raw !== undefined && String(raw).trim() !== '') {
        const n = Number(raw);
        roundPercentiles[roundNo] = Number.isFinite(n) ? n : String(raw).trim();
      }
    }

    students.push({
      examNo,
      realName: header.nameCol !== null ? String(row[header.nameCol] ?? '').trim() || null : null,
      dept: header.deptCol !== null ? String(row[header.deptCol] ?? '').trim() || null : null,
      track: header.trackCol !== null ? String(row[header.trackCol] ?? '').trim() || null : null,
      maskedName: header.maskedNameCol !== null ? String(row[header.maskedNameCol] ?? '').trim() || null : null,
      roundPercentiles
    });
  }

  return { students, header };
}

function parseRosterSheet(workbook, sheetRef) {
  const sheetName = typeof sheetRef === 'number' ? workbook.SheetNames[sheetRef] : sheetRef;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`시트를 찾을 수 없습니다: ${sheetRef}`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return parseRosterRows(rows);
}

/**
 * 시트 번호를 지정하지 않고, 워크북의 모든 시트를 순서대로 시도해 명단 형식("수험번호" 라벨 포함)을
 * 인식하는 첫 시트를 사용한다. 정답지/명단이 한 워크북에 같이 있어도 자동으로 올바른 시트를 찾는다.
 * @param {XLSX.WorkBook} workbook
 */
function parseRosterWorkbook(workbook) {
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      const result = parseRosterRows(rows);
      if (result.students.length > 0) return result;
      errors.push(`[${sheetName}] 라벨은 찾았지만 학생 데이터가 없습니다.`);
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  throw new Error('워크북의 어느 시트에서도 명단 형식을 인식하지 못했습니다. (' + errors.join(' / ') + ')');
}

/** 실명에서 "성 + OO" 마스킹 이름을 생성한다 (파일에 이미 있으면 그 값을 우선 사용). */
function maskName(realName) {
  if (!realName) return null;
  const surname = realName.trim().slice(0, 1);
  return surname ? `${surname}OO` : null;
}

module.exports = { parseRosterSheet, parseRosterWorkbook, parseRosterRows, maskName };
