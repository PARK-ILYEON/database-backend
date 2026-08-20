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
           (admission_year, univ_name, dept_name, admission_type, result_type, real_name, student_external_id, exam_no, source_campus, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (admission_year, univ_name, dept_name, student_external_id, admission_type)
         DO UPDATE SET result_type=$5, real_name=$6, exam_no=COALESCE($8, admission_cases.exam_no), source_campus=$9, note=$10`,
        [admissionYear, c.univName, c.deptName, c.admissionType, c.resultType, c.realName, c.studentExternalId, c.examNo, c.sourceCampus, c.note]
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

  let scores, warnings;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    const result = parseExternalMockWorkbook(wb);
    scores = result.scores;
    warnings = result.warnings;
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
           (round_id, student_external_id, exam_no, real_name, subject, admission_type, track, campus_name, class_name,
            raw_score, percentile, overall_rank, class_rank, class_applicants, track_rank, track_applicants,
            class_avg, track_avg, top30_class_avg, top30_track_avg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (round_id, student_external_id, subject) DO UPDATE SET
           exam_no=COALESCE($3, external_mock_scores.exam_no), real_name=$4, admission_type=$6, track=$7, campus_name=$8, class_name=$9,
           raw_score=$10, percentile=$11, overall_rank=$12, class_rank=$13, class_applicants=$14,
           track_rank=$15, track_applicants=$16, class_avg=$17, track_avg=$18, top30_class_avg=$19, top30_track_avg=$20`,
        [roundId, s.studentExternalId, s.examNo, s.realName, s.subject, s.admissionType, s.track, s.campusName, s.className,
          s.rawScore, s.percentile, s.overallRank, s.classRank, s.classApplicants, s.trackRank, s.trackApplicants,
          s.classAvg, s.trackAvg, s.top30ClassAvg, s.top30TrackAvg]
      );
      // 수험번호가 같이 올라오면 아이디<->수험번호 매핑도 같이 갱신해서, 나중에 수험번호가 없는
      // 다른 업로드에서도 이 학생을 계속 찾을 수 있게 해둔다.
      if (s.examNo && s.studentExternalId) {
        await client.query(
          `INSERT INTO student_external_id_map (exam_no, student_external_id, real_name, updated_at)
           VALUES ($1,$2,$3, now())
           ON CONFLICT (exam_no) DO UPDATE SET student_external_id=$2, real_name=$3, updated_at=now()`,
          [s.examNo, s.studentExternalId, s.realName]
        );
      }
      inserted++;
    }
    await client.query('COMMIT');
    res.status(201).json({ roundId, scoreCount: inserted, warnings: warnings && warnings.length ? warnings : undefined });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }
});

// ---------- 합격생 분포 비교 ----------

// 대학/학과 기준 합격생들의 (가장 최근 회차) 외부 모의고사 성적 분포.
// 합격자 사례에 수험번호가 있으면 그걸로 바로 매칭하고, 없으면 아이디로 매칭한다.
// exam_no 쿼리파라미터를 같이 넘기면, 그 학생의 최근 성적도 같이 반환해서 비교할 수 있게 한다.
router.get('/distribution', async (req, res) => {
  const { univ_name, dept_name, exam_no } = req.query;
  if (!univ_name || !dept_name) {
    return res.status(400).json({ error: 'univ_name, dept_name이 필요합니다.' });
  }

  const { rows: cases } = await db.query(
    `SELECT id, real_name, student_external_id, exam_no, admission_type, result_type, admission_year
     FROM admission_cases WHERE univ_name=$1 AND dept_name=$2
       AND (student_external_id IS NOT NULL OR exam_no IS NOT NULL)`,
    [univ_name, dept_name]
  );

  const examNosFromCases = [...new Set(cases.map(c => c.exam_no).filter(Boolean))];
  const externalIdsFromCases = [...new Set(cases.map(c => c.student_external_id).filter(Boolean))];
  const matchedStudentKeys = new Set(cases.map(c => c.exam_no || c.student_external_id).filter(Boolean));

  let scoreRows = [];
  if (examNosFromCases.length > 0 || externalIdsFromCases.length > 0) {
    const { rows } = await db.query(
      `SELECT s.student_external_id, s.exam_no, s.subject, s.percentile, s.raw_score, r.exam_year, r.exam_month
       FROM external_mock_scores s
       JOIN external_mock_rounds r ON r.id = s.round_id
       WHERE s.exam_no = ANY($1::text[]) OR s.student_external_id = ANY($2::text[])`,
      [examNosFromCases, externalIdsFromCases]
    );
    scoreRows = rows;
  }

  // 학생별로 과목마다 "가장 최근 회차" 점수 하나만 남긴다 (JS에서 처리 — 복잡한 중첩 SQL 대신).
  // 학생 식별은 수험번호가 있으면 수험번호, 없으면 아이디를 키로 쓴다.
  const latestByStudentSubject = new Map(); // key: (examNo||externalId)|subject -> row
  for (const r of scoreRows) {
    const studentKey = r.exam_no || r.student_external_id;
    const key = studentKey + '|' + r.subject;
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
    // 1순위: 이 학생의 외부 모의고사 성적에 수험번호가 직접 찍혀 있으면 바로 사용 (아이디 매핑 불필요).
    const { rows: directScoreRows } = await db.query(
      `SELECT s.student_external_id, s.subject, s.percentile, s.raw_score, r.exam_year, r.exam_month
       FROM external_mock_scores s
       JOIN external_mock_rounds r ON r.id = s.round_id
       WHERE s.exam_no = $1
       ORDER BY r.exam_year DESC, r.exam_month DESC`,
      [exam_no]
    );

    let myScoreRows = directScoreRows;
    let myExternalId = directScoreRows[0] ? directScoreRows[0].student_external_id : null;

    // 2순위: 수험번호로 직접 매칭되는 성적이 없으면, 예전 방식대로 명단 업로드 때 쌓인
    // 수험번호<->아이디 매핑을 거쳐서 찾는다 (하위 호환).
    if (myScoreRows.length === 0) {
      const { rows: mapRows } = await db.query(
        'SELECT student_external_id FROM student_external_id_map WHERE exam_no=$1', [exam_no]
      );
      if (mapRows.length > 0) {
        myExternalId = mapRows[0].student_external_id;
        const { rows } = await db.query(
          `SELECT s.subject, s.percentile, s.raw_score, r.exam_year, r.exam_month
           FROM external_mock_scores s
           JOIN external_mock_rounds r ON r.id = s.round_id
           WHERE s.student_external_id = $1
           ORDER BY r.exam_year DESC, r.exam_month DESC`,
          [myExternalId]
        );
        myScoreRows = rows;
      }
    }

    if (myScoreRows.length > 0) {
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
      me = { studentExternalId: null, subjects: [], note: '이 수험번호로 매칭되는 외부 모의고사 성적이 없습니다 (수험번호가 파일에 없거나, 명단 업로드로 아이디 매핑이 안 돼 있음).' };
    }
  }

  res.json({
    univName: univ_name,
    deptName: dept_name,
    caseCount: cases.length,
    matchedStudentCount: matchedStudentKeys.size,
    distribution,
    me
  });
});

module.exports = router;
