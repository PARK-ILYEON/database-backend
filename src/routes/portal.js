const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const router = express.Router();

// 학생 포털 - 무로그인 수험번호 조회 (발행된 회차만)
router.get('/lookup', async (req, res) => {
  const { exam_no } = req.query;
  if (!exam_no) return res.status(400).json({ error: 'exam_no가 필요합니다.' });

  const { rows } = await db.query(
    `SELECT ss.total_score, ss.overall_rank, ss.percentile, ss.area_scores,
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

// 자가채점 - 이전 제출 기록 재조회
router.get('/self-quiz/:self_exam_no', async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM self_quiz_submissions WHERE self_exam_no=$1 ORDER BY submitted_at DESC',
    [req.params.self_exam_no]
  );
  res.json(rows);
});

module.exports = router;
