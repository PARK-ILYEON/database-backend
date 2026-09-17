// "대학별 기출점수" 파일 파싱. 학생(행) x 대학+기출연도+과목(열)의 넓은 표 형태다.
//   고정 컬럼: 이름 | 수험번호 | 계열 | 합격대학 | 응시횟수
//   그 뒤로 대학별 컬럼이 반복: 예) "건국대\n'23 영어", "성균관대\n'23 영+수" (셀 안에 줄바꿈 포함)
// 셀 하나하나가 "이 학생이 이 대학의 이 연도 기출을 이 과목(조합)으로 풀었을 때 받은 점수"를 의미하므로,
// 표를 넓은 형태(wide) 그대로 두지 않고 셀 단위로 풀어서(long) 레코드 배열로 만든다.
// 합격대학 컬럼은 참고용으로만 두고 실제 합격 여부는 저장 시점이 아니라 조회 시점에 admission_cases와
// exam_no로 조인해서 판단한다(합격자 명단이 나중에 갱신돼도 항상 최신 상태를 반영하기 위함).
//
// 파일에 연도별로 시트가 여러 개 있을 수 있는데, 옛날 시트는 수험번호 칸에 우리 시스템(K로 시작하는
// 수험번호)과 다른 옛날 아이디 체계(예: "3233" 같은 순수 숫자)가 들어있는 경우가 있다. 이런 값은
// admission_cases와 영원히 매칭될 수 없는 죽은 데이터가 되므로, 수험번호가 K로 시작하는 행만 저장하고
// 나머지는 건너뛴다(스킵된 건수는 경고로 알려준다).
const XLSX = require('xlsx');
const EXAM_NO_PATTERN = /^K\d+$/i;

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

function findCol(row, labelVariants, maxCol = 10) {
  const targets = labelVariants.map(norm);
  for (let c = 0; c < Math.min(maxCol, row.length); c++) {
    if (targets.includes(norm(row[c]))) return c;
  }
  return null;
}

// "건국대\n'23 영어" / "건국대 '23 영어" / "건국대'23 영어" 등을 { univName, examYear, subjectCombo }로 파싱.
// 셀 안 줄바꿈/여러 공백은 먼저 단일 공백으로 합친 뒤 정규식을 적용한다.
function parseUnivYearSubjectHeader(raw) {
  const flat = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const m = flat.match(/^(.+?)\s*'(\d{2})\s+(.+)$/);
  if (!m) return null;
  const univName = m[1].trim();
  const yy = Number(m[2]);
  const examYear = 2000 + yy;
  const subjectCombo = m[3].trim();
  if (!univName || !subjectCombo || !Number.isFinite(examYear)) return null;
  return { univName, examYear, subjectCombo };
}

function toNullableFloat(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 시트 하나를 파싱한다.
 * @param {any[][]} rows
 */
function parseUnivPastExamRows(rows) {
  let headerRow = -1;
  let examNoCol = null;

  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    const en = findCol(row, ['수험번호']);
    if (en !== null) {
      headerRow = r;
      examNoCol = en;
      break;
    }
  }
  if (headerRow === -1) {
    throw new Error('"수험번호" 라벨을 찾지 못했습니다.');
  }

  const headerCells = rows[headerRow] || [];
  const nameCol = findCol(headerCells, ['이름']);
  const trackCol = findCol(headerCells, ['계열']);
  const admittedUnivCol = findCol(headerCells, ['합격대학']);
  const attemptsCol = findCol(headerCells, ['응시횟수']);
  const fixedCols = new Set([examNoCol, nameCol, trackCol, admittedUnivCol, attemptsCol].filter(c => c !== null));

  // 고정 컬럼이 아닌 나머지 컬럼은 전부 "대학+기출연도+과목" 점수 컬럼 후보로 보고 헤더를 파싱한다.
  const scoreCols = [];
  for (let c = 0; c < headerCells.length; c++) {
    if (fixedCols.has(c)) continue;
    const parsed = parseUnivYearSubjectHeader(headerCells[c]);
    if (parsed) scoreCols.push({ col: c, ...parsed });
  }
  if (scoreCols.length === 0) {
    throw new Error('대학/기출연도/과목 형식의 점수 컬럼을 하나도 인식하지 못했습니다 (예: "건국대 \'23 영어").');
  }

  const records = [];
  let skippedFormatRowCount = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const examNo = String(row[examNoCol] ?? '').trim();
    if (!examNo) continue;
    if (!EXAM_NO_PATTERN.test(examNo)) {
      skippedFormatRowCount++;
      continue;
    }
    for (const sc of scoreCols) {
      const score = toNullableFloat(row[sc.col]);
      if (score === null) continue; // 그 대학 기출을 안 풀어본 경우 빈 칸 -> 건너뜀
      records.push({
        examNo,
        univName: sc.univName,
        examYear: sc.examYear,
        subjectCombo: sc.subjectCombo,
        score
      });
    }
  }
  return { records, skippedFormatRowCount };
}

/**
 * 워크북 전체를 파싱한다. 시트가 몇 개든 파싱 가능한 시트는 전부 처리해서 합친다.
 * @param {XLSX.WorkBook} workbook
 */
function parseUnivPastExamWorkbook(workbook) {
  const all = [];
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      const { records, skippedFormatRowCount } = parseUnivPastExamRows(rows);
      all.push(...records);
      if (skippedFormatRowCount > 0) {
        errors.push(`[${sheetName}] 수험번호 형식이 우리 시스템(K로 시작)과 달라 ${skippedFormatRowCount}명 분량을 건너뜀`);
      }
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  if (all.length === 0) {
    throw new Error('워크북의 어느 시트에서도 대학별 기출점수 데이터를 인식하지 못했습니다. (' + errors.join(' / ') + ')');
  }
  return { records: all, warnings: errors };
}

module.exports = { parseUnivPastExamRows, parseUnivPastExamWorkbook, parseUnivYearSubjectHeader };
