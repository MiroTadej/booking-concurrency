/**
 * Proves the double-booking guarantee against a real PostgreSQL.
 *
 * The interesting test is the last one. The first four establish the
 * constraint's shape; `serialises two concurrent confirmations` is the one that
 * demonstrates the property the application-level check cannot provide on its
 * own — two transactions racing for the same room, exactly one winner.
 *
 * Run:  docker compose up -d && npm test
 */
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const CONNECTION =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5460/booking_demo';

// Return DATE columns as 'YYYY-MM-DD' strings rather than JS Date objects, so
// assertions compare dates instead of timezone-shifted timestamps.
require('pg').types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: CONNECTION });
const sqlDir = path.join(__dirname, '..', 'sql');

let roomId;

before(async () => {
  // Rebuild from the migrations on every run, so the tests always exercise the
  // committed SQL rather than whatever state a previous run left behind.
  await pool.query('DROP TABLE IF EXISTS bookings, rooms CASCADE');
  for (const file of fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(sqlDir, file), 'utf8'));
  }
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE bookings, rooms RESTART IDENTITY CASCADE');
  const { rows } = await pool.query(
    `INSERT INTO rooms (room_number) VALUES ('101') RETURNING id`
  );
  roomId = rows[0].id;
});

const book = (client, { checkIn, checkOut, status = 'confirmed' }) =>
  client.query(
    `INSERT INTO bookings (room_id, check_in, check_out, total_price, status)
     VALUES ($1, $2, $3, 20000, $4) RETURNING id`,
    [roomId, checkIn, checkOut, status]
  );

describe('bookings_no_overlap', () => {
  test('rejects a second confirmed booking overlapping the same room', async () => {
    await book(pool, { checkIn: '2026-07-01', checkOut: '2026-07-04' });

    await assert.rejects(
      () => book(pool, { checkIn: '2026-07-03', checkOut: '2026-07-06' }),
      // 23P01 = exclusion_violation. Asserting the constraint name too, so this
      // fails loudly if the rejection ever comes from somewhere unintended.
      (err) => err.code === '23P01' && err.constraint === 'bookings_no_overlap'
    );
  });

  test('allows same-day turnover: one guest checks out as the next checks in', async () => {
    await book(pool, { checkIn: '2026-07-01', checkOut: '2026-07-04' });

    // check_in === the previous check_out. The half-open '[)' range makes this
    // valid — and it's the case a naive BETWEEN would wrongly reject.
    const { rowCount } = await book(pool, { checkIn: '2026-07-04', checkOut: '2026-07-07' });
    assert.equal(rowCount, 1);
  });

  test('allows the same room on genuinely separate dates', async () => {
    await book(pool, { checkIn: '2026-07-01', checkOut: '2026-07-04' });
    const { rowCount } = await book(pool, { checkIn: '2026-08-01', checkOut: '2026-08-04' });
    assert.equal(rowCount, 1);
  });

  test('does not constrain pending holds (they expire and are policed separately)', async () => {
    await book(pool, { checkIn: '2026-07-01', checkOut: '2026-07-04', status: 'pending' });
    const { rowCount } = await book(pool, {
      checkIn: '2026-07-02',
      checkOut: '2026-07-05',
      status: 'pending',
    });
    assert.equal(rowCount, 1);
  });

  test('serialises two concurrent confirmations — exactly one wins', async () => {
    // The race an application-level availability check cannot win alone: two
    // transactions, both checking then inserting, neither able to see the
    // other's uncommitted row.
    const a = await pool.connect();
    const b = await pool.connect();

    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      await book(a, { checkIn: '2026-08-01', checkOut: '2026-08-05' });

      // B's insert overlaps A's. It does NOT fail immediately — the index makes
      // it block until A resolves, because until then the outcome is genuinely
      // undetermined. Deliberately not awaited yet.
      const bInsert = book(b, { checkIn: '2026-08-03', checkOut: '2026-08-07' });

      await a.query('COMMIT');   // A wins the race

      // ...and now B's blocked insert resolves — as a failure.
      await assert.rejects(
        () => bInsert,
        (err) => err.code === '23P01' && err.constraint === 'bookings_no_overlap'
      );
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }

    // The guarantee, stated as a count: one confirmed booking for that room.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM bookings WHERE room_id = $1 AND status = 'confirmed'`,
      [roomId]
    );
    assert.equal(rows[0].n, 1);
  });
});
