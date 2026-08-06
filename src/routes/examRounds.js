const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { parseOmrFile } = require('../parsers/omrParser');
const { parseAnswerKeySheet, parseAnswerKeyWorkbook } = require('../parsers/answerKeyParser');
const { parseRosterSheet, parseRosterWorkbook, maskName } = require('../parsers/rosterParser');
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
  // 모든 항목이 비어 있어도 회차가 만들어지도록, 빈 값은 "미지정"/현재 연도 등으로 채워서 진행한다.
  const DEFAULT_TEXT = '미지정';
  const body = req.body || {};
  const academy_name = (body.academy_name && String(body.academy_name).trim()) || DEFAULT_TEXT;
  const professor_name = (body.professor_name && String(body.professor_name).trim()) || DEFAULT_TEXT;
  const class_name = (body.class_name && String(body.class_name).trim()) || DEFAULT_TEXT;
  const round_label = (body.round_label && String(body.round_label).trim()) || DEFAULT_TEXT;
  const exam_date = (body.exam_date && String(body.exam_date).trim()) || null;
  const parsedYear = Number(body.exam_year);
  const exam_year = Number.isFinite(parsedYear) && parsedYear
    ? parsedYear
    : (exam_date ? new Date(exam_date).getFullYear() : new Date().getFullYear());

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
      [classId, round_label, exam_year, exam_date]
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

// 관리자 대시보드 요약 (전체 회차/발행 회차 수, 채점된 학생 수, 최근 회차 평균점수 등)
router.get('/dashboard-summary', async (req, res) => {
  const { rows: countRows } = await db.query(
    `SELECT
       COUNT(*)::int AS round_count,
       COUNT(*) FILTER (WHERE status='published')::int AS published_count,
       COUNT(*) FILTER (WHERE status='draft')::int AS draft_count
     FROM exam_rounds`
  );
  const { rows: studentCountRows } = await db.query(
    `SELECT COUNT(DISTINCT exam_no)::int AS student_count FROM student_scores`
  );
  // 같은 회차명(round_label)+연도를 공유하는 반들은 하나의 시험으로 보고 자동으로 묶어서 보여준다
  // (통합성적표와 기준을 맞추기 위함 — 여러 반이 같은 시험을 나눠 본 경우 합산 인원/평균으로 표시).
  const { rows: recentRounds } = await db.query(
    `SELECT er.round_label, er.exam_year, MAX(er.exam_date) AS exam_date,
            bool_or(er.status='published') AS any_published,
            bool_and(er.status='published') AS all_published,
            array_agg(er.id ORDER BY er.id)::int[] AS exam_round_ids,
            string_agg(DISTINCT p.name || '/' || c.class_name, ', ') AS classes_label,
            COUNT(DISTINCT er.id)::int AS class_count,
            COUNT(ss.id)::int AS student_count,
            ROUND(AVG(ss.total_score)::numeric, 1) AS avg_score
     FROM exam_rounds er
     JOIN classes c ON c.id = er.class_id
     JOIN professors p ON p.id = c.professor_id
     LEFT JOIN student_scores ss ON ss.exam_round_id = er.id
     GROUP BY er.round_label, er.exam_year
     ORDER BY MAX(er.exam_date) DESC NULLS LAST, MAX(er.id) DESC
     LIMIT 5`
  );
  res.json({
    ...countRows[0],
    ...studentCountRows[0],
    recentRounds
  });
});

// 회차별 채점 결과 목록 (성적표/학생관리 화면용)
router.get('/:id/results', async (req, res) => {
  const examRoundId = req.params.id;
  const { rows } = await db.query(
    `SELECT ss.exam_no, ss.total_score, ss.overall_rank, ss.percentile, ss.area_scores, ss.computed_at,
            re.real_name, re.masked_name, re.dept, re.track
     FROM student_scores ss
     LEFT JOIN LATERAL (
       SELECT id FROM rosters r2 WHERE r2.exam_round_id = ss.exam_round_id ORDER BY r2.uploaded_at DESC, r2.id DESC LIMIT 1
     ) r ON true
     LEFT JOIN roster_entries re ON re.roster_id = r.id AND re.exam_no = ss.exam_no
     WHERE ss.exam_round_id = $1
     ORDER BY ss.overall_rank ASC NULLS LAST, ss.total_score DESC`,
    [examRoundId]
  );
  const scores = rows.map(r => Number(r.total_score));
  const summary = {
    studentCount: rows.length,
    avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    minScore: scores.length ? Math.min(...scores) : null,
    unmatchedCount: rows.filter(r => !r.real_name && !r.masked_name).length
  };
  res.json({ examRoundId, summary, students: rows });
});

// 통합 성적표: 여러 회차(반)를 하나로 합쳐 전체 인원 기준으로 등수·백분위를 다시 계산한다.
// 예: 같은 시험을 여러 반이 나눠서 봤을 때, 반을 넘나드는 전체 순위를 보고 싶은 경우.
router.get('/combined-results', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n));
  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids 쿼리 파라미터가 필요합니다 (예: ?ids=1,2,3).' });
  }

  const { rows } = await db.query(
    `SELECT ss.exam_round_id, ss.exam_no, ss.total_score, ss.area_scores,
            er.round_label, er.exam_year, c.class_name, p.name AS professor_name,
            re.real_name, re.masked_name, re.dept, re.track
     FROM student_scores ss
     JOIN exam_rounds er ON er.id = ss.exam_round_id
     JOIN classes c ON c.id = er.class_id
     JOIN professors p ON p.id = c.professor_id
     LEFT JOIN LATERAL (
       SELECT id FROM rosters r2 WHERE r2.exam_round_id = ss.exam_round_id ORDER BY r2.uploaded_at DESC, r2.id DESC LIMIT 1
     ) r ON true
     LEFT JOIN roster_entries re ON re.roster_id = r.id AND re.exam_no = ss.exam_no
     WHERE ss.exam_round_id = ANY($1::int[])
     ORDER BY ss.total_score DESC`,
    [ids]
  );

  // 전체 인원 기준으로 등수(표준경쟁순위)·백분위를 다시 계산
  const total = rows.length;
  rows.forEach((r, idx) => {
    if (idx === 0 || Number(r.total_score) < Number(rows[idx - 1].total_score)) {
      r.combined_rank = idx + 1;
    } else {
      r.combined_rank = rows[idx - 1].combined_rank;
    }
  });
  rows.forEach(r => {
    const countLowerOrEqual = rows.filter(o => Number(o.total_score) <= Number(r.total_score)).length;
    r.combined_percentile = total > 0 ? Math.round((countLowerOrEqual / total) * 1000) / 10 : null;
  });

  const scores = rows.map(r => Number(r.total_score));
  const summary = {
    studentCount: rows.length,
    avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    minScore: scores.length ? Math.min(...scores) : null,
    unmatchedCount: rows.filter(r => !r.real_name && !r.masked_name).length,
    isMerged: ids.length > 1
  };
  res.json({ examRoundIds: ids, summary, students: rows });
});

// 특정 학생의 정오표(문항별 O/X, 배점, 전체 정답률) — 관리자 성적표 화면의 상세 보기용
router.get('/:id/students/:examNo/answers', async (req, res) => {
  const { id, examNo } = req.params;
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
    [id, examNo]
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

// 문항별 정답률 통계 (문항 통계 화면용).
// 같은 회차명(round_label)+연도를 공유하는 반이 있으면 자동으로 합쳐서 전체 정답률을 계산한다
// (통합성적표와 같은 기준: 여러 반이 같은 시험을 나눠 봤으면 그 반들 전체 기준 정답률이 의미 있음).
router.get('/:id/question-stats', async (req, res) => {
  const examRoundId = req.params.id;
  const { rows: siblingRows } = await db.query(
    `SELECT array_agg(er2.id ORDER BY er2.id)::int[] AS ids
     FROM exam_rounds er1
     JOIN exam_rounds er2 ON er2.round_label = er1.round_label AND er2.exam_year = er1.exam_year
     WHERE er1.id = $1`,
    [examRoundId]
  );
  const ids = (siblingRows[0] && siblingRows[0].ids) ? siblingRows[0].ids : [Number(examRoundId)];

  const { rows } = await db.query(
    `SELECT ak.question_no,
            (array_agg(ak.correct_answer))[1] AS correct_answer,
            (array_agg(ak.point))[1] AS point,
            (array_agg(ak.area_tag))[1] AS area_tag,
            COUNT(oa.id) FILTER (WHERE oa.is_correct = true)::int AS correct_count,
            COUNT(oa.id) FILTER (WHERE oa.student_answer IS NOT NULL)::int AS answered_count,
            COUNT(oa.id)::int AS total_count
     FROM answer_keys ak
     LEFT JOIN LATERAL (
       SELECT id FROM omr_uploads o2
       WHERE o2.exam_round_id = ak.exam_round_id AND o2.status='done'
       ORDER BY o2.uploaded_at DESC, o2.id DESC
       LIMIT 1
     ) ou ON true
     LEFT JOIN omr_answers oa ON oa.omr_upload_id = ou.id AND oa.question_no = ak.question_no
     WHERE ak.exam_round_id = ANY($1::int[])
     GROUP BY ak.question_no
     ORDER BY ak.question_no`,
    [ids]
  );
  const questions = rows.map(r => ({
    questionNo: r.question_no,
    correctAnswer: r.correct_answer,
    point: Number(r.point),
    areaTag: r.area_tag,
    correctCount: r.correct_count,
    answeredCount: r.answered_count,
    totalCount: r.total_count,
    correctRate: r.total_count > 0 ? Math.round((r.correct_count / r.total_count) * 1000) / 10 : null
  }));
  res.json({ examRoundId, examRoundIds: ids, classCount: ids.length, questions });
});

// 회차 목록 (교수/연도 필터)
router.get('/', async (req, res) => {
  const { professor, year } = req.query;
  const conditions = [];
  const params = [];
  let sql = `SELECT er.*, c.class_name, p.name AS professor_name, a.name AS academy_name
             FROM exam_rounds er
             JOIN classes c ON c.id = er.class_id
             JOIN professors p ON p.id = c.professor_id
             JOIN academies a ON a.id = c.academy_id`;
  conditions.push(`er.status <> 'deleted'`); // 삭제(소프트 삭제)된 회차는 목록에서 제외
  if (professor) { params.push(professor); conditions.push(`p.name = $${params.length}`); }
  if (year) { params.push(Number(year)); conditions.push(`er.exam_year = $${params.length}`); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY er.exam_date DESC NULLS LAST, er.id DESC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

// 회차 삭제 (소프트 삭제: 실제 행은 지우지 않고 status만 'deleted'로 바꾼다.
// DB에 직접 접속하는 관리자는 이 행을 그대로 조회할 수 있고, 필요하면 status를 되돌려 복구할 수 있다.)
router.delete('/:id', async (req, res) => {
  const { rows } = await db.query(
    `UPDATE exam_rounds SET status='deleted' WHERE id=$1 RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '해당 회차를 찾을 수 없습니다.' });
  res.json({ deleted: true, id: rows[0].id });
});

// 정답지 등록 (엑셀 업로드: sheetIndex로 어느 시트인지 지정, 기본은 3번째 시트)
router.post('/:id/answer-key-upload', upload.single('file'), async (req, res) => {
  const examRoundId = req.params.id;
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  // sheetIndex를 명시적으로 지정한 경우에만 그 시트를 강제로 사용하고,
  // 지정하지 않으면 워크북의 모든 시트를 자동으로 훑어서 정답지 형식을 인식하는 시트를 찾는다.
  const rawSheetIndex = req.body.sheetIndex;
  const parsedSheetIndex = Number(rawSheetIndex);
  const hasExplicitSheetIndex = rawSheetIndex !== undefined && String(rawSheetIndex).trim() !== '' && Number.isFinite(parsedSheetIndex);

  let entries;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    entries = hasExplicitSheetIndex ? parseAnswerKeySheet(wb, parsedSheetIndex) : parseAnswerKeyWorkbook(wb);
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
  // sheetIndex를 명시적으로 지정한 경우에만 그 시트를 강제로 사용하고,
  // 지정하지 않으면 워크북의 모든 시트를 자동으로 훑어서 명단 형식을 인식하는 시트를 찾는다.
  const rawRosterSheetIndex = req.body.sheetIndex;
  const parsedRosterSheetIndex = Number(rawRosterSheetIndex);
  const hasExplicitRosterSheetIndex = rawRosterSheetIndex !== undefined && String(rawRosterSheetIndex).trim() !== '' && Number.isFinite(parsedRosterSheetIndex);

  let students;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    ({ students } = hasExplicitRosterSheetIndex ? parseRosterSheet(wb, parsedRosterSheetIndex) : parseRosterWorkbook(wb));
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
       JOIN (
         SELECT id FROM rosters WHERE exam_round_id = $1 ORDER BY uploaded_at DESC, id DESC LIMIT 1
       ) r ON r.id = re.roster_id`,
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
