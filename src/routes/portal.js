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

// 학생 포털 - 합격생 DB 대비 위치 비교 (로그인 불필요)
// 이 학생의 외부 모의고사 성적(과목별 최신)을, 합격자명단에 등장한 대학/학과별 합격생들의
// 같은 과목 성적 분포와 비교한다. 개인정보 보호를 위해 합격생 개개인의 이름/아이디는 절대 반환하지 않고
// 대학/학과 단위로 집계된 표본수·최저·평균·최고 백분위만 반환한다.
router.get('/admission-comparison', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const myRows = await fetchExternalMockRows(exam_no);
  const myScoresBySubject = new Map();
  for (const r of myRows) {
    if (!myScoresBySubject.has(r.subject)) {
      myScoresBySubject.set(r.subject, { percentile: r.percentile, rawScore: r.raw_score, examYear: r.exam_year, examMonth: r.exam_month });
    }
  }

  if (myScoresBySubject.size === 0) {
    return res.json({ myScores: [], depts: [], note: '이 수험번호로 매칭되는 외부 모의고사 성적이 없어 비교할 수 없습니다.' });
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

  const latestByIdentitySubject = new Map();
  for (const r of scoreRows) {
    const idKey = r.exam_no || r.student_external_id;
    const key = idKey + '|' + r.subject;
    const prev = latestByIdentitySubject.get(key);
    if (!prev || r.exam_year > prev.exam_year || (r.exam_year === prev.exam_year && r.exam_month > prev.exam_month)) {
      latestByIdentitySubject.set(key, r);
    }
  }

  const mySubjects = [...myScoresBySubject.keys()];
  const byDept = new Map(); // key: univ|||dept -> { univName, deptName, subjectValues: { subject: [percentile,...] } }
  for (const c of cases) {
    const idKey = c.exam_no || c.student_external_id;
    if (!idKey) continue;
    const deptKey = c.univ_name + '|||' + c.dept_name;
    for (const subject of mySubjects) {
      const scoreRow = latestByIdentitySubject.get(idKey + '|' + subject);
      if (!scoreRow || scoreRow.percentile === null || scoreRow.percentile === undefined) continue;
      if (!byDept.has(deptKey)) byDept.set(deptKey, { univName: c.univ_name, deptName: c.dept_name, subjectValues: {} });
      const bucket = byDept.get(deptKey);
      if (!bucket.subjectValues[subject]) bucket.subjectValues[subject] = [];
      bucket.subjectValues[subject].push(Number(scoreRow.percentile));
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

  res.json({
    myScores: [...myScoresBySubject.entries()].map(([subject, v]) => ({ subject, ...v })),
    depts
  });
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
