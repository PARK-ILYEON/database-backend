-- "동일 기출문제 재시험" 비교 기능을 위한 테이블.
-- 올해 학생이 작년 특정 월의 모의고사 문제(기출)를 그대로 다시 풀고, 외부업체가 채점한 결과 파일을 올리면,
-- 그 원래 시행 연도/월(external_mock_scores)에 있는 합격생들의 성적과 "같은 문제 기준"으로(원점수/정답률) 비교한다.
-- 기존 external_mock_rounds/external_mock_scores 테이블과 그 기능은 전혀 건드리지 않고, 완전히 별도 테이블로 둔다.

CREATE TABLE retest_rounds (
  id                  SERIAL PRIMARY KEY,
  source_exam_year    INTEGER NOT NULL,   -- 재사용한 기출문제의 원래 시행 연도 (예: 2025)
  source_exam_month   INTEGER NOT NULL,   -- 원래 시행 월 (예: 7)
  retest_year         INTEGER NOT NULL,   -- 올해 실제로 재시험을 치른 연도
  retest_month        INTEGER,            -- 실제로 재시험을 치른 월 (선택)
  label                VARCHAR(200),
  created_at           TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE retest_scores (
  id                    SERIAL PRIMARY KEY,
  retest_round_id       INTEGER NOT NULL REFERENCES retest_rounds(id) ON DELETE CASCADE,
  student_external_id   VARCHAR(100) NOT NULL,
  exam_no               VARCHAR(50),
  real_name             VARCHAR(100),
  subject               VARCHAR(50) NOT NULL,
  admission_type        VARCHAR(50),
  track                 VARCHAR(50),
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
  UNIQUE (retest_round_id, student_external_id, subject)
);
CREATE INDEX idx_retest_scores_exam_no ON retest_scores (exam_no);
CREATE INDEX idx_retest_scores_ext ON retest_scores (student_external_id);
