-- 대학DB(university_master)에 계열/단과대학/지원인원 정보를 추가한다.
-- "26학년도 경쟁률.xlsx" 같은, 대학별 시트로 나뉜 모집인원/지원인원/경쟁률 자료를 담기 위함.
-- 기존 컬럼(quota_general, quota_academic 등)은 전혀 건드리지 않고 컬럼만 추가한다.

ALTER TABLE university_master ADD COLUMN track VARCHAR(20);                 -- 계열 (인문/자연/예체능 등)
ALTER TABLE university_master ADD COLUMN college VARCHAR(200);              -- 단과대학/학부 (예: 경영대학)
ALTER TABLE university_master ADD COLUMN applicants_general INTEGER;        -- 일반전형 지원인원
ALTER TABLE university_master ADD COLUMN combined_flag BOOLEAN;
-- ↑ 모집인원이 "(2)"처럼 괄호로 표시된 경우 true. 학과별이 아니라 계열 통합으로 뽑는다는 의미.
-- (Railway SQL 콘솔이 "NOT NULL DEFAULT false"가 포함된 문장에서 원인 불명의 오류를 반복해서
--  DEFAULT 없이 단순하게 뒀다. 기존 행은 NULL로 남고, 앱 코드에서는 NULL을 false와 동일하게 취급한다.)
