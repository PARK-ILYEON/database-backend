// 최초 관리자 계정 생성용 CLI (로그인 API로는 첫 계정을 만들 수 없으므로 별도 스크립트로 제공).
// 사용법: node scripts/create-admin.js <username> <password> [academy_id]
require('dotenv').config({ quiet: true });
const db = require('../src/db');
const { hashPassword } = require('../src/services/auth');

async function main() {
  const [, , username, password, academyId] = process.argv;
  if (!username || !password) {
    console.log('사용법: node scripts/create-admin.js <username> <password> [academy_id]');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const { rows } = await db.query(
    `INSERT INTO admin_accounts (username, password_hash, role, academy_id)
     VALUES ($1,$2,'staff',$3)
     ON CONFLICT (username) DO UPDATE SET password_hash=$2
     RETURNING id, username, role`,
    [username, hash, academyId ? Number(academyId) : null]
  );
  console.log('관리자 계정 생성/갱신 완료:', rows[0]);
  process.exit(0);
}

main().catch(err => { console.error('실패:', err); process.exit(1); });
