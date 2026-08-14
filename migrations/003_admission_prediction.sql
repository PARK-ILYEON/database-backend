-- 합격 예측(참고) 기능을 위한 테이블.
-- 이 데이터는 기존 exam_rounds/roster 체계(수험번호 기반)와 별개로,
-- 외부 편입모의고사 대행업체 데이터(아이디 기반)를 다룬다.
-- 실제 확률 계산이 아니라 "과거 합격생 성적 분포 대비 현재 학생 위치 비교" 참고용 지표에 쓰인다.

-- 수험번호 <-> 외부 아이디 매핑.
-- 명단(로스터) 업로드 파일에 "아이디" 열이 있으면 업로드할 때마다 자동으로 갱신된다.
CREATE TABLE student_external_id_map (
  exam_no               VARCHAR(50) PRIMARY KEY,
  student_external_id   VARCHAR(100) NOT NULL,
  real_name             VARCHAR(100),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_student_external_id_map_ext ON student_external_id_map (student_external_id);

-- 합격자 사례 (연도별 업로드). 한 학생이 여러 대학에 동시 합격하면 여러 행으로 들어간다.
CREATE TABLE admission_cases (
  id                    SERIAL PRIMARY KEY,
  admission_year        INTEGER NOT NULL,
  univ_name             VARCHAR(200) NOT NULL,
  dept_name             VARCHAR(200) NOT NULL,
  admission_type        VARCHAR(50),   -- 편입유형 (일반/학사 등)
  result_type           VARCHAR(50),   -- 합격여부 (최초/추가 등)
  real_name             VARCHAR(100),
  student_external_id   VARCHAR(100),
  source_campus         VARCHAR(100),
  note                  VARCHAR(200),
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (admission_year, univ_name, dept_name, student_external_id, admission_type)
);
CREATE INDEX idx_admission_cases_ext ON admission_cases (student_external_id);
CREATE INDEX idx_admission_cases_univ_dept ON admission_cases (univ_name, dept_name, admission_year);

-- 외부(편입모의고사 등) 월별 회차. 시행 대행업체 시험 1회 = 이 테이블의 1행.
CREATE TABLE external_mock_rounds (
  id            SERIAL PRIMARY KEY,
  exam_year     INTEGER NOT NULL,
  exam_month    INTEGER NOT NULL,
  label         VARCHAR(200),          -- 예: 26년 7월 편입모의고사 (참고용 표시 문구)
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (exam_year, exam_month)
);

-- 외부 모의고사 성적 (아이디 기반). 과목(영어/수학 등)별로 한 행씩.
CREATE TABLE external_mock_scores (
  id                    SERIAL PRIMARY KEY,
  round_id              INTEGER NOT NULL REFERENCES external_mock_rounds(id) ON DELETE CASCADE,
  student_external_id   VARCHAR(100) NOT NULL,
  real_name             VARCHAR(100),
  subject               VARCHAR(50) NOT NULL,   -- 영어/수학 등 (시트명 기준)
  admission_type        VARCHAR(50),             -- 편입구분 (일반/학사)
  track                 VARCHAR(50),             -- 계열 (인문/자연)
  campus_name           VARCHAR(100),
  class_name            VARCHAR(100),
  raw_score             NUMERIC,
  percentile            NUMERIC,
  overall_rank          INTEGER,
  class_rank            INTEGER,
  class_applicants      INTEGER,
  track_rank            INTEGER,
  track_applicants      INTEGER,
  class_avg             NUMERIC,
  track_avg             NUMERIC,
  top30_class_avg       NUMERIC,
  top30_track_avg       NUMERIC,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (round_id, student_external_id, subject)
);
CREATE INDEX idx_external_mock_scores_ext ON external_mock_scores (student_external_id);
