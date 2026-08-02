-- 성적 처리 통합 관리 시스템 - 초기 스키마
-- 기술설계서 v5 (1부) 기준

-- 지점
CREATE TABLE academies (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL       -- 강남단과 / 신촌단과
);

-- 교수
CREATE TABLE professors (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,       -- 예: 정병권, 장황수학
  subject       VARCHAR(20)                  -- english / math — 화면 표시용 기본값 (실제 과목은 OMR 파일 B열로 회차마다 확정)
);

-- 반
CREATE TABLE classes (
  id            SERIAL PRIMARY KEY,
  professor_id  INTEGER NOT NULL REFERENCES professors(id),
  class_name    VARCHAR(50) NOT NULL,        -- 예: P, R
  academy_id    INTEGER NOT NULL REFERENCES academies(id)
);

-- 회차
CREATE TABLE exam_rounds (
  id            SERIAL PRIMARY KEY,
  class_id      INTEGER NOT NULL REFERENCES classes(id),
  round_label   VARCHAR(50) NOT NULL,        -- 예: 12회차
  exam_year     INTEGER NOT NULL,
  exam_date     DATE,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'  -- draft / published
    CHECK (status IN ('draft','published')),
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_exam_rounds_class ON exam_rounds(class_id);

-- 정답지
CREATE TABLE answer_keys (
  id              SERIAL PRIMARY KEY,
  exam_round_id   INTEGER NOT NULL REFERENCES exam_rounds(id) ON DELETE CASCADE,
  question_no     INTEGER NOT NULL,
  point           NUMERIC(3,1) NOT NULL,     -- 0.5점 단위 존재 (1.5 / 2.5 / 3.5 등)
  correct_answer  CHAR(1) NOT NULL CHECK (correct_answer IN ('a','b','c','d','e')),
  area_tag        VARCHAR(10),               -- 원본 1글자 코드 (문/독 등) → area_tag_labels로 매핑
  UNIQUE (exam_round_id, question_no)
);

-- area_tag(1글자 코드) → 사람이 읽는 라벨 매핑
CREATE TABLE area_tag_labels (
  area_tag      VARCHAR(10) PRIMARY KEY,     -- 문 / 독 / 어휘 ...
  label         VARCHAR(50) NOT NULL         -- 문법 / 독해 / 어휘 ...
);

-- 명단 파일
CREATE TABLE rosters (
  id              SERIAL PRIMARY KEY,
  exam_round_id   INTEGER NOT NULL REFERENCES exam_rounds(id) ON DELETE CASCADE,
  file_name       VARCHAR(255) NOT NULL,
  uploaded_at     TIMESTAMP NOT NULL DEFAULT now()
);

-- 명단 항목
CREATE TABLE roster_entries (
  id                  SERIAL PRIMARY KEY,
  roster_id           INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
  exam_no             VARCHAR(50) NOT NULL,
  real_name           VARCHAR(100),
  masked_name         VARCHAR(100),          -- "성 + OO" 규칙 (파일값 우선, 없으면 서버에서 자동 생성)
  track               VARCHAR(50),           -- 계열 (인문/자연/간호/예체능(미대)/예체능(체대)/의치수약)
  dept                VARCHAR(200),          -- 희망학과 (학생 표기 그대로)
  round_percentiles   JSONB,                 -- 명단파일 "1차~12차" = 누적성적 백분위. {"1":85.2,"2":83.7,...}
  UNIQUE (roster_id, exam_no)
);
CREATE INDEX idx_roster_entries_exam_no ON roster_entries(exam_no);

-- OMR 업로드 파일
CREATE TABLE omr_uploads (
  id              SERIAL PRIMARY KEY,
  exam_round_id   INTEGER NOT NULL REFERENCES exam_rounds(id) ON DELETE CASCADE,
  file_name       VARCHAR(255) NOT NULL,     -- 예: 0624 정병권P 월수금 저녁반 11회차_리딩결과.xlsx
  subject_code    INTEGER,                   -- 원본 B열 값 (1=영어, 2=수학)
  status          VARCHAR(20) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','done','failed')),
  raw_file_path   VARCHAR(500),
  error_detail    TEXT,                      -- 파싱 실패/보류 사유 (정답지 없음 등)
  uploaded_at     TIMESTAMP NOT NULL DEFAULT now()
);

-- OMR 원본 마킹 (문항별)
CREATE TABLE omr_answers (
  id              SERIAL PRIMARY KEY,
  omr_upload_id   INTEGER NOT NULL REFERENCES omr_uploads(id) ON DELETE CASCADE,
  exam_no         VARCHAR(50) NOT NULL,
  question_no     INTEGER NOT NULL,
  student_answer  CHAR(1),                   -- a~e, NULL/공백 = 미응답
  is_correct      BOOLEAN,
  UNIQUE (omr_upload_id, exam_no, question_no)
);
CREATE INDEX idx_omr_answers_exam_no ON omr_answers(exam_no);

-- 학생 집계 성적
CREATE TABLE student_scores (
  id              SERIAL PRIMARY KEY,
  exam_round_id   INTEGER NOT NULL REFERENCES exam_rounds(id) ON DELETE CASCADE,
  exam_no         VARCHAR(50) NOT NULL,
  total_score     NUMERIC(6,1) NOT NULL,
  overall_rank    INTEGER,
  percentile      NUMERIC(5,2),
  area_scores     JSONB,                     -- { "문법": {"earned":18,"total":20}, "독해": {...} }
  computed_at     TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (exam_round_id, exam_no)
);

-- 대학 마스터
CREATE TABLE university_master (
  id                SERIAL PRIMARY KEY,
  univ_name         VARCHAR(100) NOT NULL,
  dept_name         VARCHAR(200) NOT NULL,   -- 모집단위명 (예: 경영학부 경영학)
  year              INTEGER NOT NULL,        -- 입시 연도
  quota_general     INTEGER,                 -- 일반전형 모집인원
  quota_academic    INTEGER,                 -- 학사(교과) 모집인원
  UNIQUE (univ_name, dept_name, year)
);

-- 학과명 별칭 매칭
CREATE TABLE dept_alias (
  id                      SERIAL PRIMARY KEY,
  alias_name              VARCHAR(200) NOT NULL,   -- 학생이 적어내는 희망학과명
  university_master_id    INTEGER NOT NULL REFERENCES university_master(id),
  UNIQUE (alias_name, university_master_id)
);

-- 자가채점 제출
CREATE TABLE self_quiz_submissions (
  id              SERIAL PRIMARY KEY,
  self_exam_no    VARCHAR(20) NOT NULL UNIQUE,   -- SELFxxxxxxxx
  name            VARCHAR(100),
  exam_round_id   INTEGER NOT NULL REFERENCES exam_rounds(id),
  answers         JSONB NOT NULL,                -- { "1":"a", "2":"c", ... }
  total_score     NUMERIC(6,1),
  area_scores     JSONB,
  submitted_at    TIMESTAMP NOT NULL DEFAULT now()
);

-- 관리자 계정
CREATE TABLE admin_accounts (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(50) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  role            VARCHAR(20) NOT NULL DEFAULT 'staff',  -- staff / master(추후)
  academy_id      INTEGER REFERENCES academies(id),
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- 초기 area_tag 매핑 (실제 정답지에서 확인된 코드)
INSERT INTO area_tag_labels (area_tag, label) VALUES
  ('문', '문법'),
  ('독', '독해'),
  ('어휘', '어휘')
ON CONFLICT DO NOTHING;
