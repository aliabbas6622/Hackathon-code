import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function test() {
  try {
    console.log('Testing query...');
    const res = await pool.query('SELECT 1');
    console.log('SELECT 1 success');
    
    const sessionId = '00000000-0000-0000-0000-000000000001';
    const r = await pool.query(
      `SELECT t.title, t.intent_type, t.node_id, t.updated_at, u.name AS author_name
       FROM tasks t LEFT JOIN users u ON u.id = t.author_id
       WHERE t.session_id = $1 ORDER BY t.updated_at`,
      [sessionId],
    );
    console.log('Tasks query success:', r.rows.length);
  } catch (err) {
    console.error('QUERY FAILED:', err);
  } finally {
    await pool.end();
  }
}

test();
