// 이미 채점이 끝난 "결과만 있는" 파일을 그대로 회차 성적으로 업로드할 때 쓰는 파서.
// 정답지/OMR 없이, 수험번호 + 총점(또는 실득점/점수) 컬럼만 있으면 되고
// 백분위/석차는 있으면 같이 쓰고 없어도 무방하다.
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

function parseResultsOnlyRows(rows) {
  let headerRow = -1, examNoCol = null, nameCol = null, scoreCol = null, percentileCol = null, rankCol = null;

  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    const e = findCol(row, ['수험번호']);
    const s = findCol(row, ['총점', '실득점', '점수']);
    if (e !== null && s !== null) {
      headerRow = r; examNoCol = e; scoreCol = s;
      nameCol = findCol(row, ['이름']);
      percentileCol = findCol(row, ['백분위']);
      rankCol = findCol(row, ['석차', '순위', '전체석차']);
      break;
    }
  }

  if (headerRow === -1) {
    throw new Error('시트에서 "수험번호"와 "총점/실득점/점수" 라벨을 찾지 못했습니다.');
  }

  const results = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const examNo = String(row[examNoCol] ?? '').trim();
    if (!examNo) continue;
    const totalScore = toNum(row[scoreCol]);
    if (totalScore === null) continue; // 점수 없는 행은 건너뜀
    results.push({
      examNo,
      realName: nameCol !== null ? (String(row[nameCol] ?? '').trim() || null) : null,
      totalScore,
      percentile: percentileCol !== null ? toNum(row[percentileCol]) : null,
      overallRank: rankCol !== null && toNum(row[rankCol]) !== null ? Math.round(toNum(row[rankCol])) : null
    });
  }

  return results;
}

function parseResultsOnlyWorkbook(workbook) {
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      const results = parseResultsOnlyRows(rows);
      if (results.length > 0) return results;
      errors.push(`[${sheetName}] 라벨은 찾았지만 데이터가 없습니다.`);
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  throw new Error('워크북의 어느 시트에서도 결과 형식을 인식하지 못했습니다. (' + errors.join(' / ') + ')');
}

module.exports = { parseResultsOnlyRows, parseResultsOnlyWorkbook };
