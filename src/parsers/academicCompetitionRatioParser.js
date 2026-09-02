// 학사편입 경쟁률 자료 파싱. 일반 경쟁률 파일(대학별 시트 분리)과 달리, 시트 1개에 전체 대학이
// 한꺼번에 나열된 형태로 온다. 같은 대학+학과가 전형별로 여러 줄 나오는 경우가 있는데(예: 건국대
// 건축학부가 모집16/지원232, 모집2/지원42로 2줄), 합치지 않고 줄 단위 그대로 저장한다.
//   헤더: 대학 | 계열 | 대학/학부 | 모집단위 | 모집인원 | 지원인원 | 경쟁률
// 모집인원이 "(27)"처럼 괄호로 감싸져 있으면 학과별이 아니라 더 넓은 단위로 통합 선발했다는 뜻이다.
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
 * 시트 하나를 파싱한다. 일반 경쟁률과 달리 대학명 컬럼이 항상 채워져 있다고 가정한다
 * (시트 하나에 여러 대학이 섞여 있으므로 시트명을 대학명 대신 쓸 수 없음).
 * @param {any[][]} rows
 */
function parseAcademicCompetitionRows(rows) {
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
      track: trackCol !== null ? (String(row[trackCol] ?? '').trim() || null) : null,
      college: collegeCol !== null ? (String(row[collegeCol] ?? '').trim() || null) : null,
      deptName,
      quotaAcademic: quota.value,
      isCombinedSelection: quota.isCombined,
      applicantsAcademic: applicantsCol !== null ? toNullableInt(row[applicantsCol]) : null
    });
  }
  return records;
}

/**
 * 워크북 전체를 파싱한다. 시트가 1개(전체 대학 한 시트)든 여러 개든 상관없이, 파싱 가능한 시트는
 * 전부 처리해서 합친다. (일반 경쟁률과 달리 "요약 시트라서 건너뛴다"는 판단이 필요 없다 — 대학명이
 * 여러 개 섞여 있는 게 정상적인 파일 구조이기 때문.)
 * @param {XLSX.WorkBook} workbook
 */
function parseAcademicCompetitionWorkbook(workbook) {
  const all = [];
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      all.push(...parseAcademicCompetitionRows(rows));
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  if (all.length === 0) {
    throw new Error('워크북의 어느 시트에서도 학사 경쟁률 데이터를 인식하지 못했습니다. (' + errors.join(' / ') + ')');
  }
  return { records: all, warnings: errors };
}

module.exports = { parseAcademicCompetitionRows, parseAcademicCompetitionWorkbook };
