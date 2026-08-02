// 2-1 처리 파이프라인의 "정답지 매칭 → 집계 → 이름 매칭" 단계를 구현한다.
// 입력: parseOmrFile() 결과의 students, parseAnswerKeySheet() 결과(문항별 배점/정답/파트),
//       parseRosterSheet() 결과의 students(수험번호 기준 명단)
// 출력: 학생별 총점/석차/백분율/영역별 점수 + 이름 매칭 결과

/**
 * @param {Array<{questionNo:number, point:number, correctAnswer:string, areaTag:string|null}>} answerKeyEntries
 * @param {Array<{examNo:string, subjectCode:number, answers:Array<string|null>}>} omrStudents
 * @returns {Array<{examNo, subjectCode, totalScore, areaScores, perQuestion, unansweredCount}>}
 */
function scoreStudents(answerKeyEntries, omrStudents) {
  // questionNo(1-based) -> {point, correctAnswer, areaTag}
  const keyByQuestion = new Map(answerKeyEntries.map(e => [e.questionNo, e]));

  return omrStudents.map(student => {
    let totalScore = 0;
    let unansweredCount = 0;
    const areaScores = {}; // { area: {earned, total} }
    const perQuestion = [];

    for (const [questionNo, key] of keyByQuestion) {
      // omr answers 배열은 0-based(문항 index = questionNo-1)
      const studentAnswer = student.answers[questionNo - 1] ?? null;
      const isCorrect = studentAnswer !== null && studentAnswer === key.correctAnswer;
      if (studentAnswer === null) unansweredCount++;
      if (isCorrect) totalScore += key.point;

      const area = key.areaTag || '미분류';
      if (!areaScores[area]) areaScores[area] = { earned: 0, total: 0 };
      areaScores[area].total += key.point;
      if (isCorrect) areaScores[area].earned += key.point;

      perQuestion.push({ questionNo, studentAnswer, correctAnswer: key.correctAnswer, point: key.point, isCorrect, areaTag: key.areaTag });
    }

    return {
      examNo: student.examNo,
      subjectCode: student.subjectCode,
      totalScore: Math.round(totalScore * 10) / 10,
      areaScores,
      perQuestion,
      unansweredCount
    };
  });
}

/**
 * 총점 기준으로 석차(동점 처리)와 백분위를 계산해 각 항목에 붙인다.
 * 석차: 표준경쟁순위(동점자는 같은 순위, 다음 순위는 인원수만큼 건너뜀).
 * 백분위: (본인과 같거나 낮은 점수를 받은 학생 수 / 전체 인원) * 100.
 * @param {Array<{examNo, totalScore}>} scored
 */
function attachRankAndPercentile(scored) {
  const total = scored.length;
  const sortedDesc = [...scored].sort((a, b) => b.totalScore - a.totalScore);

  sortedDesc.forEach((s, idx) => {
    if (idx === 0 || s.totalScore < sortedDesc[idx - 1].totalScore) {
      s.overallRank = idx + 1;
    } else {
      s.overallRank = sortedDesc[idx - 1].overallRank;
    }
  });

  for (const s of sortedDesc) {
    const countLowerOrEqual = scored.filter(o => o.totalScore <= s.totalScore).length;
    s.percentile = total > 0 ? Math.round((countLowerOrEqual / total) * 1000) / 10 : null;
  }

  return scored;
}

/**
 * 채점 결과(examNo 기준)와 명단(examNo 기준)을 조인한다.
 * 매칭 안 되는 수험번호는 nameStatus:'unmatched'로 표시하고 총원에서 제외하지 않는다.
 * @param {Array<object>} scored attachRankAndPercentile()를 거친 배열
 * @param {Array<{examNo, realName, maskedName, dept, track}>} rosterStudents
 */
function joinWithRoster(scored, rosterStudents) {
  const rosterByExamNo = new Map(rosterStudents.map(s => [s.examNo, s]));
  return scored.map(s => {
    const roster = rosterByExamNo.get(s.examNo);
    return {
      ...s,
      nameStatus: roster ? 'matched' : 'unmatched',
      realName: roster ? roster.realName : null,
      maskedName: roster ? roster.maskedName : null,
      dept: roster ? roster.dept : null,
      track: roster ? roster.track : null
    };
  });
}

/**
 * 파이프라인 전체 실행: 채점 → 석차/백분위 → 명단 조인
 */
function runScoringPipeline({ answerKeyEntries, omrStudents, rosterStudents }) {
  const scored = scoreStudents(answerKeyEntries, omrStudents);
  attachRankAndPercentile(scored);
  return joinWithRoster(scored, rosterStudents);
}

module.exports = { scoreStudents, attachRankAndPercentile, joinWithRoster, runScoringPipeline };
