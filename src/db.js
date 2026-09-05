// PostgreSQL 커넥션 풀. 환경변수(DATABASE_URL 또는 PG* 변수)로 접속 정보를 받는다.
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

// 기본값(10)은 학생들이 한꺼번에(예: 모의고사 성적 발표 직후) 몰릴 때 대기 줄이 길어질 수 있어 25로 올림.
// Railway Postgres 기본 max_connections(100) 대비 여유 있는 수준이라 안전함.
const POOL_MAX = Number(process.env.DB_POOL_MAX) || 25;

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: POOL_MAX }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        database: process.env.PGDATABASE || 'sungjuk',
        max: POOL_MAX
      }
);

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
