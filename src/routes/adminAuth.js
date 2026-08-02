const express = require('express');
const db = require('../db');
const { verifyPassword, issueToken } = require('../services/auth');
const router = express.Router();

// 관리자 로그인 → JWT 발급 (3-3: 관리자 로그인은 1차 개발 범위)
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username, password가 필요합니다.' });
  }
  const { rows } = await db.query('SELECT * FROM admin_accounts WHERE username=$1', [username]);
  const admin = rows[0];
  if (!admin) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

  const ok = await verifyPassword(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

  const token = issueToken(admin);
  res.json({ token, admin: { id: admin.id, username: admin.username, role: admin.role, academyId: admin.academy_id } });
});

module.exports = router;
