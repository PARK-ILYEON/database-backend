const express = require('express');
const db = require('../db');
const router = express.Router();

// 관리자 - 특정 수험번호의 전체 회차 이력 조회
router.get('/:exam_no/history', async (req, res) => {
  const { exam_no } = req.params;
  const { rows } = await db.query(
    `SELECT ss.*, er.round_label, er.exam_year, er.exam_date, c.class_name, p.name AS professor_name
     FROM student_scores ss
     JOIN exam_rounds er ON er.id = ss.exam_round_id
     JOIN classes c ON c.id = er.class_id
     JOIN professors p ON p.id = c.professor_id
     WHERE ss.exam_no = $1
     ORDER BY er.exam_date ASC NULLS LAST`,
    [exam_no]
  );
  res.json(rows);
});

module.exports = router;
