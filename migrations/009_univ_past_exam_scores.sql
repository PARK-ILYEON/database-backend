-- 대학별 기출문제 점수 누적 DB. "합격자 기출점수" 파일(수험번호 x 대학+기출연도+과목 넓은 표)을
-- 업로드하면 셀 하나하나가 이 테이블의 한 행이 된다. 같은 (수험번호, 대학, 기출연도, 과목조합)이
-- 다시 올라오면 최신 값으로 덮어쓰고(정정 업로드 대응), 조합 자체가 다르면 계속 별도 행으로 쌓인다.
-- 이 학생이 실제로 어느 대학에 합격했는지는 이 테이블에 저장하지 않고, 조회할 때마다 exam_no로
-- admission_cases와 조인해서 확인한다 (합격자 명단이 나중에 갱신돼도 항상 최신 상태를 반영하도록).
CREATE TABLE IF NOT EXISTS univ_past_exam_scores (
  id SERIAL PRIMARY KEY,
  exam_no VARCHAR(50) NOT NULL,
  univ_name VARCHAR(200) NOT NULL,
  exam_year INTEGER NOT NULL,
  subject_combo VARCHAR(50) NOT NULL,
  score NUMERIC(6,1),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (exam_no, univ_name, exam_year, subject_combo)
);

CREATE INDEX IF NOT EXISTS idx_upes_univ_year ON univ_past_exam_scores (univ_name, exam_year);
CREATE INDEX IF NOT EXISTS idx_upes_exam_no ON univ_past_exam_scores (exam_no);
