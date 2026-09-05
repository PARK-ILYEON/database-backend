const express = require('express');
const db = require('../db');
const { verifyPassword, issueToken, hashPassword } = require('../services/auth');
const { requireAdmin } = require('../middleware/requireAdmin');
const router = express.Router();

// 계정관리(관리자 계정 추가/삭제/목록)는 지정된 최고관리자 아이디로 로그인했을 때만 허용한다.
// requireAdmin이 먼저 통과돼서 req.admin이 채워진 다음에 붙는 추가 게이트.
const SUPER_ADMIN_USERNAME = 'shikw2';
function requireSuperAdmin(req, res, next) {
  if (!req.admin || req.admin.username !== SUPER_ADMIN_USERNAME) {
    return res.status(403).json({ error: '권한이 없습니다.' });
  }
  next();
}

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

// 관리자 계정 목록 (비밀번호 해시는 절대 내려주지 않는다). shikw2 계정만 조회 가능.
router.get('/accounts', requireAdmin, requireSuperAdmin, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, username, role, academy_id, created_at FROM admin_accounts ORDER BY id'
  );
  res.json(rows);
});

// 관리자 계정 추가. shikw2 계정으로 로그인했을 때만 가능하다.
router.post('/accounts', requireAdmin, requireSuperAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username, password가 필요합니다.' });
  }
  if (String(password).length < 4) {
    return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  }
  try {
    const hash = await hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO admin_accounts (username, password_hash, role, academy_id)
       VALUES ($1,$2,$3,$4)
       RETURNING id, username, role, academy_id, created_at`,
      [username, hash, role || 'staff', req.admin.academyId || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
    throw err;
  }
});

// 관리자 계정 삭제. shikw2 계정으로 로그인했을 때만 가능하고, 자기 자신은 삭제할 수 없게 막는다(실수로 전부 잠기는 것 방지).
router.delete('/accounts/:id', requireAdmin, requireSuperAdmin, async (req, res) => {
  if (Number(req.params.id) === Number(req.admin.id)) {
    return res.status(400).json({ error: '자기 자신의 계정은 삭제할 수 없습니다.' });
  }
  const { rows } = await db.query('DELETE FROM admin_accounts WHERE id=$1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: '해당 계정을 찾을 수 없습니다.' });
  res.json({ deleted: true, id: rows[0].id });
});

module.exports = router;
