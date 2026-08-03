# 성적 처리 통합 관리 시스템 — 백엔드

기술설계서 v5(1부 DB설계, 2부 OMR 파싱, 3부 인증, 4부 대학 마스터 DB)를 코드로 옮긴 1차 구현입니다.
실제 업로드받은 파일(OMR 리딩결과, 정답지·명단·대학마스터 통합워크북)로 파싱·채점·업로드 로직 전체를 검증했습니다.

## 폴더 구조

```
backend/
  migrations/001_init.sql         DB 스키마 (PostgreSQL, 15개 테이블)
  src/
    db.js                         PostgreSQL 커넥션 풀
    app.js                        Express 앱 조립 + 라우트별 인증 적용
    services/
      auth.js                     비밀번호 해시(bcrypt) + JWT 발급/검증
      scoring.js                  채점 → 석차/백분위 계산 → 명단 조인
    middleware/
      requireAdmin.js             관리자 전용 API 인증 미들웨어
    parsers/
      omrParser.js                 OMR 리딩결과 파싱 (헤더 없음, A=수험번호/B=과목코드/C~=마킹)
      answerKeyParser.js           정답지 파싱 (라벨 텍스트로 행 위치 자동 판별)
      rosterParser.js              명단 파싱 (2행 헤더, "N차"=누적성적 백분위)
      normalizeXlsx.js             손상된 엑셀 stylesheet 복구 (LibreOffice round-trip)
    routes/
      adminAuth.js                  관리자 로그인 (POST /api/admin/login)
      examRounds.js                 회차/OMR업로드/정답지업로드/명단업로드/발행 (관리자 전용)
      students.js                   관리자 - 학생 이력 조회 (관리자 전용)
      portal.js                     학생 포털 조회 + 자가채점 (무로그인)
      universityMaster.js           대학 마스터 DB 조회(공개)/등록·대량업로드(관리자 전용)
  scripts/
    create-admin.js                최초 관리자 계정 생성 CLI
    verify-parsers.js              파서만 빠르게 확인 (실제 파일로 실행)
    verify-full-pipeline.js        마이그레이션→인증→업로드→채점→대학DB까지 전 구간 검증
  server.js                        진입점
```

## 실행 방법

```bash
npm install
cp .env.example .env   # DB 접속 정보 입력
npm run migrate         # = psql "$DATABASE_URL" -f migrations/001_init.sql
npm run create-admin -- <아이디> <비밀번호>   # 최초 관리자 계정 생성
npm start
```

로그인: `POST /api/admin/login` `{username, password}` → `{token}` 을 받아, 이후 관리자 API 호출 시
`Authorization: Bearer <token>` 헤더로 전달합니다.

## 검증한 내용 (실제 파일 + 실제 Postgres 호환 엔진 기준)

개발 중 아래 전 구간을 **실제 업로드 파일**과 **PGlite(WASM으로 컴파일된 진짜 PostgreSQL 엔진)** 로 검증했습니다.
mock이 아니라 실제 SQL(트랜잭션, FK 제약, UNIQUE 제약, ON CONFLICT, JSONB)이 그대로 실행된 결과입니다.
`npm install` 후 `node scripts/verify-full-pipeline.js --workbook <통합워크북.xlsx> --omr <OMR파일.xlsx>` 로 언제든 재현할 수 있습니다.

- **마이그레이션**: `001_init.sql`이 실제 Postgres 엔진에서 15개 테이블 전부 에러 없이 생성됨을 확인.
- **정답지 파싱**: 40개 문항 정확히 추출(41~50번은 배점 없어 자동 제외), area_tag "문/독/어" 3종 확인.
- **명단 파싱**: 574명 파싱, "성+OO" 마스킹 규칙 573/574건 일치. 명단에 실제로 **동일 수험번호 중복행 2건**이 있어(윤정호, 천수연 각 1건), `ON CONFLICT DO NOTHING`으로 안전하게 무시되는 것까지 확인.
- **OMR 파싱 + 채점**: 29명 × 50문항 파싱, 정답지와 매칭해 채점 → 총점/동점 처리 석차/백분위/영역별 점수까지 계산되고 `student_scores`에 정확히 저장됨을 확인.
- **명단 조인**: 수험번호가 일치하는 학생은 실명/마스킹이름/학과/계열이 붙고, 일치하지 않는 학생은 "이름 미매칭"으로 표시되어 총원에서 빠지지 않는 것을 확인.
- **관리자 인증**: 토큰 없이 관리자 API 접근 시 401, 잘못된 비밀번호 401, 정상 로그인 후 토큰으로 회차 생성까지 성공, 위조 토큰은 401로 차단됨을 확인.
- **대학 마스터 대량업로드**: 실제 "전체 대학 검색" 시트(797행)를 업로드해 767건 저장 확인 — 빈 행 28건과 **완전 중복행 1건(한양대학교 건축학부가 2번 기재됨)** 을 자동으로 걸러냄. 배치 upsert(200행 단위)로 처리해 대량 데이터도 왕복 없이 빠르게 저장됨.
- **학생 이력/포털 조회**: 발행(published) 처리 후 관리자 이력 조회, 학생 포털 무로그인 조회 라우트도 실데이터로 확인.

## 알려진 제약 / 남은 작업

1. **`normalizeXlsx.js`의 LibreOffice 의존성**: 학원에서 받은 통합워크북 파일 일부가 stylesheet 손상으로 바로 파싱되지 않아, LibreOffice headless 재저장으로 복구하는 로직을 넣었습니다. 운영 서버에 `soffice`(LibreOffice)가 설치되어 있어야 합니다.
2. **마스킹 이름 1건 불일치**: 574명 중 1명은 파일의 마스킹 이름이 "성+OO" 규칙과 다르게 들어있었습니다(복성이거나 수기 오타로 추정). 파싱 시 파일의 마스킹 이름 값을 그대로 신뢰하고 저장하므로 서비스 동작에는 문제없지만, 참고로 남깁니다.
3. **area_tag 매핑**: 정답지에서 "어"(어휘) 코드가 새로 확인되어 `area_tag_labels` 초기 데이터에 반영했습니다. 논리독해 코드는 여전히 실제 파일에서 확인되지 않았습니다.
4. **admin_accounts role**: 1차에는 `staff` 단일 역할만 발급합니다. 지점별/권한별 세분화가 필요해지면 `requireRole()` 헬퍼(이미 준비됨)로 확장하면 됩니다.
5. **실제 운영 PostgreSQL에서의 최종 확인 권장**: PGlite는 실제 Postgres 엔진(WASM 빌드)이라 SQL 호환성은 매우 높지만, 운영 환경과 100% 동일하지는 않으므로 스테이징 DB에 한 번 더 붙여서 확인하는 것을 권장합니다.
6. **실제 PostgreSQL 성능**: 대학 마스터 배치 upsert(200행/쿼리)는 PGlite 기준으로 충분히 빨랐습니다. 실제 Postgres에서는 네트워크 왕복이 더 빠를 것으로 예상되지만, 수천~수만 행 규모로 커지면 배치 크기 조정을 고려하세요.  
