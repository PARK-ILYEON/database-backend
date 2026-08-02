// 2부 - OMR 스캐너 결과 파싱
// 실제 파일 구조 (기술설계서 2-0 참고):
//   헤더 행 없음. A열=수험번호, B열=과목코드(1=영어,2=수학), C열~=문항별 마킹(a~e, 공백=미응답)
//   실제 사용 문항 수보다 시트가 더 넓어(최대 70칸), 뒤쪽은 전부 공백으로 남는다.
const XLSX = require('xlsx');

/**
 * 시트 데이터(2차원 배열, header:1)에서 "실제로 쓰인 문항 수"를 판별한다.
 * 규칙: 전체 행에 걸쳐 어떤 열이든 하나라도 값이 있으면 그 열까지는 유효 문항으로 본다.
 * (한 학생이라도 마킹했으면 유효 문항 슬롯으로 인정 — 전원 결시한 문항까지는 못 잡아내지만
 *  실무에서는 트레일링 빈 열 판별이 더 안전하므로, 뒤에서부터 값이 나오는 지점을 찾는다.)
 */
function detectQuestionCount(rows, colOffset) {
  let maxCol = 0;
  for (const row of rows) {
    for (let c = row.length - 1; c >= colOffset; c--) {
      const v = row[c];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        if (c - colOffset + 1 > maxCol) maxCol = c - colOffset + 1;
        break;
      }
    }
  }
  return maxCol;
}

/**
 * OMR 리딩결과 원본 엑셀(Buffer)을 파싱한다.
 * @param {Buffer} fileBuffer
 * @returns {{
 *   subjectCode: number|null,
 *   questionCount: number,
 *   students: Array<{ examNo: string, subjectCode: number, answers: Array<string|null> }>
 * }}
 */
function parseOmrFile(fileBuffer) {
  const wb = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const COL_EXAM_NO = 0; // A
  const COL_SUBJECT = 1; // B
  const COL_ANSWERS_START = 2; // C~

  const dataRows = rows.filter(r => r[COL_EXAM_NO] !== undefined && String(r[COL_EXAM_NO]).trim() !== '');
  const questionCount = detectQuestionCount(dataRows, COL_ANSWERS_START);

  const students = dataRows.map(r => {
    const examNo = String(r[COL_EXAM_NO]).trim();
    const subjectCode = r[COL_SUBJECT] !== undefined && r[COL_SUBJECT] !== '' ? Number(r[COL_SUBJECT]) : null;
    const answers = [];
    for (let q = 0; q < questionCount; q++) {
      const raw = r[COL_ANSWERS_START + q];
      const val = raw === undefined ? '' : String(raw).trim().toLowerCase();
      answers.push(val === '' ? null : val);
    }
    return { examNo, subjectCode, answers };
  });

  // 과목코드는 이 파일 전체에서 하나로 통일되는 것이 정상 (한 회차 = 한 과목의 리딩결과)
  const subjectCodes = [...new Set(students.map(s => s.subjectCode).filter(v => v !== null))];
  const subjectCode = subjectCodes.length === 1 ? subjectCodes[0] : null;

  return {
    subjectCode,
    subjectCodeMismatch: subjectCodes.length > 1 ? subjectCodes : null,
    questionCount,
    students
  };
}

module.exports = { parseOmrFile, detectQuestionCount };
