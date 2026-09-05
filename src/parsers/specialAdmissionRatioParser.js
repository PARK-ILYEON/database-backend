// 특별전형(농어촌/재외국민/기회균형 등) 경쟁률 자료 파싱. 학사 경쟁률과 마찬가지로 시트 1개에
// 전체 대학이 나열된 형태지만, "전형" 컬럼이 따로 있어 같은 학과라도 전형명이 다른 줄이 여러 개
// 있을 수 있다(예: 농어촌/재외국민). 합치지 않고 전형명을 그대로 붙여 줄 단위로 저장한다.
//   헤더: 대학 | 전형 | 계열 | 대학/학부 | 모집단위 | 모집인원 | 지원인원 | 경쟁률
const XLSX = require('xlsx');

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

function findCol(row, labelVariants, maxCol = 20) {
  const targets = labelVariants.map(norm);
  for (let c = 0; c < Math.min(maxCol, row.length); c++) {
    if (targets.includes(norm(row[c]))) return c;
  }
  return null;
}

function parseQuotaCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null, isCombined: false };
  const paren = s.match(/^\(\s*(-?\d+)\s*\)$/);
  if (paren) return { value: Number(paren[1]), isCombined: true };
  const n = Number(s.replace(/,/g, ''));
  return { value: Number.isFinite(n) ? n : null, isCombined: false };
}

function toNullableInt(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 시트 하나를 파싱한다. 대학명/전형명 컬럼이 항상 채워져 있다고 가정한다.
 * @param {any[][]} rows
 */
function parseSpecialAdmissionRows(rows) {
  let headerRow = -1;
  let univCol = null, typeCol = null, trackCol = null, collegeCol = null, deptCol = null, quotaCol = null, applicantsCol = null;

  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    const d = findCol(row, ['모집단위']);
    const q = findCol(row, ['모집인원']);
    if (d !== null && q !== null) {
      headerRow = r;
      deptCol = d;
      quotaCol = q;
      univCol = findCol(row, ['대학', '대학명']);
      typeCol = findCol(row, ['전형', '전형명', '전형유형']);
      trackCol = findCol(row, ['계열']);
      collegeCol = findCol(row, ['대학/학부', '대학·학부', '단과대학']);
      applicantsCol = findCol(row, ['지원인원']);
      break;
    }
  }
  if (headerRow === -1) {
    throw new Error('"모집단위"/"모집인원" 라벨을 찾지 못했습니다.');
  }
  if (univCol === null) {
    throw new Error('"대학"/"대학명" 라벨을 찾지 못했습니다.');
  }

  const records = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const deptName = String(row[deptCol] ?? '').trim();
    const univName = String(row[univCol] ?? '').trim();
    if (!deptName || !univName) continue;
    const quota = parseQuotaCell(row[quotaCol]);
    records.push({
      univName,
      admissionType: typeCol !== null ? (String(row[typeCol] ?? '').trim() || null) : null,
      track: trackCol !== null ? (String(row[trackCol] ?? '').trim() || null) : null,
      college: collegeCol !== null ? (String(row[collegeCol] ?? '').trim() || null) : null,
      deptName,
      quotaSpecial: quota.value,
      isCombinedSelection: quota.isCombined,
      applicantsSpecial: applicantsCol !== null ? toNullableInt(row[applicantsCol]) : null
    });
  }
  return records;
}

/**
 * 워크북 전체를 파싱한다. 시트가 몇 개든 파싱 가능한 시트는 전부 처리해서 합친다.
 * @param {XLSX.WorkBook} workbook
 */
function parseSpecialAdmissionWorkbook(workbook) {
  const all = [];
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      all.push(...parseSpecialAdmissionRows(rows));
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  if (all.length === 0) {
    throw new Error('워크북의 어느 시트에서도 특별전형 경쟁률 데이터를 인식하지 못했습니다. (' + errors.join(' / ') + ')');
  }
  return { records: all, warnings: errors };
}

module.exports = { parseSpecialAdmissionRows, parseSpecialAdmissionWorkbook };
