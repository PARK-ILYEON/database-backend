// 2부 - 정답지 파싱
// 실제 파일 구조 (기술설계서 2-0b 참고, "N. 배점,정답,파트 기입" 시트):
//   고정된 셀 좌표가 아니라, 라벨 텍스트("문항 번호"/"배점"/"정답"/"파트"/"정답율")로
//   행을 찾은 뒤, 그 오른쪽으로 이어지는 값들을 문항 데이터로 읽는다.
//   (기술설계서 2-2: "행 순서가 아니라 헤더 라벨 텍스트로 판별" 원칙 적용)
const XLSX = require('xlsx');

const LABELS = {
  questionNo: ['문항번호', '문항 번호'],
  point: ['배점'],
  correctAnswer: ['정답'],
  areaTag: ['파트'],
  correctRate: ['정답율', '정답률']
};

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

function findLabelCell(rows, labelVariants, maxRow = 20, maxCol = 20) {
  const targets = labelVariants.map(norm);
  for (let r = 0; r < Math.min(maxRow, rows.length); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < Math.min(maxCol, row.length); c++) {
      if (targets.includes(norm(row[c]))) return { row: r, col: c };
    }
  }
  return null;
}

/**
 * 정답지 시트(2차원 배열)에서 문항별 배점/정답/파트/정답율을 추출한다.
 * @param {any[][]} rows sheet_to_json({header:1}) 결과
 * @returns {Array<{questionNo:number, point:number, correctAnswer:string, areaTag:string, correctRate:number|null}>}
 */
function parseAnswerKeyRows(rows) {
  const qnoCell = findLabelCell(rows, LABELS.questionNo);
  const pointCell = findLabelCell(rows, LABELS.point);
  const answerCell = findLabelCell(rows, LABELS.correctAnswer);
  const areaCell = findLabelCell(rows, LABELS.areaTag);
  const rateCell = findLabelCell(rows, LABELS.correctRate);

  if (!qnoCell || !pointCell || !answerCell) {
    throw new Error('정답지 시트에서 필수 라벨(문항번호/배점/정답)을 찾지 못했습니다. 시트 구조를 확인해주세요.');
  }

  const qnoRow = rows[qnoCell.row] || [];
  const startCol = qnoCell.col + 1;

  // 문항번호 행에서 연속된 숫자가 나오는 동안만 유효 문항으로 인정 (뒤쪽 공백열은 미채점 문항)
  const questionNos = [];
  for (let c = startCol; c < qnoRow.length; c++) {
    const v = qnoRow[c];
    if (v === undefined || String(v).trim() === '') break;
    const n = Number(v);
    if (!Number.isFinite(n)) break;
    questionNos.push({ col: c, questionNo: n });
  }

  const pointRow = rows[pointCell.row] || [];
  const answerRow = rows[answerCell.row] || [];
  const areaRow = areaCell ? (rows[areaCell.row] || []) : [];
  const rateRow = rateCell ? (rows[rateCell.row] || []) : [];

  const entries = questionNos.map(({ col, questionNo }) => {
    const pointRaw = pointRow[col];
    const point = pointRaw === undefined || String(pointRaw).trim() === '' ? null : Number(pointRaw);
    const correctAnswerRaw = answerRow[col];
    const correctAnswer = correctAnswerRaw === undefined ? null : String(correctAnswerRaw).trim().toLowerCase();
    const areaTag = areaCell ? String(areaRow[col] ?? '').trim() || null : null;
    let correctRate = null;
    if (rateCell) {
      const raw = rateRow[col];
      if (raw !== undefined && String(raw).trim() !== '') {
        const s = String(raw).trim();
        correctRate = s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
      }
    }
    return { questionNo, point, correctAnswer, areaTag, correctRate };
  })
  // point가 비어있는 문항(=미채점 대상, 실제 파일에서 41~50번처럼)은 제외
  .filter(e => e.point !== null && Number.isFinite(e.point) && e.correctAnswer);

  return entries;
}

/**
 * 정답지 워크북에서 지정한 시트 이름(또는 인덱스)을 파싱한다.
 * @param {XLSX.WorkBook} workbook
 * @param {string|number} sheetRef 시트 이름 또는 0-based 인덱스
 */
function parseAnswerKeySheet(workbook, sheetRef) {
  const sheetName = typeof sheetRef === 'number' ? workbook.SheetNames[sheetRef] : sheetRef;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`시트를 찾을 수 없습니다: ${sheetRef}`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return parseAnswerKeyRows(rows);
}

/**
 * 시트 번호를 지정하지 않고, 워크북의 모든 시트를 순서대로 시도해 정답지 형식(문항번호/배점/정답 라벨)을
 * 인식하는 첫 시트를 사용한다. 사용자가 여러 시트가 섞인 파일을 올려도 어느 시트인지 직접 몰라도 된다.
 * @param {XLSX.WorkBook} workbook
 */
function parseAnswerKeyWorkbook(workbook) {
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      const entries = parseAnswerKeyRows(rows);
      if (entries.length > 0) return entries;
      errors.push(`[${sheetName}] 라벨은 찾았지만 유효한 문항이 없습니다.`);
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  throw new Error('워크북의 어느 시트에서도 정답지 형식을 인식하지 못했습니다. (' + errors.join(' / ') + ')');
}

module.exports = { parseAnswerKeySheet, parseAnswerKeyWorkbook, parseAnswerKeyRows, findLabelCell };
