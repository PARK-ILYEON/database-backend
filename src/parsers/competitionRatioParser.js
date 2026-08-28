// 대학별 모집인원/지원인원/경쟁률 자료 파싱.
// 실제 파일 구조: 대학 하나당 시트 하나씩 있고, 파일에 따라 맨 앞에 전체 대학을 한데 모은
// 요약 시트가 있을 수도, 없을 수도 있다(20MB 업로드 제한 때문에 요약 시트를 빼고 올리는 경우가 있음).
// 그래서 시트 위치로 요약 시트를 건너뛰지 않고, 파싱된 결과에 대학명이 두 개 이상 섞여 있으면
// "여러 대학이 섞인 시트 = 요약 시트"로 보고 그 시트만 걸러낸다.
//   헤더: 대학 | 계열 | 대학/학부 | 모집단위 | 모집인원 | 지원인원 | 경쟁률
// 모집인원이 "(2)"처럼 괄호로 감싸져 있으면, 학과별이 아니라 더 넓은 계열 단위로 통합 선발했다는 뜻이다.
// 경쟁률 컬럼은 표기가 일정치 않아("14.50:1" vs "123.50 : 1") 저장하지 않고, 필요할 때 지원/모집으로 다시 계산한다.
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

// "16", "(2)", " 16 " 등을 처리해서 { value, isCombined }를 반환한다.
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
 * 시트 하나(대학 하나)를 파싱한다.
 * @param {any[][]} rows
 * @param {string} sheetName 시트 이름 (대학 컬럼이 비어있을 때 대학명으로 대신 쓴다)
 */
function parseCompetitionRatioRows(rows, sheetName) {
  let headerRow = -1;
  let univCol = null, trackCol = null, collegeCol = null, deptCol = null, quotaCol = null, applicantsCol = null;

  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    const d = findCol(row, ['모집단위']);
    const q = findCol(row, ['모집인원']);
    if (d !== null && q !== null) {
      headerRow = r;
      deptCol = d;
      quotaCol = q;
      univCol = findCol(row, ['대학', '대학명']);
      trackCol = findCol(row, ['계열']);
      collegeCol = findCol(row, ['대학/학부', '대학·학부', '단과대학']);
      applicantsCol = findCol(row, ['지원인원']);
      break;
    }
  }
  if (headerRow === -1) {
    throw new Error('"모집단위"/"모집인원" 라벨을 찾지 못했습니다.');
  }

  const records = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const deptName = String(row[deptCol] ?? '').trim();
    if (!deptName) continue;
    const univName = (univCol !== null ? String(row[univCol] ?? '').trim() : '') || sheetName;
    const quota = parseQuotaCell(row[quotaCol]);
    records.push({
      univName,
      track: trackCol !== null ? (String(row[trackCol] ?? '').trim() || null) : null,
      college: collegeCol !== null ? (String(row[collegeCol] ?? '').trim() || null) : null,
      deptName,
      quotaGeneral: quota.value,
      isCombinedSelection: quota.isCombined,
      applicantsGeneral: applicantsCol !== null ? toNullableInt(row[applicantsCol]) : null
    });
  }
  return records;
}

/**
 * 워크북 전체를 파싱한다. 대학 하나당 시트 하나로 보되, 한 시트에 대학명이 여러 개 섞여 있으면
 * (=전체 요약 시트로 추정) 그 시트는 건너뛴다. 요약 시트가 맨 앞에 있든, 아예 없든 모두 처리된다.
 * @param {XLSX.WorkBook} workbook
 */
function parseCompetitionRatioWorkbook(workbook) {
  const all = [];
  const errors = [];
  const sheetNames = workbook.SheetNames;
  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      const records = parseCompetitionRatioRows(rows, sheetName);
      const distinctUnivs = new Set(records.map(r => r.univName));
      if (distinctUnivs.size > 1) {
        errors.push(`[${sheetName}] 여러 대학(${distinctUnivs.size}개)이 섞인 시트로 보여 건너뜀 (전체 요약 시트로 추정)`);
        continue;
      }
      all.push(...records);
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  if (all.length === 0) {
    throw new Error('워크북의 어느 시트에서도 경쟁률 데이터를 인식하지 못했습니다. (' + errors.join(' / ') + ')');
  }
  return { records: all, warnings: errors };
}

module.exports = { parseCompetitionRatioRows, parseCompetitionRatioWorkbook };
