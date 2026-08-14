const express = require('express');
const cors = require('cors');
const examRoundsRouter = require('./routes/examRounds');
const studentsRouter = require('./routes/students');
const portalRouter = require('./routes/portal');
const universityMasterRouter = require('./routes/universityMaster');
const adminAuthRouter = require('./routes/adminAuth');
const admissionPredictionRouter = require('./routes/admissionPrediction');
const { requireAdmin } = require('./middleware/requireAdmin');

function createApp() {
  const app = express();
  // 프론트엔드(별도 도메인/로컬 파일)에서 API를 호출할 수 있도록 CORS 허용.
  // 운영에서 특정 도메인만 허용하고 싶으면 CORS_ORIGIN 환경변수에 콤마로 구분해 지정.
  const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : null;
  app.use(cors({
    origin: allowedOrigins || true,
    credentials: true
  }));
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

  // 합격 예측(참고) 기능: 합격자명단/외부 모의고사 데이터 — 관리자 전용
  app.use('/api/admission-prediction', requireAdmin, admissionPredictionRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || '서버 오류' });
  });

  return app;
}

module.exports = { createApp };
