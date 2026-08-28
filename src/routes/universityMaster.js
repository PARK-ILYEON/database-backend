const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { readWorkbookRobust } = require('../parsers/normalizeXlsx');
const { parseCompetitionRatioWorkbook } = require('../parsers/competitionRatioParser');
const { requireAdmin } = require('../middleware/requireAdmin');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/** 빈 셀/undefined는 null로, 숫자로 못 바꾸는 값은 null로 (NaN을 그대로 DB에 보내면 에러) */
function toNullableInt(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

router.get('/', async (req, res) => {
  const { year, univ_name, dept_name } = req.query;
  const conditions = [];
  const params = [];
  let sql = 'SELECT * FROM university_master';
  if (year) { params.push(Number(year)); conditions.push(`year = $${params.length}`); }
  if (univ_name) { params.push(`%${univ_name}%`); conditions.push(`univ_name ILIKE $${params.length}`); }
  if (dept_name) { params.push(`%${dept_name}%`); conditions.push(`dept_name ILIKE $${params.length}`); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY univ_name, dept_name';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

router.post('/', requireAdmin, async (req, res) => {
  const { univ_name, dept_name, year, quota_general, quota_academic } = req.body;
  const { rows } = await db.query(
    `INSERT INTO university_master (univ_name, dept_name, year, quota_general, quota_academic)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (univ_name, dept_name, year)
     DO UPDATE SET quota_general=$4, quota_academic=$5
     RETURNING *`,
    [univ_name, dept_name, year, quota_general || null, quota_academic || null]
  );
  res.status(201).json(rows[0]);
});

// 개별 항목 수정 (대학명/학과명 자체를 바꾸는 경우도 포함하므로 id 기준으로 UPDATE)
router.put('/:id', requireAdmin, async (req, res) => {
  const { univ_name, dept_name, year, quota_general, quota_academic } = req.body;
  if (!univ_name || !dept_name || !year) {
    return res.status(400).json({ error: 'univ_name, dept_name, year는 필수입니다.' });
  }
  try {
    const { rows } = await db.query(
      `UPDATE university_master
       SET univ_name=$1, dept_name=$2, year=$3, quota_general=$4, quota_academic=$5
       WHERE id=$6
       RETURNING *`,
      [univ_name, dept_name, year, quota_general || null, quota_academic || null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '해당 항목을 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '같은 대학명+학과명+연도 항목이 이미 있습니다.' });
    throw err;
  }
});

// 개별 항목 삭제
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await db.query('DELETE FROM university_master WHERE id=$1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: '해당 항목을 찾을 수 없습니다.' });
  res.json({ deleted: true, id: rows[0].id });
});

// 대량 엑셀 업로드 (4-0/4-1: "전체 대학 검색" 시트 포맷 — 대학교/전공/일반/학사 4열)
router.post('/bulk-upload', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const year = Number(req.body.year);
  if (!year) return res.status(400).json({ error: 'year(입시 연도)가 필요합니다.' });
  const sheetIndex = req.body.sheetIndex !== undefined ? Number(req.body.sheetIndex) : 0;

  let rows;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    const sheetName = wb.SheetNames[sheetIndex];
    rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
  } catch (err) {
    return res.status(422).json({ error: '엑셀 파싱 실패: ' + err.message });
  }

  // 헤더 행(대학교/전공/일반/학사)을 찾아 그 아래부터 데이터로 처리
  const norm = s => String(s ?? '').replace(/\s+/g, '');
  let headerRow = -1, colUniv = -1, colDept = -1, colGeneral = -1, colAcademic = -1;
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const t = norm(row[c]);
      if (t === '대학교' || t === '대학명') { colUniv = c; headerRow = r; }
      else if (t === '전공' || t === '모집단위') { colDept = c; headerRow = r; }
      else if (t === '일반') { colGeneral = c; headerRow = r; }
      else if (t === '학사') { colAcademic = c; headerRow = r; }
    }
  }
  if (colUniv === -1 || colDept === -1) {
    return res.status(422).json({ error: '"대학교"/"전공" 헤더를 찾지 못했습니다.' });
  }

  // 대학 마스터는 한 번에 수백~수천 행이 들어올 수 있어, 행마다 왕복하지 않고
  // 일정 개수씩 묶어 하나의 INSERT 문으로 보낸다 (배치 upsert).
  // 실제 "전체 대학 검색" 시트에는 동일 대학+전공이 중복 기재된 행이 있었다(예: 한양대학교/건축학부 2회).
  // 같은 배치 안에서 동일 충돌키(univ_name,dept_name,year)가 두 번 나오면 Postgres가
  // "ON CONFLICT DO UPDATE command cannot affect row a second time" 에러를 내므로,
  // 삽입 전에 (univ_name,dept_name) 기준으로 중복을 제거한다 (마지막 값 우선).
  const recordMap = new Map();
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const univName = String(row[colUniv] ?? '').trim();
    const deptName = String(row[colDept] ?? '').trim();
    if (!univName || !deptName) continue;
    const quotaGeneral = colGeneral >= 0 ? toNullableInt(row[colGeneral]) : null;
    const quotaAcademic = colAcademic >= 0 ? toNullableInt(row[colAcademic]) : null;
    recordMap.set(`${univName}|||${deptName}`, [univName, deptName, year, quotaGeneral, quotaAcademic]);
  }
  const records = [...recordMap.values()];
  const duplicateRowCount = (rows.length - headerRow - 1) - records.length; // 참고용(빈 행 포함)

  const BATCH_SIZE = 200;
  const client = await db.pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const values = [];
      const placeholders = batch.map((rec, idx) => {
        const base = idx * 5;
        values.push(...rec);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`;
      }).join(',');
      await client.query(
        `INSERT INTO university_master (univ_name, dept_name, year, quota_general, quota_academic)
         VALUES ${placeholders}
         ON CONFLICT (univ_name, dept_name, year)
         DO UPDATE SET quota_general=EXCLUDED.quota_general, quota_academic=EXCLUDED.quota_academic`,
        values
      );
      inserted += batch.length;
    }
    await client.query('COMMIT');
    res.status(201).json({ inserted, year, skippedDuplicateOrEmptyRows: duplicateRowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }
});

// 대학별 시트로 나뉜 모집인원/지원인원 자료 업로드 (예: "26학년도 경쟁률.xlsx").
// 기존 bulk-upload("대학교/전공/일반/학사" 단일 시트 포맷)와는 완전히 별개의 파일 형식이라 새 경로로 둔다.
// 같은 (univ_name, dept_name, year) 행이 이미 있으면 quota_general/applicants_general/track/college/
// combined_flag만 갱신하고, quota_academic 등 기존 값은 건드리지 않는다.
router.post('/competition-ratio-upload', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const year = Number(req.body.year);
  if (!year) return res.status(400).json({ error: 'year(입시 연도)가 필요합니다.' });

  let records, warnings;
  try {
    const wb = readWorkbookRobust(req.file.buffer);
    const result = parseCompetitionRatioWorkbook(wb);
    records = result.records;
    warnings = result.warnings;
  } catch (err) {
    return res.status(422).json({ error: '경쟁률 자료 파싱 실패: ' + err.message });
  }

  // 같은 배치 안에서 (univ_name, dept_name) 키가 중복되면 Postgres가 에러를 내므로 먼저 정리한다(마지막 값 우선).
  const recordMap = new Map();
  for (const r of records) {
    recordMap.set(`${r.univName}|||${r.deptName}`, r);
  }
  const uniqueRecords = [...recordMap.values()];

  const BATCH_SIZE = 200;
  const client = await db.pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (let i = 0; i < uniqueRecords.length; i += BATCH_SIZE) {
      const batch = uniqueRecords.slice(i, i + BATCH_SIZE);
      const values = [];
      const placeholders = batch.map((r, idx) => {
        const base = idx * 8;
        values.push(r.univName, r.deptName, year, r.quotaGeneral, r.applicantsGeneral, r.track, r.college, r.isCombinedSelection);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
      }).join(',');
      await client.query(
        `INSERT INTO university_master (univ_name, dept_name, year, quota_general, applicants_general, track, college, combined_flag)
         VALUES ${placeholders}
         ON CONFLICT (univ_name, dept_name, year)
         DO UPDATE SET quota_general=EXCLUDED.quota_general, applicants_general=EXCLUDED.applicants_general,
           track=EXCLUDED.track, college=EXCLUDED.college, combined_flag=EXCLUDED.combined_flag`,
        values
      );
      inserted += batch.length;
    }
    await client.query('COMMIT');
    res.status(201).json({ inserted, year, warnings: warnings && warnings.length ? warnings : undefined });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'DB 저장 실패: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
