-- 외부(편입모의고사) 데이터를 아이디뿐 아니라 수험번호로도 직접 매칭할 수 있도록
-- exam_no 컬럼을 추가한다. 파일에 수험번호를 같이 적어서 올리면 이 컬럼에 채워지고,
-- 학생포털/조회 시 아이디 매핑을 거치지 않고 수험번호로 바로 찾을 수 있다.
-- 기존 아이디 기반 매칭(student_external_id)은 그대로 유지 — exam_no가 없는 과거 데이터도 계속 동작한다.

ALTER TABLE external_mock_scores ADD COLUMN exam_no VARCHAR(50);
CREATE INDEX idx_external_mock_scores_exam_no ON external_mock_scores (exam_no);

ALTER TABLE admission_cases ADD COLUMN exam_no VARCHAR(50);
CREATE INDEX idx_admission_cases_exam_no ON admission_cases (exam_no);
