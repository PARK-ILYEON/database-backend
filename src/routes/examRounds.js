const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { parseOmrFile } = require('../parsers/omrParser');
const { parseAnswerKeySheet } = require('../parsers/answerKeyParser');
const { parseRosterSheet, maskName } = require('../parsers/rosterParser');
const { readWorkbookRobust } = require('../parsers/normalizeXlsx');
const { runScoringPipeline } = require('../services/scoring');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = express.Router();

// 회차 생성
router.post('/', async (req, res) => {
  const { class_id, round_label, exam_year, exam_date } = req.body;
  if (!class_id || !round_label || !exam_year) {
    return res.status(400).json({ error: 'class_id, round_label, exam_year는 필수입니다.' });
  }
  const { rows } = await db.query(
    `INSERT INTO exam_rounds (class_id, round_label, exam_year, exam_date, status)
     VALUES ($1,$2,$3,$4,'draft') RETURNING *`,
    [class_id, round_label, exam_year, exam_date || null]
  );
  res.status(201).json(rows[0]);
});

// 빠른 회차 생성 — 지점/교수/반 이름만으로 (없으면 자동 생성) 회차까지 한 번에 만든다.
// FK 관계(academies→professors→classes→exam_rounds)를 매번 관리자가 직접 ID로 다루지 않도록
// 화면에서 이름만 입력받아 쓰는 용도.
router.post('/quick-create', async (req, res) => {
  const { academy_name, professor_name, class_name, round_label, exam_year, exam_date } = req.body;
  if (!academy_name || !professor_name || !class_name || !round_label || !exam_year) {
    return res.status(400).json({ error: 'academy_name, professor_name, class_name, round_label, exam_year는 필수입니다.' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    let { rows: acRows } = await client.query('SELECT id FROM academies WHERE name=$1', [academy_name]);
    let academyId = acRows[0] ? acRows[0].id : (await client.query(
      'INSERT INTO academies (name) VALUES ($1) RETURNING id', [academy_name]
    )).rows[0].id;

    let { rows: profRows } = await client.query('SELECT id FROM professors WHERE name=$1', [professor_name]);
    let professorId = profRows[0] ? profRows[0].id : (await client.query(
      'INSERT INTO professors (name) VALUES ($1) RETURNING id', [professor_name]
    )).rows[0].id;

    let { rows: classRows } = await client.query(
      'SELECT id FROM classes WHERE professor_id=$1 AND class_name=$2 AND academy_id=$3',
      [professorId, class_name, academyId]
    );
    let classId = classRows[0] ? classRows[0].id : (await client.query(
      'INSERT INTO classes (professor_id, class_name, academy_id) VALUES ($1,$2,$3) RETURNING id',
      [professorId, class_name, academyId]
    )).rows[0].id;

    const { rows: roundRows } = await client.query(
      `INSERT INTO exam_rounds (class_id, round_label, exam_year, exam_date, status)
       VALUES ($1,$2,$3,$4,'draft') RETURNING *`,
      [classId, round_label, exam_year, exam_date || null]
    );

    await client.query('COMMIT');
    res.status(201).json({ ...roundRows[0], academy_name, professor_name, class_name });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }
});

// 회차 목록 (교수/연도 필터)
router.get('/', async (req, res) => {
  const { professor, year } = req.query;
  const conditions = [];
  const params = [];
  let sql = `SELECT er.*, c.class_name, p.name AS professor_name
             FROM exam_rounds er
             JOIN classes c ON c.id = er.class_id
             JOIN professors p ON p.id = c.professor_id`;
  if (professor) { params.push(professor); conditions.push(`p.name = $${params.length}`); }
  if (year) { params.push(Number(year)); conditions.push(`er.exam_year = $${params.length}`); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY er.exam_date DESC NULLS LAST, er.id DESC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

// 정답지 등록 (엑셀 업로드: sheetIndex로 어느 시트인지 지정, 기본은 3번째 시트)
router.post('/:id/answer-key-upload', upload.single('file'), async (req, res) => {
  const examRoundId = req.params.id;
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const sheetIndex = req.body.sheetIndex !== undefined ? Number(req.body.sheetIndex) : 2;

  let entries;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    entries = parseAnswerKeySheet(wb, sheetIndex);
  } catch (err) {
    return res.status(422).json({ error: '정답지 파싱 실패: ' + err.message });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM answer_keys WHERE exam_round_id=$1', [examRoundId]);
    for (const e of entries) {
      await client.query(
        `INSERT INTO answer_keys (exam_round_id, question_no, point, correct_answer, area_tag)
         VALUES ($1,$2,$3,$4,$5)`,
        [examRoundId, e.questionNo, e.point, e.correctAnswer, e.areaTag]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }

  res.status(201).json({ examRoundId, questionCount: entries.length, entries });
});

// 명단 업로드
router.post('/:id/roster-upload', upload.single('file'), async (req, res) => {
  const examRoundId = req.params.id;
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const sheetIndex = req.body.sheetIndex !== undefined ? Number(req.body.sheetIndex) : 0;

  let students;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    ({ students } = parseRosterSheet(wb, sheetIndex));
  } catch (err) {
    return res.status(422).json({ error: '명단 파싱 실패: ' + err.message });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO rosters (exam_round_id, file_name) VALUES ($1,$2) RETURNING id`,
      [examRoundId, req.file.originalname]
    );
    const rosterId = rows[0].id;
    for (const s of students) {
      await client.query(
        `INSERT INTO roster_entries (roster_id, exam_no, real_name, masked_name, track, dept, round_percentiles)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (roster_id, exam_no) DO NOTHING`,
        [rosterId, s.examNo, s.realName, s.maskedName || maskName(s.realName), s.track, s.dept, JSON.stringify(s.roundPercentiles || {})]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ rosterId, studentCount: students.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }
});

// OMR 업로드 → 파싱 → (정답지가 있으면) 즉시 채점·집계까지 수행
router.post('/:id/omr-upload', upload.single('file'), async (req, res) => {
  const examRoundId = req.params.id;
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

  let omrResult;
  try {
    omrResult = parseOmrFile(req.file.buffer);
  } catch (err) {
    return res.status(422).json({ error: 'OMR 파일 파싱 실패: ' + err.message });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: uploadRows } = await client.query(
      `INSERT INTO omr_uploads (exam_round_id, file_name, subject_code, status, raw_file_path)
       VALUES ($1,$2,$3,'processing',$4) RETURNING id`,
      [examRoundId, req.file.originalname, omrResult.subjectCode, null]
    );
    const omrUploadId = uploadRows[0].id;

    for (const student of omrResult.students) {
      for (let i = 0; i < student.answers.length; i++) {
        const ans = student.answers[i];
        await client.query(
          `INSERT INTO omr_answers (omr_upload_id, exam_no, question_no, student_answer)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (omr_upload_id, exam_no, question_no) DO NOTHING`,
          [omrUploadId, student.examNo, i + 1, ans]
        );
      }
    }

    // 정답지 존재 여부 확인
    const { rows: keyRows } = await client.query(
      'SELECT question_no, point, correct_answer, area_tag FROM answer_keys WHERE exam_round_id=$1 ORDER BY question_no',
      [examRoundId]
    );

    if (keyRows.length === 0) {
      await client.query(
        `UPDATE omr_uploads SET status='processing', error_detail=$2 WHERE id=$1`,
        [omrUploadId, '정답지가 아직 등록되지 않아 채점을 보류합니다. 정답지 등록 후 다시 시도해주세요.']
      );
      await client.query('COMMIT');
      return res.status(202).json({
        omrUploadId,
        status: 'processing',
        message: '정답지가 없어 채점을 보류했습니다. /answer-key-upload 로 정답지를 먼저 등록해주세요.',
        studentCount: omrResult.students.length,
        questionCount: omrResult.questionCount
      });
    }

    const answerKeyEntries = keyRows.map(r => ({
      questionNo: r.question_no, point: Number(r.point), correctAnswer: r.correct_answer, areaTag: r.area_tag
    }));

    const { rows: rosterRows } = await client.query(
      `SELECT re.exam_no, re.real_name, re.masked_name, re.dept, re.track
       FROM roster_entries re
       JOIN rosters r ON r.id = re.roster_id
       WHERE r.exam_round_id = $1`,
      [examRoundId]
    );
    const rosterStudents = rosterRows.map(r => ({
      examNo: r.exam_no, realName: r.real_name, maskedName: r.masked_name, dept: r.dept, track: r.track
    }));

    const results = runScoringPipeline({ answerKeyEntries, omrStudents: omrResult.students, rosterStudents });

    for (const r of results) {
      await client.query(
        `INSERT INTO student_scores (exam_round_id, exam_no, total_score, overall_rank, percentile, area_scores)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (exam_round_id, exam_no)
         DO UPDATE SET total_score=$3, overall_rank=$4, percentile=$5, area_scores=$6, computed_at=now()`,
        [examRoundId, r.examNo, r.totalScore, r.overallRank, r.percentile, JSON.stringify(r.areaScores)]
      );
      // 채점 결과(is_correct)를 omr_answers에 반영
      for (const q of r.perQuestion) {
        await client.query(
          `UPDATE omr_answers SET is_correct=$1 WHERE omr_upload_id=$2 AND exam_no=$3 AND question_no=$4`,
          [q.isCorrect, omrUploadId, r.examNo, q.questionNo]
        );
      }
    }

    await client.query(`UPDATE omr_uploads SET status='done' WHERE id=$1`, [omrUploadId]);
    await client.query('COMMIT');

    const unmatchedCount = results.filter(r => r.nameStatus === 'unmatched').length;
    res.status(201).json({
      omrUploadId,
      status: 'done',
      studentCount: results.length,
      unmatchedCount,
      preview: results.slice(0, 5).map(({ perQuestion, ...rest }) => rest)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장/채점 실패: ' + err.message });
  } finally {
    client.release();
  }
});

// 개별/통합 성적표 발행
router.post('/publish', async (req, res) => {
  const { exam_round_ids } = req.body;
  if (!Array.isArray(exam_round_ids) || exam_round_ids.length === 0) {
    return res.status(400).json({ error: 'exam_round_ids 배열이 필요합니다.' });
  }
  const { rows } = await db.query(
    `UPDATE exam_rounds SET status='published' WHERE id = ANY($1::int[]) RETURNING id, status`,
    [exam_round_ids]
  );
  res.json({ published: rows });
});

module.exports = router;
