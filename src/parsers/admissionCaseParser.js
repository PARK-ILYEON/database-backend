// 합격자명단 파싱.
// 실제 파일 구조 (단일 헤더 행): No / 대학명 / 모집단위 / 편입유형 / 합격여부 / 합격성적 / 이름 / 아이디 / 수강캠퍼스 / 특이사항
// 한 학생이 여러 대학에 합격하면 같은 이름/아이디로 여러 행에 나뉘어 나온다 — 그대로 여러 사례로 저장한다.
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

function parseAdmissionCaseRows(rows) {
  let headerRow = -1;
  let univCol = null, deptCol = null, typeCol = null, resultCol = null, scoreCol = null,
    nameCol = null, idCol = null, examNoCol = null, campusCol = null, noteCol = null;

  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    const u = findCol(row, ['대학명']);
    const d = findCol(row, ['모집단위', '학과', '학과명']);
    if (u !== null && d !== null) {
      headerRow = r;
      univCol = u; deptCol = d;
      typeCol = findCol(row, ['편입유형', '전형유형']);
      resultCol = findCol(row, ['합격여부']);
      scoreCol = findCol(row, ['합격성적', '합격점수']);
      nameCol = findCol(row, ['이름']);
      idCol = findCol(row, ['아이디', 'ID']);
      examNoCol = findCol(row, ['수험번호']); // 있으면 아이디 매핑 없이 바로 수험번호로 매칭 (선택 컬럼)
      campusCol = findCol(row, ['수강캠퍼스', '캠퍼스명']);
      noteCol = findCol(row, ['특이사항']);
      break;
    }
  }

  if (headerRow === -1) {
    throw new Error('시트에서 "대학명"/"모집단위" 라벨을 찾지 못했습니다.');
  }

  const cases = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const univName = String(row[univCol] ?? '').trim();
    const deptName = String(row[deptCol] ?? '').trim();
    if (!univName || !deptName) continue; // 빈 행은 건너뜀
    cases.push({
      univName,
      deptName,
      admissionType: typeCol !== null ? (String(row[typeCol] ?? '').trim() || null) : null,
      resultType: resultCol !== null ? (String(row[resultCol] ?? '').trim() || null) : null,
      admissionScore: scoreCol !== null ? (String(row[scoreCol] ?? '').trim() || null) : null,
      realName: nameCol !== null ? (String(row[nameCol] ?? '').trim() || null) : null,
      studentExternalId: idCol !== null ? (String(row[idCol] ?? '').trim() || null) : null,
      examNo: examNoCol !== null ? (String(row[examNoCol] ?? '').trim() || null) : null,
      sourceCampus: campusCol !== null ? (String(row[campusCol] ?? '').trim() || null) : null,
      note: noteCol !== null ? (String(row[noteCol] ?? '').trim() || null) : null
    });
  }

  return cases;
}

/**
 * 시트 지정 없이 워크북의 모든 시트를 훑어 합격자명단 형식을 인식하는 첫 시트를 사용한다.
 * @param {XLSX.WorkBook} workbook
 */
function parseAdmissionCaseWorkbook(workbook) {
  const errors = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    try {
      const cases = parseAdmissionCaseRows(rows);
      if (cases.length > 0) return cases;
      errors.push(`[${sheetName}] 라벨은 찾았지만 데이터가 없습니다.`);
    } catch (err) {
      errors.push(`[${sheetName}] ${err.message}`);
    }
  }
  throw new Error('워크북의 어느 시트에서도 합격자명단 형식을 인식하지 못했습니다. (' + errors.join(' / ') + ')');
}

module.exports = { parseAdmissionCaseRows, parseAdmissionCaseWorkbook };
