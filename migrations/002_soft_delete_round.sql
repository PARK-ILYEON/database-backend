-- 회차 삭제를 소프트 삭제로 처리한다.
-- 관리자 화면의 "삭제" 버튼을 눌러도 실제 행은 DB에서 지우지 않고 status만 'deleted'로 바꾼다.
-- 그래서 DB에 직접 접속하는 관리자는 삭제된 회차도 그대로 조회할 수 있고,
-- 필요하면 status를 다시 'draft'/'published'로 되돌려 복구할 수 있다.
ALTER TABLE exam_rounds DROP CONSTRAINT IF EXISTS exam_rounds_status_check;
ALTER TABLE exam_rounds ADD CONSTRAINT exam_rounds_status_check
  CHECK (status IN ('draft','published','deleted'));
