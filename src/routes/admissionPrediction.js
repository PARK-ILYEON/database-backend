// 합격 예측(참고) 기능 — 과거 합격자명단 + 외부(편입모의고사 등) 성적을 관리하고,
// 대학/학과별 합격생 성적 분포 대비 위치를 비교하는 API.
// 이 데이터는 기존 exam_rounds/roster(수험번호) 체계와 별개의, 아이디 기반 데이터다.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { readWorkbookRobust } = require('../parsers/normalizeXlsx');
const { parseAdmissionCaseWorkbook } = require('../parsers/admissionCaseParser');
const { parseExternalMockWorkbook } = require('../parsers/externalMockParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------- 합격자명단 (연도별 업로드) ----------

router.post('/admission-cases/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const admissionYear = Number(req.body.admission_year);
  if (!Number.isFinite(admissionYear) || !admissionYear) {
    return res.status(400).json({ error: 'admission_year(합격 연도)가 필요합니다.' });
  }

  let cases;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    cases = parseAdmissionCaseWorkbook(wb);
  } catch (err) {
    return res.status(422).json({ error: '합격자명단 파싱 실패: ' + err.message });
  }

  const client = await db.pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const c of cases) {
      await client.query(
        `INSERT INTO admission_cases
           (admission_year, univ_name, dept_name, admission_type, result_type, real_name, student_external_id, source_campus, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (admission_year, univ_name, dept_name, student_external_id, admission_type)
         DO UPDATE SET result_type=$5, real_name=$6, source_campus=$8, note=$9`,
        [admissionYear, c.univName, c.deptName, c.admissionType, c.resultType, c.realName, c.studentExternalId, c.sourceCampus, c.note]
      );
      inserted++;
    }
    await client.query('COMMIT');
    res.status(201).json({ admissionYear, caseCount: inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }
});

router.get('/admission-cases', async (req, res) => {
  const { year, univ_name, dept_name } = req.query;
  const conditions = [];
  const params = [];
  let sql = 'SELECT * FROM admission_cases';
  if (year) { params.push(Number(year)); conditions.push(`admission_year = $${params.length}`); }
  if (univ_name) { params.push(`%${univ_name}%`); conditions.push(`univ_name ILIKE $${params.length}`); }
  if (dept_name) { params.push(`%${dept_name}%`); conditions.push(`dept_name ILIKE $${params.length}`); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY admission_year DESC, univ_name, dept_name';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

router.delete('/admission-cases/:id', async (req, res) => {
  const { rows } = await db.query('DELETE FROM admission_cases WHERE id=$1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: '해당 사례를 찾을 수 없습니다.' });
  res.json({ deleted: true, id: rows[0].id });
});

// 대학/학과 목록 (합격자명단에 실제 등장한 것만) — 조회 화면 드롭다운용
router.get('/admission-cases/dept-list', async (req, res) => {
  const { rows } = await db.query(
    `SELECT univ_name, dept_name, COUNT(*)::int AS case_count, MIN(admission_year) AS min_year, MAX(admission_year) AS max_year
     FROM admission_cases GROUP BY univ_name, dept_name ORDER BY univ_name, dept_name`
  );
  res.json(rows);
});

// ---------- 외부 모의고사 회차 ----------

router.post('/external-mock-rounds', async (req, res) => {
  const examYear = Number(req.body.exam_year);
  const examMonth = Number(req.body.exam_month);
  const label = req.body.label || null;
  if (!Number.isFinite(examYear) || !examYear || !Number.isFinite(examMonth) || !examMonth) {
    return res.status(400).json({ error: 'exam_year, exam_month가 필요합니다.' });
  }
  const { rows } = await db.query(
    `INSERT INTO external_mock_rounds (exam_year, exam_month, label)
     VALUES ($1,$2,$3)
     ON CONFLICT (exam_year, exam_month) DO UPDATE SET label=COALESCE($3, external_mock_rounds.label)
     RETURNING *`,
    [examYear, examMonth, label]
  );
  res.status(201).json(rows[0]);
});

router.get('/external-mock-rounds', async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.*, COUNT(s.id)::int AS score_count
     FROM external_mock_rounds r
     LEFT JOIN external_mock_scores s ON s.round_id = r.id
     GROUP BY r.id ORDER BY r.exam_year DESC, r.exam_month DESC`
  );
  res.json(rows);
});

router.post('/external-mock-rounds/:id/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const roundId = req.params.id;

  let scores;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    scores = parseExternalMockWorkbook(wb);
  } catch (err) {
    return res.status(422).json({ error: '모의고사 결과 파싱 실패: ' + err.message });
  }

  const client = await db.pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const s of scores) {
      await client.query(
        `INSERT INTO external_mock_scores
           (round_id, student_external_id, real_name, subject, admission_type, track, campus_name, class_name,
            raw_score, percentile, overall_rank, class_rank, class_applicants, track_rank, track_applicants,
            class_avg, track_avg, top30_class_avg, top30_track_avg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (round_id, student_external_id, subject) DO UPDATE SET
           real_name=$3, admission_type=$5, track=$6, campus_name=$7, class_name=$8,
           raw_score=$9, percentile=$10, overall_rank=$11, class_rank=$12, class_applicants=$13,
           track_rank=$14, track_applicants=$15, class_avg=$16, track_avg=$17, top30_class_avg=$18, top30_track_avg=$19`,
        [roundId, s.studentExternalId, s.realName, s.subject, s.admissionType, s.track, s.campusName, s.className,
          s.rawScore, s.percentile, s.overallRank, s.classRank, s.classApplicants, s.trackRank, s.trackApplicants,
          s.classAvg, s.trackAvg, s.top30ClassAvg, s.top30TrackAvg]
      );
      inserted++;
    }
    await client.query('COMMIT');
    res.status(201).json({ roundId, scoreCount: inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }
});

// ---------- 합격생 분포 비교 ----------

// 대학/학과 기준 합격생들의 (가장 최근 회차) 외부 모의고사 성적 분포.
// exam_no를 같이 넘기면, 그 학생(수험번호 -> 아이디 매핑)의 최근 성적도 같이 반환해서 비교할 수 있게 한다.
router.get('/distribution', async (req, res) => {
  const { univ_name, dept_name, exam_no } = req.query;
  if (!univ_name || !dept_name) {
    return res.status(400).json({ error: 'univ_name, dept_name이 필요합니다.' });
  }

  const { rows: cases } = await db.query(
    `SELECT id, real_name, student_external_id, admission_type, result_type, admission_year
     FROM admission_cases WHERE univ_name=$1 AND dept_name=$2 AND student_external_id IS NOT NULL`,
    [univ_name, dept_name]
  );

  const externalIds = [...new Set(cases.map(c => c.student_external_id))];
  let scoreRows = [];
  if (externalIds.length > 0) {
    const { rows } = await db.query(
      `SELECT s.student_external_id, s.subject, s.percentile, s.raw_score, r.exam_year, r.exam_month
       FROM external_mock_scores s
       JOIN external_mock_rounds r ON r.id = s.round_id
       WHERE s.student_external_id = ANY($1::text[])`,
      [externalIds]
    );
    scoreRows = rows;
  }

  // 학생별로 과목마다 "가장 최근 회차" 점수 하나만 남긴다 (JS에서 처리 — 복잡한 중첩 SQL 대신).
  const latestByStudentSubject = new Map(); // key: externalId|subject -> row
  for (const r of scoreRows) {
    const key = r.student_external_id + '|' + r.subject;
    const prev = latestByStudentSubject.get(key);
    if (!prev || r.exam_year > prev.exam_year || (r.exam_year === prev.exam_year && r.exam_month > prev.exam_month)) {
      latestByStudentSubject.set(key, r);
    }
  }

  // 과목별 분포 (백분위 기준: n, min, avg, max)
  const bySubject = {};
  for (const row of latestByStudentSubject.values()) {
    if (row.percentile === null || row.percentile === undefined) continue;
    if (!bySubject[row.subject]) bySubject[row.subject] = [];
    bySubject[row.subject].push(Number(row.percentile));
  }
  const distribution = Object.entries(bySubject).map(([subject, values]) => {
    values.sort((a, b) => a - b);
    const n = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      subject,
      n,
      minPercentile: values[0],
      avgPercentile: Math.round((sum / n) * 10) / 10,
      maxPercentile: values[n - 1]
    };
  });

  let me = null;
  if (exam_no) {
    const { rows: mapRows } = await db.query(
      'SELECT student_external_id FROM student_external_id_map WHERE exam_no=$1', [exam_no]
    );
    if (mapRows.length > 0) {
      const myExternalId = mapRows[0].student_external_id;
      const { rows: myScoreRows } = await db.query(
        `SELECT s.subject, s.percentile, s.raw_score, r.exam_year, r.exam_month
         FROM external_mock_scores s
         JOIN external_mock_rounds r ON r.id = s.round_id
         WHERE s.student_external_id = $1
         ORDER BY r.exam_year DESC, r.exam_month DESC`,
        [myExternalId]
      );
      const myLatestBySubject = new Map();
      for (const r of myScoreRows) {
        if (!myLatestBySubject.has(r.subject)) myLatestBySubject.set(r.subject, r);
      }
      me = {
        studentExternalId: myExternalId,
        subjects: [...myLatestBySubject.values()].map(r => ({
          subject: r.subject, percentile: r.percentile, rawScore: r.raw_score,
          examYear: r.exam_year, examMonth: r.exam_month
        }))
      };
    } else {
      me = { studentExternalId: null, subjects: [], note: '이 수험번호에 매핑된 외부 아이디가 없습니다.' };
    }
  }

  res.json({
    univName: univ_name,
    deptName: dept_name,
    caseCount: cases.length,
    matchedStudentCount: externalIds.length,
    distribution,
    me
  });
});

module.exports = router;
