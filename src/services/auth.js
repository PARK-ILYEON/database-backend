// 3-3 보안·어뷰징 고려사항 — 관리자 로그인/세션 확인
// JWT 기반 무상태(stateless) 세션. 비밀번호는 bcrypt 해시로 저장한다.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL = process.env.ADMIN_TOKEN_TTL || '12h';

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function issueToken(admin) {
  return jwt.sign(
    { sub: admin.id, username: admin.username, role: admin.role, academyId: admin.academy_id },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // 만료/변조 시 throw
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, JWT_SECRET };
