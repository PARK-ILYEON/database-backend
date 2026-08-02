const express = require('express');
const examRoundsRouter = require('./routes/examRounds');
const studentsRouter = require('./routes/students');
const portalRouter = require('./routes/portal');
const universityMasterRouter = require('./routes/universityMaster');
const adminAuthRouter = require('./routes/adminAuth');
const { requireAdmin } = require('./middleware/requireAdmin');

function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true }));

  // 로그인 자체는 인증 없이 접근 가능해야 함
  app.use('/api/admin', adminAuthRouter);

  // 3-3: 관리자 전용 API는 로그인 세션(JWT) 확인을 거친다.
  // 회차 관리·OMR/정답지/명단 업로드·발행·학생 이력 조회는 전부 관리자 전용 기능.
  app.use('/api/exam-rounds', requireAdmin, examRoundsRouter);
  app.use('/api/students', requireAdmin, studentsRouter);

  // 학생 포털은 설계대로 무로그인 유지 (수험번호 기반 조회)
  app.use('/api/portal', portalRouter);

  // 대학 마스터: 조회(GET)는 공개, 등록/수정/대량업로드는 관리자 전용
  app.use('/api/university-master', universityMasterRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || '서버 오류' });
  });

  return app;
}

module.exports = { createApp };
