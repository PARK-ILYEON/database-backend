const express = require('express');
const db = require('../db');
const router = express.Router();

// 관리자 - 특정 수험번호의 전체 회차 이력 조회.
// 같은 회차명(round_label)+연도를 공유하는 다른 반이 있으면(=통합성적표 대상), 그 반들을 합친
// 전체 인원 기준 등수(combined_rank)도 같이 계산해서 내려준다.
router.get('/:exam_no/history', async (req, res) => {
  const { exam_no } = req.params;
  const { rows } = await db.query(
    `SELECT ss.*, er.round_label, er.exam_year, er.exam_date, c.class_name, p.name AS professor_name,
       (SELECT COUNT(DISTINCT er2.id)::int
        FROM exam_rounds er2
        WHERE er2.round_label = er.round_label AND er2.exam_year = er.exam_year
       ) AS class_count,
       (SELECT COUNT(*)+1 FROM student_scores ss2
        JOIN exam_rounds er2 ON er2.id = ss2.exam_round_id
        WHERE er2.round_label = er.round_label AND er2.exam_year = er.exam_year
          AND ss2.total_score > ss.total_score
       )::int AS combined_rank,
       (SELECT COUNT(*) FROM student_scores ss3
        JOIN exam_rounds er3 ON er3.id = ss3.exam_round_id
        WHERE er3.round_label = er.round_label AND er3.exam_year = er.exam_year
       )::int AS combined_student_count,
       (SELECT COUNT(*) FROM student_scores ss4
        JOIN exam_rounds er4 ON er4.id = ss4.exam_round_id
        WHERE er4.round_label = er.round_label AND er4.exam_year = er.exam_year
          AND ss4.total_score <= ss.total_score
       )::int AS combined_le_count
     FROM student_scores ss
     JOIN exam_rounds er ON er.id = ss.exam_round_id
     JOIN classes c ON c.id = er.class_id
     JOIN professors p ON p.id = c.professor_id
     WHERE ss.exam_no = $1
     ORDER BY er.exam_date ASC NULLS LAST`,
    [exam_no]
  );
  const mapped = rows.map(r => {
    const combinedPercentile = r.combined_student_count > 0
      ? Math.round((r.combined_le_count / r.combined_student_count) * 1000) / 10
      : null;
    const { combined_le_count, ...rest } = r;
    return { ...rest, combined_percentile: combinedPercentile };
  });
  res.json(mapped);
});

module.exports = router;
