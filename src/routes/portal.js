const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const router = express.Router();

// 학생 포털 - 발행된 회차 목록 (자가채점/조회 선택용, 로그인 불필요)
router.get('/published-rounds', async (req, res) => {
  const { rows } = await db.query(
    `SELECT er.id, er.round_label, er.exam_year, er.exam_date,
            c.class_name, p.name AS professor_name,
            (SELECT COUNT(*) FROM answer_keys ak WHERE ak.exam_round_id = er.id)::int AS question_count
     FROM exam_rounds er
     JOIN classes c ON c.id = er.class_id
     JOIN professors p ON p.id = c.professor_id
     WHERE er.status = 'published'
     ORDER BY er.exam_date DESC NULLS LAST, er.id DESC`
  );
  res.json(rows);
});

// "서울시립대"/"서울시립대학교", "숙명여대"/"숙명여자대학교"처럼 파일마다 대학명 표기가 다른 경우가 있어서,
// 매칭할 때는 흔한 접미사(대학교/여자대학교/여대/대학/대)와 괄호(캠퍼스 표기 등)를 뗀 값으로 비교한다.
function normalizeUnivName(name) {
  let s = String(name ?? '').replace(/\s+/g, '');
  s = s.replace(/\([^)]*\)/g, ''); // "고려대(서울)" -> "고려대"
  s = s.replace(/외대$/, '외국어대학교'); // "한국외대" -> "한국외국어대학교" (단순 접미사 제거로는 안 잡히는 축약)
  const suffixes = ['여자대학교', '대학교', '여대', '대학', '대'];
  for (const suf of suffixes) {
    if (s.length > suf.length && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

// 학과명도 파일마다 "학과/학부/전공" 표기가 섞여 있어서 흔한 접미사만 보수적으로 뗀다.
// (대학명과 달리 학과 종류가 매우 다양하므로, 잘못된 매칭을 피하기 위해 이 접미사들만 제거하고 나머지는 그대로 둔다.)
function normalizeDeptName(name) {
  let s = String(name ?? '').replace(/\s+/g, '');
  const suffixes = ['학전공', '학과', '학부', '전공'];
  for (const suf of suffixes) {
    if (s.length > suf.length && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

// 대학DB(university_master)에서 그 학과의 최근 모집인원/지원인원 정보를 붙여준다 (참고용 컨텍스트).
// group.depts 형태(배열 안에 { depts: [...] } 객체들)를 받아 그 안의 각 dept 객체에 univInfo를 채워 넣는다.
async function attachUnivInfo(groups) {
  const allDepts = [];
  for (const group of groups) {
    if (group && Array.isArray(group.depts)) allDepts.push(...group.depts);
  }
  if (allDepts.length === 0) return;

  const { rows } = await db.query(
    `SELECT DISTINCT ON (univ_name, dept_name) univ_name, dept_name, year, quota_general, applicants_general,
            track, college, combined_flag
     FROM university_master
     ORDER BY univ_name, dept_name, year DESC`
  );
  // 정규화하면 같은 대학+학과로 묶이는 행이 여러 개일 수 있다(예: "서울시립대학교"로 개별 등록된 옛날 행 +
  // "서울시립대"로 새로 올라온 경쟁률 행, 또는 "행정학과"/"행정학부"). 이 경우 지원인원(applicants_general)
  // 값이 있는 쪽을 우선한다.
  const infoMap = new Map();
  for (const r of rows) {
    const key = normalizeUnivName(r.univ_name) + '|||' + normalizeDeptName(r.dept_name);
    const prev = infoMap.get(key);
    if (!prev || (r.applicants_general !== null && prev.applicants_general === null)) {
      infoMap.set(key, r);
    }
  }

  // 학사편입 경쟁률(university_academic_competition)은 같은 학과라도 전형별로 여러 줄일 수 있어
  // 일반처럼 하나로 합치지 않고, 매칭되는 줄을 전부 모아 배열로 붙여준다.
  const { rows: academicRows } = await db.query(
    `SELECT univ_name, dept_name, year, track, college, quota_academic, applicants_academic, combined_flag
     FROM university_academic_competition
     ORDER BY univ_name, dept_name, id`
  );
  const academicMap = new Map();
  for (const r of academicRows) {
    const key = normalizeUnivName(r.univ_name) + '|||' + normalizeDeptName(r.dept_name);
    if (!academicMap.has(key)) academicMap.set(key, []);
    academicMap.get(key).push(r);
  }

  for (const dept of allDepts) {
    const key = normalizeUnivName(dept.univName) + '|||' + normalizeDeptName(dept.deptName);
    const info = infoMap.get(key);
    if (info) {
      const quota = info.quota_general !== null ? Number(info.quota_general) : null;
      const applicants = info.applicants_general !== null ? Number(info.applicants_general) : null;
      dept.univInfo = {
        year: info.year,
        quotaGeneral: quota,
        applicantsGeneral: applicants,
        competitionRatio: (quota && applicants) ? Math.round((applicants / quota) * 100) / 100 : null,
        track: info.track,
        college: info.college,
        isCombinedSelection: info.combined_flag
      };
    }

    const academicEntries = academicMap.get(key);
    if (academicEntries && academicEntries.length > 0) {
      if (!dept.univInfo) dept.univInfo = {};
      let totalQuota = 0, totalApplicants = 0, hasQuota = false, hasApplicants = false;
      const entries = academicEntries.map(r => {
        const quota = r.quota_academic !== null ? Number(r.quota_academic) : null;
        const applicants = r.applicants_academic !== null ? Number(r.applicants_academic) : null;
        if (quota !== null) { totalQuota += quota; hasQuota = true; }
        if (applicants !== null) { totalApplicants += applicants; hasApplicants = true; }
        return {
          quotaAcademic: quota,
          applicantsAcademic: applicants,
          competitionRatio: (quota && applicants) ? Math.round((applicants / quota) * 100) / 100 : null,
          isCombinedSelection: r.combined_flag
        };
      });
      dept.univInfo.academic = {
        year: academicEntries[0].year,
        entries,
        totalQuota: hasQuota ? totalQuota : null,
        totalApplicants: hasApplicants ? totalApplicants : null,
        totalCompetitionRatio: (hasQuota && totalQuota && hasApplicants) ? Math.round((totalApplicants / totalQuota) * 100) / 100 : null
      };
    }
  }
}

// 이 수험번호의 외부 모의고사(편입모의고사 등) 성적 전체 행을 가져온다.
// 성적 파일에 수험번호가 직접 있으면 그걸로 바로 찾고, 없으면 명단 업로드로 쌓인 아이디 매핑을 거친다.
async function fetchExternalMockRows(examNo) {
  const { rows: directRows } = await db.query(
    `SELECT s.subject, s.raw_score, s.percentile, s.overall_rank, s.class_rank, s.class_applicants,
            s.track_rank, s.track_applicants, r.exam_year, r.exam_month, r.label
     FROM external_mock_scores s
     JOIN external_mock_rounds r ON r.id = s.round_id
     WHERE s.exam_no = $1
     ORDER BY r.exam_year DESC, r.exam_month DESC, s.subject`,
    [examNo]
  );
  if (directRows.length > 0) return directRows;

  const { rows: mapRows } = await db.query('SELECT student_external_id FROM student_external_id_map WHERE exam_no=$1', [examNo]);
  if (mapRows.length === 0) return [];

  const { rows } = await db.query(
    `SELECT s.subject, s.raw_score, s.percentile, s.overall_rank, s.class_rank, s.class_applicants,
            s.track_rank, s.track_applicants, r.exam_year, r.exam_month, r.label
     FROM external_mock_scores s
     JOIN external_mock_rounds r ON r.id = s.round_id
     WHERE s.student_external_id = $1
     ORDER BY r.exam_year DESC, r.exam_month DESC, s.subject`,
    [mapRows[0].student_external_id]
  );
  return rows;
}

// 학생 포털 - 외부 모의고사(편입모의고사 등) 성적 목록 (로그인 불필요)
router.get('/external-mock-scores', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });
  const rows = await fetchExternalMockRows(exam_no);
  res.json(rows.map(r => ({
    subject: r.subject, rawScore: r.raw_score, percentile: r.percentile,
    overallRank: r.overall_rank, classRank: r.class_rank, classApplicants: r.class_applicants,
    trackRank: r.track_rank, trackApplicants: r.track_applicants,
    examYear: r.exam_year, examMonth: r.exam_month, label: r.label
  })));
});

// 합격생 성적 분포(대학/학과 단위 표본수·최저·평균·최고 백분위)를 계산한다.
// 개인정보 보호를 위해 합격생 개개인의 이름/아이디는 절대 반환하지 않는다.
function buildAdmissionDepts(cases, scoreRows, compareYear, compareMonth, myScoresBySubject) {
  const byIdentitySubject = new Map(); // idKey|subject -> percentile
  for (const r of scoreRows) {
    if (r.exam_year !== compareYear || r.exam_month !== compareMonth) continue;
    if (r.percentile === null || r.percentile === undefined) continue;
    const idKey = r.exam_no || r.student_external_id;
    byIdentitySubject.set(idKey + '|' + r.subject, Number(r.percentile));
  }

  const mySubjects = [...myScoresBySubject.keys()];
  const byDept = new Map(); // key: univ|||dept -> { univName, deptName, subjectValues: { subject: [percentile,...] } }
  for (const c of cases) {
    const idKey = c.exam_no || c.student_external_id;
    if (!idKey) continue;
    const deptKey = c.univ_name + '|||' + c.dept_name;
    for (const subject of mySubjects) {
      const val = byIdentitySubject.get(idKey + '|' + subject);
      if (val === undefined) continue;
      if (!byDept.has(deptKey)) byDept.set(deptKey, { univName: c.univ_name, deptName: c.dept_name, subjectValues: {} });
      const bucket = byDept.get(deptKey);
      if (!bucket.subjectValues[subject]) bucket.subjectValues[subject] = [];
      bucket.subjectValues[subject].push(val);
    }
  }

  const depts = [];
  for (const bucket of byDept.values()) {
    const distribution = Object.entries(bucket.subjectValues).map(([subject, values]) => {
      values.sort((a, b) => a - b);
      const n = values.length;
      const sum = values.reduce((a, b) => a + b, 0);
      const mine = myScoresBySubject.get(subject);
      return {
        subject, n,
        minPercentile: values[0], avgPercentile: Math.round((sum / n) * 10) / 10, maxPercentile: values[n - 1],
        myPercentile: mine ? mine.percentile : null
      };
    });
    depts.push({ univName: bucket.univName, deptName: bucket.deptName, distribution });
  }

  // 합격생 평균(백분위)이 높은 순으로 정렬
  depts.sort((a, b) => {
    const aAvg = Math.max(...a.distribution.map(d => d.avgPercentile));
    const bAvg = Math.max(...b.distribution.map(d => d.avgPercentile));
    return bAvg - aAvg;
  });
  return depts;
}

// 학생 포털 - 합격생 DB 대비 위치 비교 (로그인 불필요)
// 이 학생이 응시한 "월"마다 따로, 같은 달(1년 전) 합격생들의 성적 분포와 비교한다.
// (예: 올해 7월 성적 -> 작년 7월 합격생 성적과 비교. 합격자명단은 합격 전 준비 기간의
//  성적으로 매칭돼야 의미가 있으므로, 최신 성적 1개만 보는 게 아니라 응시월별로 각각 비교한다.)
router.get('/admission-comparison', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const myRows = await fetchExternalMockRows(exam_no);
  if (myRows.length === 0) {
    return res.json({ monthly: [], note: '이 수험번호로 매칭되는 외부 모의고사 성적이 없어 비교할 수 없습니다.' });
  }

  // 내 성적을 응시 (연도, 월)별로 묶는다 - 최신 것만이 아니라 응시한 모든 월을 각각 비교한다.
  const monthKeys = [];
  const myByMonth = new Map(); // key: year|month -> { examYear, examMonth, scoresBySubject: Map }
  for (const r of myRows) {
    const key = r.exam_year + '|' + r.exam_month;
    if (!myByMonth.has(key)) {
      myByMonth.set(key, { examYear: r.exam_year, examMonth: r.exam_month, scoresBySubject: new Map() });
      monthKeys.push(key);
    }
    myByMonth.get(key).scoresBySubject.set(r.subject, { percentile: r.percentile, rawScore: r.raw_score });
  }

  const { rows: cases } = await db.query(
    `SELECT univ_name, dept_name, student_external_id, exam_no
     FROM admission_cases WHERE student_external_id IS NOT NULL OR exam_no IS NOT NULL`
  );
  const examNos = [...new Set(cases.map(c => c.exam_no).filter(Boolean))];
  const externalIds = [...new Set(cases.map(c => c.student_external_id).filter(Boolean))];

  let scoreRows = [];
  if (examNos.length > 0 || externalIds.length > 0) {
    const { rows } = await db.query(
      `SELECT s.student_external_id, s.exam_no, s.subject, s.percentile, r.exam_year, r.exam_month
       FROM external_mock_scores s
       JOIN external_mock_rounds r ON r.id = s.round_id
       WHERE s.exam_no = ANY($1::text[]) OR s.student_external_id = ANY($2::text[])`,
      [examNos, externalIds]
    );
    scoreRows = rows;
  }

  const monthly = monthKeys.map(key => {
    const m = myByMonth.get(key);
    const compareYear = m.examYear - 1; // 작년 같은 달 합격생 성적과 비교
    const depts = buildAdmissionDepts(cases, scoreRows, compareYear, m.examMonth, m.scoresBySubject);
    return {
      examYear: m.examYear,
      examMonth: m.examMonth,
      compareYear,
      compareMonth: m.examMonth,
      myScores: [...m.scoresBySubject.entries()].map(([subject, v]) => ({ subject, ...v })),
      depts,
      note: depts.length === 0 ? `${compareYear}년 ${m.examMonth}월 시점 합격생 비교 데이터가 없습니다.` : null
    };
  });

  monthly.sort((a, b) => b.examYear - a.examYear || b.examMonth - a.examMonth);
  await attachUnivInfo(monthly);

  res.json({ monthly });
});

// ---------- 동일 기출문제 재시험 비교 (기존 합격생 비교와 별개 기능, 원점수 기준) ----------
// 올해 학생이 작년 특정월 문제(기출)를 그대로 다시 풀면, 그 기출문제가 원래 시행됐던 회차(external_mock_scores)에
// 있는 합격생들의 성적과 "같은 문제 기준"으로 비교한다. 같은 문제이므로 백분위보다 원점수 비교가 더 정확하다.

async function fetchRetestRows(examNo) {
  const { rows: directRows } = await db.query(
    `SELECT s.subject, s.raw_score, s.percentile, rr.source_exam_year, rr.source_exam_month,
            rr.retest_year, rr.retest_month, rr.label
     FROM retest_scores s
     JOIN retest_rounds rr ON rr.id = s.retest_round_id
     WHERE s.exam_no = $1
     ORDER BY rr.retest_year DESC, rr.retest_month DESC NULLS LAST, s.subject`,
    [examNo]
  );
  if (directRows.length > 0) return directRows;

  const { rows: mapRows } = await db.query('SELECT student_external_id FROM student_external_id_map WHERE exam_no=$1', [examNo]);
  if (mapRows.length === 0) return [];

  const { rows } = await db.query(
    `SELECT s.subject, s.raw_score, s.percentile, rr.source_exam_year, rr.source_exam_month,
            rr.retest_year, rr.retest_month, rr.label
     FROM retest_scores s
     JOIN retest_rounds rr ON rr.id = s.retest_round_id
     WHERE s.student_external_id = $1
     ORDER BY rr.retest_year DESC, rr.retest_month DESC NULLS LAST, s.subject`,
    [mapRows[0].student_external_id]
  );
  return rows;
}

// 합격생들의 "그 기출문제 원래 회차" 원점수 분포(대학/학과 단위)를 계산한다. 개인 식별정보는 반환하지 않는다.
function buildRetestDepts(cases, historicalScoreRows, sourceYear, sourceMonth, myScoresBySubject) {
  const byIdentitySubject = new Map(); // idKey|subject -> rawScore
  for (const r of historicalScoreRows) {
    if (r.exam_year !== sourceYear || r.exam_month !== sourceMonth) continue;
    if (r.raw_score === null || r.raw_score === undefined) continue;
    const idKey = r.exam_no || r.student_external_id;
    byIdentitySubject.set(idKey + '|' + r.subject, Number(r.raw_score));
  }

  const mySubjects = [...myScoresBySubject.keys()];
  const byDept = new Map();
  for (const c of cases) {
    const idKey = c.exam_no || c.student_external_id;
    if (!idKey) continue;
    const deptKey = c.univ_name + '|||' + c.dept_name;
    for (const subject of mySubjects) {
      const val = byIdentitySubject.get(idKey + '|' + subject);
      if (val === undefined) continue;
      if (!byDept.has(deptKey)) byDept.set(deptKey, { univName: c.univ_name, deptName: c.dept_name, subjectValues: {} });
      const bucket = byDept.get(deptKey);
      if (!bucket.subjectValues[subject]) bucket.subjectValues[subject] = [];
      bucket.subjectValues[subject].push(val);
    }
  }

  const depts = [];
  for (const bucket of byDept.values()) {
    const distribution = Object.entries(bucket.subjectValues).map(([subject, values]) => {
      values.sort((a, b) => a - b);
      const n = values.length;
      const sum = values.reduce((a, b) => a + b, 0);
      const mine = myScoresBySubject.get(subject);
      return {
        subject, n,
        minRawScore: values[0], avgRawScore: Math.round((sum / n) * 10) / 10, maxRawScore: values[n - 1],
        myRawScore: mine ? mine.rawScore : null
      };
    });
    depts.push({ univName: bucket.univName, deptName: bucket.deptName, distribution });
  }
  depts.sort((a, b) => {
    const aAvg = Math.max(...a.distribution.map(d => d.avgRawScore));
    const bAvg = Math.max(...b.distribution.map(d => d.avgRawScore));
    return bAvg - aAvg;
  });
  return depts;
}

router.get('/retest-comparison', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const myRows = await fetchRetestRows(exam_no);
  if (myRows.length === 0) {
    return res.json({ retests: [] });
  }

  // 재시험 회차별(같은 기출연월 기준)로 묶는다.
  const roundKeys = [];
  const myByRound = new Map(); // key: sourceYear|sourceMonth|retestYear|retestMonth -> {..., scoresBySubject}
  for (const r of myRows) {
    const key = r.source_exam_year + '|' + r.source_exam_month + '|' + r.retest_year + '|' + r.retest_month + '|' + (r.label || '');
    if (!myByRound.has(key)) {
      myByRound.set(key, {
        sourceYear: r.source_exam_year, sourceMonth: r.source_exam_month,
        retestYear: r.retest_year, retestMonth: r.retest_month, label: r.label,
        scoresBySubject: new Map()
      });
      roundKeys.push(key);
    }
    myByRound.get(key).scoresBySubject.set(r.subject, { rawScore: r.raw_score, percentile: r.percentile });
  }

  const { rows: cases } = await db.query(
    `SELECT univ_name, dept_name, student_external_id, exam_no
     FROM admission_cases WHERE student_external_id IS NOT NULL OR exam_no IS NOT NULL`
  );
  const examNos = [...new Set(cases.map(c => c.exam_no).filter(Boolean))];
  const externalIds = [...new Set(cases.map(c => c.student_external_id).filter(Boolean))];

  let scoreRows = [];
  if (examNos.length > 0 || externalIds.length > 0) {
    const { rows } = await db.query(
      `SELECT s.student_external_id, s.exam_no, s.subject, s.raw_score, r.exam_year, r.exam_month
       FROM external_mock_scores s
       JOIN external_mock_rounds r ON r.id = s.round_id
       WHERE s.exam_no = ANY($1::text[]) OR s.student_external_id = ANY($2::text[])`,
      [examNos, externalIds]
    );
    scoreRows = rows;
  }

  const retests = roundKeys.map(key => {
    const m = myByRound.get(key);
    const depts = buildRetestDepts(cases, scoreRows, m.sourceYear, m.sourceMonth, m.scoresBySubject);
    return {
      sourceYear: m.sourceYear,
      sourceMonth: m.sourceMonth,
      retestYear: m.retestYear,
      retestMonth: m.retestMonth,
      label: m.label,
      myScores: [...m.scoresBySubject.entries()].map(([subject, v]) => ({ subject, ...v })),
      depts,
      note: depts.length === 0 ? `${m.sourceYear}년 ${m.sourceMonth}월 기출 원래 회차의 합격생 비교 데이터가 없습니다.` : null
    };
  });

  retests.sort((a, b) => (b.retestYear - a.retestYear) || ((b.retestMonth || 0) - (a.retestMonth || 0)));
  await attachUnivInfo(retests);

  res.json({ retests });
});

// 자가채점용 문항 목록 (정답 제외, 문항번호/배점/파트만)
router.get('/rounds/:id/questions', async (req, res) => {
  const { rows } = await db.query(
    `SELECT question_no, point, area_tag FROM answer_keys WHERE exam_round_id=$1 ORDER BY question_no`,
    [req.params.id]
  );
  res.json(rows.map(r => ({ questionNo: r.question_no, point: Number(r.point), areaTag: r.area_tag })));
});

// 학생 포털 - 무로그인 수험번호 조회 (발행된 회차만)
router.get('/lookup', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const { rows } = await db.query(
    `SELECT er.id AS exam_round_id, ss.total_score, ss.overall_rank, ss.percentile, ss.area_scores,
            er.round_label, er.exam_year, er.exam_date,
            re.real_name, re.masked_name
     FROM student_scores ss
     JOIN exam_rounds er ON er.id = ss.exam_round_id AND er.status = 'published'
     LEFT JOIN LATERAL (
       SELECT id FROM rosters r2 WHERE r2.exam_round_id = er.id ORDER BY r2.uploaded_at DESC, r2.id DESC LIMIT 1
     ) r ON true
     LEFT JOIN roster_entries re ON re.roster_id = r.id AND re.exam_no = ss.exam_no
     WHERE ss.exam_no = $1
     ORDER BY er.exam_date ASC NULLS LAST`,
    [exam_no]
  );
  res.json(rows);
});

// 학생 포털 - 오답노트 (누적 발행 회차 중 오답률 상위 5문항, 로그인 불필요)
router.get('/wrong-questions', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const { rows } = await db.query(
    `SELECT er.round_label, er.exam_year, oa.question_no, ak.point, ak.area_tag, ak.correct_answer, oa.student_answer,
            stats.correct_count, stats.total_count
     FROM omr_answers oa
     JOIN omr_uploads ou ON ou.id = oa.omr_upload_id
     JOIN exam_rounds er ON er.id = ou.exam_round_id AND er.status = 'published'
     JOIN answer_keys ak ON ak.exam_round_id = er.id AND ak.question_no = oa.question_no
     JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE oa2.is_correct)::int AS correct_count, COUNT(*)::int AS total_count
       FROM omr_answers oa2
       WHERE oa2.omr_upload_id = ou.id AND oa2.question_no = oa.question_no
     ) stats ON true
     WHERE oa.exam_no = $1 AND oa.is_correct = false
     ORDER BY (stats.correct_count::float / NULLIF(stats.total_count,0)) ASC
     LIMIT 5`,
    [exam_no]
  );
  res.json(rows.map(r => ({
    roundLabel: r.round_label,
    examYear: r.exam_year,
    questionNo: r.question_no,
    point: Number(r.point),
    areaTag: r.area_tag,
    correctAnswer: r.correct_answer,
    studentAnswer: r.student_answer,
    correctRate: r.total_count > 0 ? Math.round((r.correct_count / r.total_count) * 1000) / 10 : null
  })));
});

// 학생 포털 - 희망학과 기준 석차 (가장 최근 발행 회차, 로그인 불필요)
router.get('/dept-rank', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const { rows } = await db.query(
    `SELECT er.id AS exam_round_id, er.round_label, er.exam_year, re.dept, ss.total_score,
       (SELECT COUNT(*)+1 FROM student_scores ss2
        JOIN LATERAL (
          SELECT id FROM rosters r2b WHERE r2b.exam_round_id = ss2.exam_round_id ORDER BY r2b.uploaded_at DESC, r2b.id DESC LIMIT 1
        ) r2 ON true
        JOIN roster_entries re2 ON re2.roster_id = r2.id AND re2.exam_no = ss2.exam_no
        WHERE ss2.exam_round_id = ss.exam_round_id AND re2.dept = re.dept AND ss2.total_score > ss.total_score
       )::int AS dept_rank,
       (SELECT COUNT(*) FROM student_scores ss3
        JOIN LATERAL (
          SELECT id FROM rosters r3b WHERE r3b.exam_round_id = ss3.exam_round_id ORDER BY r3b.uploaded_at DESC, r3b.id DESC LIMIT 1
        ) r3 ON true
        JOIN roster_entries re3 ON re3.roster_id = r3.id AND re3.exam_no = ss3.exam_no
        WHERE ss3.exam_round_id = ss.exam_round_id AND re3.dept = re.dept
       )::int AS dept_applicants
     FROM student_scores ss
     JOIN exam_rounds er ON er.id = ss.exam_round_id AND er.status='published'
     JOIN LATERAL (
       SELECT id FROM rosters r2c WHERE r2c.exam_round_id = er.id ORDER BY r2c.uploaded_at DESC, r2c.id DESC LIMIT 1
     ) r ON true
     JOIN roster_entries re ON re.roster_id = r.id AND re.exam_no = ss.exam_no
     WHERE ss.exam_no = $1 AND re.dept IS NOT NULL AND re.dept <> ''
     ORDER BY er.exam_date DESC NULLS LAST, er.id DESC
     LIMIT 1`,
    [exam_no]
  );
  if (rows.length === 0) return res.json(null);
  const r = rows[0];
  res.json({
    roundLabel: r.round_label, examYear: r.exam_year, dept: r.dept,
    deptRank: r.dept_rank, deptApplicants: r.dept_applicants
  });
});

// 학생 포털 - 특정 회차 기준 학과별/계열별 석차 (통합성적표처럼 같은 회차명+연도를 공유하는
// 반이 여러 개면 그 전체를 합친 인원 기준으로 계산한다. 명단이 여러 번 올라간 반이 있어도
// 항상 가장 최근 명단 하나만 사용한다.)
router.get('/rounds/:id/dept-track-rank', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const { rows } = await db.query(
    `SELECT ss.exam_no, ss.total_score, re.dept, re.track
     FROM student_scores ss
     JOIN exam_rounds er ON er.id = ss.exam_round_id
     JOIN exam_rounds er0 ON er0.id = $1
     LEFT JOIN LATERAL (
       SELECT id FROM rosters r2 WHERE r2.exam_round_id = ss.exam_round_id ORDER BY r2.uploaded_at DESC, r2.id DESC LIMIT 1
     ) ros ON true
     LEFT JOIN roster_entries re ON re.roster_id = ros.id AND re.exam_no = ss.exam_no
     WHERE er.round_label = er0.round_label AND er.exam_year = er0.exam_year`,
    [req.params.id]
  );

  const target = rows.find(r => r.exam_no === exam_no);
  if (!target) return res.json(null);

  const result = { dept: target.dept || null, track: target.track || null };
  if (target.dept) {
    const peers = rows.filter(r => r.dept === target.dept);
    result.deptRank = peers.filter(r => Number(r.total_score) > Number(target.total_score)).length + 1;
    result.deptApplicants = peers.length;
  }
  if (target.track) {
    const peers = rows.filter(r => r.track === target.track);
    result.trackRank = peers.filter(r => Number(r.total_score) > Number(target.total_score)).length + 1;
    result.trackApplicants = peers.length;
  }
  res.json(result);
});

// 학생 포털 - 정오표(문항별 O/X, 발행된 회차만, 로그인 불필요)
router.get('/rounds/:id/student-answers', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const { rows: roundRows } = await db.query(`SELECT id FROM exam_rounds WHERE id=$1 AND status='published'`, [req.params.id]);
  if (roundRows.length === 0) return res.status(404).json({ error: '발행되지 않은 회차입니다.' });

  const { rows } = await db.query(
    `SELECT ak.question_no, ak.point, ak.area_tag, ak.correct_answer, oa.student_answer, oa.is_correct,
            stats.correct_count, stats.total_count
     FROM answer_keys ak
     LEFT JOIN LATERAL (
       SELECT id FROM omr_uploads o2
       WHERE o2.exam_round_id = ak.exam_round_id AND o2.status = 'done'
       ORDER BY o2.uploaded_at DESC, o2.id DESC
       LIMIT 1
     ) ou ON true
     LEFT JOIN omr_answers oa ON oa.omr_upload_id = ou.id AND oa.question_no = ak.question_no AND oa.exam_no = $2
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE oa2.is_correct)::int AS correct_count, COUNT(*)::int AS total_count
       FROM omr_answers oa2
       WHERE oa2.omr_upload_id = ou.id AND oa2.question_no = ak.question_no
     ) stats ON true
     WHERE ak.exam_round_id = $1
     ORDER BY ak.question_no`,
    [req.params.id, exam_no]
  );
  res.json(rows.map(r => ({
    questionNo: r.question_no,
    point: Number(r.point),
    areaTag: r.area_tag,
    correctAnswer: r.correct_answer,
    studentAnswer: r.student_answer,
    isCorrect: r.is_correct,
    correctRate: r.total_count > 0 ? Math.round((r.correct_count / r.total_count) * 1000) / 10 : null
  })));
});

// 자가채점 - 임시 수험번호 발급
router.post('/self-quiz/issue', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name이 필요합니다.' });
  const selfExamNo = 'SELF' + crypto.randomBytes(4).toString('hex').toUpperCase(); // 8자리 영숫자
  res.status(201).json({ selfExamNo, name });
});

// 자가채점 제출 → 즉시 채점
router.post('/self-quiz/submit', async (req, res) => {
  const { self_exam_no, name, exam_round_id, answers } = req.body;
  if (!self_exam_no || !exam_round_id || !answers) {
    return res.status(400).json({ error: 'self_exam_no, exam_round_id, answers가 필요합니다.' });
  }

  const { rows: keyRows } = await db.query(
    'SELECT question_no, point, correct_answer, area_tag FROM answer_keys WHERE exam_round_id=$1 ORDER BY question_no',
    [exam_round_id]
  );
  if (keyRows.length === 0) return res.status(422).json({ error: '이 회차는 아직 정답지가 등록되지 않았습니다.' });

  let totalScore = 0;
  const areaScores = {};
  for (const k of keyRows) {
    const studentAnswer = answers[String(k.question_no)] || null;
    const isCorrect = studentAnswer && studentAnswer === k.correct_answer;
    if (isCorrect) totalScore += Number(k.point);
    const area = k.area_tag || '미분류';
    if (!areaScores[area]) areaScores[area] = { earned: 0, total: 0 };
    areaScores[area].total += Number(k.point);
    if (isCorrect) areaScores[area].earned += Number(k.point);
  }

  const { rows } = await db.query(
    `INSERT INTO self_quiz_submissions (self_exam_no, name, exam_round_id, answers, total_score, area_scores)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [self_exam_no, name, exam_round_id, JSON.stringify(answers), Math.round(totalScore * 10) / 10, JSON.stringify(areaScores)]
  );
  res.status(201).json(rows[0]);
});

// 자가채점 - 이전 제출 기록 재조회 (일반 성적조회 화면과 같은 모양으로 반환)
router.get('/self-quiz/:self_exam_no', async (req, res) => {
  const { rows } = await db.query(
    `SELECT sq.self_exam_no, sq.name, sq.total_score, sq.area_scores, sq.submitted_at,
            er.round_label, er.exam_year
     FROM self_quiz_submissions sq
     LEFT JOIN exam_rounds er ON er.id = sq.exam_round_id
     WHERE sq.self_exam_no=$1
     ORDER BY sq.submitted_at DESC`,
    [req.params.self_exam_no]
  );
  res.json(rows.map(r => ({
    exam_year: r.exam_year,
    round_label: r.round_label || '(자가채점)',
    total_score: r.total_score,
    overall_rank: null,
    percentile: null,
    area_scores: r.area_scores,
    real_name: r.name,
    masked_name: null
  })));
});

module.exports = router;
