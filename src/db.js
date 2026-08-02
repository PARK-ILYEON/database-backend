// PostgreSQL 커넥션 풀. 환경변수(DATABASE_URL 또는 PG* 변수)로 접속 정보를 받는다.
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        database: process.env.PGDATABASE || 'sungjuk'
      }
);

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
