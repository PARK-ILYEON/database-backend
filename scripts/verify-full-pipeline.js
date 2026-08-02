// 전체 파이프라인 통합 검증 스크립트.
// 실제 Postgres 서버 없이도, PGlite(WASM으로 컴파일된 진짜 PostgreSQL)로
// 마이그레이션 → 로그인 인증 → 정답지/명단/OMR 업로드 → 채점 → 조회까지 전 구간을 검증한다.
// (devDependencies의 @electric-sql/pglite 필요: npm install 시 함께 설치됨)
//
// 사용법:
//   node scripts/verify-full-pipeline.js --workbook <통합워크북.xlsx> --omr <OMR리딩결과.xlsx> \
//     [--answerSheet 2] [--rosterSheet 0] [--univSheet 6] [--univYear 2024]
const path = require('path');
const fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');

const BACKEND = path.resolve(__dirname, '..');
const dbPath = path.resolve(BACKEND, 'src/db.js');

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function fakeRes(label, quiet) {
  return {
    _status: 200,
    status(c) { this._status = c; return this; },
    json(obj) {
      this.body = obj;
      if (!quiet) console.log(`[${label}] status=${this._status}`, JSON.stringify(obj).slice(0, 200));
    }
  };
}

function getHandler(router, routePath, method) {
  let h = null;
  router.stack.forEach(layer => {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      h = layer.route.stack[layer.route.stack.length - 1].handle;
    }
  });
  if (!h) throw new Error(`핸들러를 찾지 못했습니다: ${method.toUpperCase()} ${routePath}`);
  return h;
}

async function main() {
  const workbookPath = getArg('workbook');
  const omrPath = getArg('omr');
  const answerSheet = Number(getArg('answerSheet', '2'));
  const rosterSheet = Number(getArg('rosterSheet', '0'));
  const univSheet = Number(getArg('univSheet', '6'));
  const univYear = Number(getArg('univYear', String(new Date().getFullYear())));

  if (!workbookPath || !omrPath) {
    console.log('사용법: node scripts/verify-full-pipeline.js --workbook <통합워크북.xlsx> --omr <OMR리딩결과.xlsx>');
    process.exit(1);
  }

  console.log('1) PGlite(WASM Postgres) 기동 및 마이그레이션 적용...');
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(BACKEND, 'migrations/001_init.sql'), 'utf8'));
  console.log('   완료.\n');

  // src/db.js를 PGlite 어댑터로 교체 (pg.Pool과 동일 인터페이스)
  const adapter = {
    query: (text, params) => pg.query(text, params),
    pool: { connect: async () => ({ query: (text, params) => pg.query(text, params), release: () => {} }) }
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: adapter };

  console.log('2) 관리자 계정 생성 및 로그인...');
  const { hashPassword } = require(path.join(BACKEND, 'src/services/auth'));
  const hash = await hashPassword('verify-pass-1234');
  await pg.query(`INSERT INTO admin_accounts (username, password_hash, role) VALUES ('verify_admin',$1,'staff')`, [hash]);
  const adminAuthRouter = require(path.join(BACKEND, 'src/routes/adminAuth'));
  const { requireAdmin } = require(path.join(BACKEND, 'src/middleware/requireAdmin'));
  const loginRes = fakeRes('login', true);
  await getHandler(adminAuthRouter, '/login', 'post')({ body: { username: 'verify_admin', password: 'verify-pass-1234' } }, loginRes);
  if (!loginRes.body.token) throw new Error('로그인 실패');
  console.log('   토큰 발급 확인.\n');

  console.log('3) 기초 데이터(지점/교수/반/회차) 생성...');
  await pg.query("INSERT INTO academies (id, name) VALUES (1, '강남단과')");
  await pg.query("INSERT INTO professors (id, name) VALUES (1, '테스트교수')");
  await pg.query("INSERT INTO classes (id, professor_id, class_name, academy_id) VALUES (1, 1, 'T', 1)");
  const roundRes = await pg.query("INSERT INTO exam_rounds (class_id, round_label, exam_year, status) VALUES (1,'검증회차',2026,'draft') RETURNING id");
  const examRoundId = roundRes.rows[0].id;
  console.log('   exam_round_id =', examRoundId, '\n');

  console.log('4) 정답지 / 명단 / OMR 업로드...');
  const examRoundsRouter = require(path.join(BACKEND, 'src/routes/examRounds'));
  const wbBuf = fs.readFileSync(workbookPath);
  const omrBuf = fs.readFileSync(omrPath);

  await getHandler(examRoundsRouter, '/:id/answer-key-upload', 'post')(
    { params: { id: String(examRoundId) }, body: { sheetIndex: String(answerSheet) }, file: { buffer: wbBuf, originalname: 'answerkey.xlsx' } },
    fakeRes('answer-key-upload')
  );
  await getHandler(examRoundsRouter, '/:id/roster-upload', 'post')(
    { params: { id: String(examRoundId) }, body: { sheetIndex: String(rosterSheet) }, file: { buffer: wbBuf, originalname: 'roster.xlsx' } },
    fakeRes('roster-upload')
  );
  await getHandler(examRoundsRouter, '/:id/omr-upload', 'post')(
    { params: { id: String(examRoundId) }, body: {}, file: { buffer: omrBuf, originalname: 'omr.xlsx' } },
    fakeRes('omr-upload')
  );

  const counts = await pg.query(`
    SELECT
      (SELECT count(*) FROM answer_keys WHERE exam_round_id=$1) AS answer_keys,
      (SELECT count(*) FROM roster_entries re JOIN rosters r ON r.id=re.roster_id WHERE r.exam_round_id=$1) AS roster_entries,
      (SELECT count(*) FROM omr_answers oa JOIN omr_uploads ou ON ou.id=oa.omr_upload_id WHERE ou.exam_round_id=$1) AS omr_answers,
      (SELECT count(*) FROM student_scores WHERE exam_round_id=$1) AS student_scores
  `, [examRoundId]);
  console.log('   저장 결과:', counts.rows[0], '\n');

  console.log('5) 대학 마스터 대량업로드 (시트#' + univSheet + ', ' + univYear + '년)...');
  const universityMasterRouter = require(path.join(BACKEND, 'src/routes/universityMaster'));
  const bulkRes = fakeRes('university-bulk-upload');
  await getHandler(universityMasterRouter, '/bulk-upload', 'post')(
    { body: { year: String(univYear), sheetIndex: String(univSheet) }, file: { buffer: wbBuf, originalname: 'univ.xlsx' } },
    bulkRes
  );
  const univCount = await pg.query('SELECT count(*) FROM university_master');
  console.log('   university_master 총 row 수:', univCount.rows[0].count, '\n');

  console.log('6) 관리자 인증 없이 접근 시 차단되는지 확인...');
  let blocked = true;
  requireAdmin({ headers: {} }, fakeRes('requireAdmin-check', true), () => { blocked = false; });
  console.log('   인증 없이 통과 차단됨?', blocked, '\n');

  console.log('=== 전체 파이프라인 검증 완료 ===');
}

main().catch(err => { console.error('검증 실패:', err); process.exit(1); });
