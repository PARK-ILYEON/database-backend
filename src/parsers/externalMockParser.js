// 편입모의고사 등 외부 대행업체 성적 결과 파싱.
// 실제 파일 구조 (2행 헤더, 일부는 병합 셀이라 두 번째 칸에 라벨 텍스트가 없다):
//   행0: 번호 | 아이디 | 이름 | 회원종류 | 편입 | 계열 | 캠퍼스명 | 반명 | 실득점 | 백분위 | 전체 | 석차 / 응시인원 | | | | 평균 | | 상위30%평균 | | (시트 제목)
//   행1:  |  |  |  | 구분 |  |  |  |  |  | 석차 | 반 |  | 계열 |  | 반 | 계열 | 반 | 계열 |
// "석차 / 응시인원"(반석차/반응시인원/계열석차/계열응시인원), "평균"(반/계열), "상위30%평균"(반/계열)은
// 병합 헤더라 뒤쪽 칸이 빈칸으로 나온다 — 그룹 라벨이 시작되는 열을 찾은 뒤 고정 오프셋으로 읽는다.
const XLSX = require('xlsx');

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

function findCol(row, labelVariants, maxCol = 40) {
  const targets = labelVariants.map(norm);
  for (let c = 0; c < Math.min(maxCol, row.length); c++) {
    if (targets.includes(norm(row[c]))) return c;
  }
  return null;
}

function toNum(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.round(n);
}

/**
 * 시트 하나(과목 하나)를 파싱한다.
 * @param {any[][]} rows
 * @param {string} subject 과목명 (보통 시트 이름을 그대로 씀, 예: "영어"/"수학")
 */
function parseExternalMockRows(rows, subject) {
  const row0 = rows[0] || [];

  const idCol = findCol(row0, ['아이디', 'ID']);
  const examNoCol = findCol(row0, ['수험번호']); // 있으면 아이디 매핑 없이 바로 수험번호로 매칭할 수 있다 (선택 컬럼)
  const nameCol = findCol(row0, ['이름']);
  const admissionTypeCol = findCol(row0, ['편입']);
  const trackCol = findCol(row0, ['계열']);
  const campusCol = findCol(row0, ['캠퍼스명']);
  const classCol = findCol(row0, ['반명']);
  const scoreCol = findCol(row0, ['실득점']);
  const percentileCol = findCol(row0, ['백분위']);
  const overallRankCol = findCol(row0, ['전체']);
  const rankGroupCol = findCol(row0, ['석차/응시인원', '석차 / 응시인원']);
  const avgGroupCol = findCol(row0, ['평균']);
  const top30GroupCol = findCol(row0, ['상위30%평균', '상위30퍼센트평균']);

  if (idCol === null || nameCol === null || scoreCol === null) {
    throw new Error('필수 라벨(아이디/이름/실득점)을 찾지 못했습니다.');
  }

  const classRankCol = rankGroupCol;
  const classApplicantsCol = rankGroupCol !== null ? rankGroupCol + 1 : null;
  const trackRankCol = rankGroupCol !== null ? rankGroupCol + 2 : null;
  const trackApplicantsCol = rankGroupCol !== null ? rankGroupCol + 3 : null;
  const classAvgCol = avgGroupCol;
  const trackAvgCol = avgGroupCol !== null ? avgGroupCol + 1 : null;
  const top30ClassAvgCol = top30GroupCol;
  const top30TrackAvgCol = top30GroupCol !== null ? top30GroupCol + 1 : null;

  const scores = [];
  for (let r = 2; r < rows.length; r++) { // 행0/행1은 헤더, 행2부터 데이터
    const row = rows[r] || [];
    const externalId = String(row[idCol] ?? '').trim();
    if (!externalId) continue; // 빈 행은 건너뜀

    scores.push({
      studentExternalId: externalId,
      examNo: examNoCol !== null ? (String(row[examNoCol] ?? '').trim() || null) : null,
      realName: String(row[nameCol] ?? '').trim() || null,
      subject,
      admissionType: admissionTypeCol !== null ? (String(row[admissionTypeCol] ?? '').trim() || null) : null,
      track: trackCol !== null ? (String(row[trackCol] ?? '').trim() || null) : null,
      campusName: campusCol !== null ? (String(row[campusCol] ?? '').trim() || null) : null,
      className: classCol !== null ? (String(row[classCol] ?? '').trim() || null) : null,
      rawScore: toNum(row[scoreCol]),
      percentile: percentileCol !== null ? toNum(row[percentileCol]) : null,
      overallRank: overallRankCol !== null ? toInt(row[overallRankCol]) : null,
      classRank: classRankCol !== null ? toInt(row[classRankCol]) : null,
      classApplicants: classApplicantsCol !== null ? toInt(row[classApplicantsCol]) : null,
      trackRank: trackRankCol !== null ? toInt(row[trackRankCol]) : null,
      trackApplicants: trackApplicantsCol !== null ? toInt(row[trackApplicantsCol]) : null,
      classAvg: classAvgCol !== null ? toNum(row[classAvgCol]) : null,
      trackAvg: trackAvgCol !== null ? toNum(row[trackAvgCol]) : null,
      top30ClassAvg: top30ClassAvgCol !== null ? toNum(row[top30ClassAvgCol]) : null,
      top30TrackAvg: top30TrackAvgCol !== null ? toNum(row[top30TrackAvgCol]) : null
    });
  }

  return scores;
}

/**
 * 워크북의 모든 시트를 각각 과목(시트 이름)으로 간주해 파싱한다 (예: "영어"/"수학" 시트).
 * @param {XLSX.WorkBook} workbook
 */
function parseExternalMockWorkbook(workbook) {
  const allScores = [];
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      const scores = parseExternalMockRows(rows, sheetName);
      allScores.push(...scores);
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  if (allScores.length === 0) {
    throw new Error('워크북의 어느 시트에서도 성적 데이터를 인식하지 못했습니다. (' + errors.join(' / ') + ')');
  }
  // 일부 시트만 실패한 경우(예: 영어는 인식됐지만 수학 시트는 라벨이 달라 인식 실패)에도
  // 조용히 무시하지 않고 warnings로 알려준다.
  return { scores: allScores, warnings: errors };
}

module.exports = { parseExternalMockRows, parseExternalMockWorkbook };
