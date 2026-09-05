-- 특별전형(농어촌/재외국민/기회균형 등) 경쟁률 자료. 일반/학사와 완전히 별도 테이블이다.
-- 같은 대학+학과 안에서도 전형 종류별로 줄이 여러 개(농어촌, 재외국민 등)이므로 합치지 않고
-- 전형명을 그대로 저장하고, unique 제약을 두지 않는다.
-- 재업로드 시에는 해당 연도 행을 전부 지우고 새로 넣는 방식(전체 교체)으로 처리한다.
CREATE TABLE IF NOT EXISTS university_special_admission (
  id SERIAL PRIMARY KEY,
  univ_name VARCHAR(200) NOT NULL,
  dept_name VARCHAR(200) NOT NULL,
  admission_type VARCHAR(100),
  track VARCHAR(20),
  college VARCHAR(200),
  quota_special INTEGER,
  applicants_special INTEGER,
  combined_flag BOOLEAN,
  year INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usa_univ_dept_year
  ON university_special_admission (univ_name, dept_name, year);
