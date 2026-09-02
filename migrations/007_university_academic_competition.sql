-- 학사편입 경쟁률 자료. 일반(university_master.quota_general/applicants_general)과는 완전히 별도 테이블이다.
-- 같은 대학+학과 안에서도 전형이 여러 개면 줄이 여러 개로 나뉘어 있고(예: 건국대 건축학부가 2줄),
-- 이 줄들을 합치지 말고 전형별로 그대로 저장해달라는 요청에 따라 unique 제약을 두지 않는다.
-- 재업로드 시에는 해당 연도 행을 전부 지우고 새로 넣는 방식(전체 교체)으로 처리한다.
CREATE TABLE IF NOT EXISTS university_academic_competition (
  id SERIAL PRIMARY KEY,
  univ_name VARCHAR(200) NOT NULL,
  dept_name VARCHAR(200) NOT NULL,
  track VARCHAR(20),
  college VARCHAR(200),
  quota_academic INTEGER,
  applicants_academic INTEGER,
  combined_flag BOOLEAN,
  year INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uac_univ_dept_year
  ON university_academic_competition (univ_name, dept_name, year);
