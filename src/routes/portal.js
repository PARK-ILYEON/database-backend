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
     LEFT JOIN rosters r ON r.exam_round_id = er.id
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
        JOIN rosters r2 ON r2.exam_round_id = ss2.exam_round_id
        JOIN roster_entries re2 ON re2.roster_id = r2.id AND re2.exam_no = ss2.exam_no
        WHERE ss2.exam_round_id = ss.exam_round_id AND re2.dept = re.dept AND ss2.total_score > ss.total_score
       )::int AS dept_rank,
       (SELECT COUNT(*) FROM student_scores ss3
        JOIN rosters r3 ON r3.exam_round_id = ss3.exam_round_id
        JOIN roster_entries re3 ON re3.roster_id = r3.id AND re3.exam_no = ss3.exam_no
        WHERE ss3.exam_round_id = ss.exam_round_id AND re3.dept = re.dept
       )::int AS dept_applicants
     FROM student_scores ss
     JOIN exam_rounds er ON er.id = ss.exam_round_id AND er.status='published'
     JOIN rosters r ON r.exam_round_id = er.id
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
