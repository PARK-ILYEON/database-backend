// 관리자 전용 API 앞단에 붙이는 인증 미들웨어.
// Authorization: Bearer <JWT> 헤더를 검사해 req.admin = {id, username, role, academyId}를 채운다.
const { verifyToken } = require('../services/auth');

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: '로그인이 필요합니다 (Authorization: Bearer <token>).' });
  }
  try {
    const payload = verifyToken(token);
    req.admin = { id: payload.sub, username: payload.username, role: payload.role, academyId: payload.academyId };
    next();
  } catch (err) {
    return res.status(401).json({ error: '유효하지 않거나 만료된 토큰입니다.' });
  }
}

/** role이 master인 계정만 통과시키는 추가 제한 (1차에는 미사용, 확장용) */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: '로그인이 필요합니다.' });
    if (req.admin.role !== role) return res.status(403).json({ error: '권한이 없습니다.' });
    next();
  };
}

module.exports = { requireAdmin, requireRole };
