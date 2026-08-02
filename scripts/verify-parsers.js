// 파서 검증 스크립트 — 실제 파일로 직접 실행해서 파싱 결과를 눈으로 확인할 때 사용합니다.
//
// 사용법:
//   node scripts/verify-parsers.js --omr <OMR리딩결과.xlsx> --workbook <통합성적표.xlsx> [--answerSheet 2] [--rosterSheet 0]
//
// 개발 중 다음 세 파일로 검증했습니다: 실제 OMR 리딩결과 파일(29명 x 50문항),
// 실제 통합워크북(정답지 40문항 + 명단 574명). 결과는 기술설계서 2-0/2-0b의 수치와 정확히 일치했습니다.
const fs = require('fs');
const XLSX = require('xlsx');
const { parseOmrFile } = require('../src/parsers/omrParser');
const { parseAnswerKeySheet } = require('../src/parsers/answerKeyParser');
const { parseRosterSheet } = require('../src/parsers/rosterParser');
const { readWorkbookRobust } = require('../src/parsers/normalizeXlsx');
const { runScoringPipeline } = require('../src/services/scoring');

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const omrPath = getArg('omr');
const workbookPath = getArg('workbook');
const answerSheet = Number(getArg('answerSheet', '2'));
const rosterSheet = Number(getArg('rosterSheet', '0'));

if (!omrPath && !workbookPath) {
  console.log('사용법: node scripts/verify-parsers.js --omr <OMR파일> --workbook <통합워크북파일>');
  process.exit(1);
}

let omrResult = null;
if (omrPath) {
  omrResult = parseOmrFile(fs.readFileSync(omrPath));
  console.log(`[OMR] ${omrPath}`);
  console.log(`  학생 수: ${omrResult.students.length}, 문항 수: ${omrResult.questionCount}, 과목코드: ${omrResult.subjectCode}`);
  console.log(`  첫 학생 예시:`, omrResult.students[0]);
}

let answerKeyEntries = null, rosterStudents = null;
if (workbookPath) {
  const wb = readWorkbookRobust(fs.readFileSync(workbookPath));
  console.log(`\n[통합워크북] ${workbookPath}`);
  console.log('  시트 목록:', wb.SheetNames);

  answerKeyEntries = parseAnswerKeySheet(wb, answerSheet);
  console.log(`  정답지(시트#${answerSheet}): 문항 ${answerKeyEntries.length}개, 영역태그:`, [...new Set(answerKeyEntries.map(e => e.areaTag))]);

  const roster = parseRosterSheet(wb, rosterSheet);
  rosterStudents = roster.students;
  console.log(`  명단(시트#${rosterSheet}): 학생 ${rosterStudents.length}명`);
}

if (omrResult && answerKeyEntries && rosterStudents) {
  const results = runScoringPipeline({ answerKeyEntries, omrStudents: omrResult.students, rosterStudents });
  const matched = results.filter(r => r.nameStatus === 'matched').length;
  console.log(`\n[채점 결과] 총 ${results.length}명, 명단 매칭 ${matched}명`);
  console.log('  상위 3명:', results.slice().sort((a, b) => a.overallRank - b.overallRank).slice(0, 3)
    .map(r => ({ examNo: r.examNo, totalScore: r.totalScore, rank: r.overallRank, percentile: r.percentile, name: r.realName })));
}
