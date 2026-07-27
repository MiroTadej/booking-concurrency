# Never sell the same room twice

A booking system has one requirement that is trivial to state and easy to get
wrong: **the same room must never be sold for the same nights twice** — even
when two guests hit *confirm* at the same instant.

This repository is a small, runnable extract from a hotel booking platform I
built, showing how that guarantee is enforced at the database layer and, more
importantly, **the test that proves it**.

```bash
npm install
npm run db:up      # disposable PostgreSQL 18 on :5460
npm test
```

```
✔ rejects a second confirmed booking overlapping the same room
✔ allows same-day turnover: one guest checks out as the next checks in
✔ allows the same room on genuinely separate dates
✔ does not constrain pending holds (they expire and are policed separately)
✔ serialises two concurrent confirmations — exactly one wins
ℹ pass 5
```

---

## The problem with checking availability in the application

The obvious implementation reads before it writes:

```js
const clash = await db.query(
  `SELECT 1 FROM bookings
   WHERE room_id = $1 AND check_in < $3 AND check_out > $2
     AND status IN ('confirmed', 'checked_in')`,
  [roomId, checkIn, checkOut]
);
if (clash.rowCount === 0) await insertBooking(/* ... */);
```

That check is necessary, but it cannot deliver the guarantee. Under
`READ COMMITTED` — the PostgreSQL default — two concurrent transactions can
**both** run the `SELECT` before either commits. Neither can see the other's
uncommitted row, so both see zero clashes, and both insert.

The window is small. It is not theoretical: it is exactly the window that opens
when a room is nearly sold out and two people are looking at it at once.

## The fix: make the invariant the database's job

```sql
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    room_id                              WITH =,   -- same room, and
    daterange(check_in, check_out, '[)') WITH &&   -- overlapping nights
  )
  WHERE (status IN ('confirmed', 'checked_in'));
```

An `EXCLUDE` constraint detects the conflict **at write time** rather than
guessing at read time. Two racing inserts are resolved by the index: the second
blocks until the first commits, then fails with `SQLSTATE 23P01`.
Non-overlapping bookings never contend with each other.

Three details carry real weight:

**`'[)'` — the half-open range.** Includes the check-in date, excludes the
check-out date, which is how hotel nights actually work: a guest leaving on the
4th does not occupy the night of the 4th. Get this wrong and the constraint
rejects **same-day turnover** — the most valuable booking a hotel takes — and
the bug only appears on fully booked dates.

**`btree_gist`.** GiST handles the range overlap (`&&`); the extension is what
lets a plain equality (`=`) on `room_id` live in the same index.

**The partial `WHERE`.** Only sold inventory is constrained. Pending holds
expire after 30 minutes and are policed by the availability query — constraining
them would let an abandoned checkout block a room with no way to override it.

## The test that matters

Four tests establish the constraint's shape. This one demonstrates the property
the application check cannot provide:

```js
await a.query('BEGIN');
await b.query('BEGIN');

await book(a, { checkIn: '2026-08-01', checkOut: '2026-08-05' });

// B's insert overlaps A's. It does NOT fail immediately — the index makes it
// block until A resolves, because until then the outcome is undetermined.
const bInsert = book(b, { checkIn: '2026-08-03', checkOut: '2026-08-07' });

await a.query('COMMIT');   // A wins the race

await assert.rejects(
  () => bInsert,
  (err) => err.code === '23P01' && err.constraint === 'bookings_no_overlap'
);
```

Then the guarantee, stated as a count:

```js
const { rows } = await pool.query(
  `SELECT COUNT(*)::int AS n FROM bookings WHERE room_id = $1 AND status = 'confirmed'`,
  [roomId]
);
assert.equal(rows[0].n, 1);
```

**Comment out the `ALTER TABLE` in `sql/002` and two tests fail**, including
this one. That is the point: the suite fails when the guarantee is absent, so it
is evidence rather than decoration.

## The trade-off

This binds the system to PostgreSQL. `EXCLUDE USING gist` has no equivalent in
MySQL or SQLite, so moving database would mean rebuilding this guarantee
another way — most likely a serialisable transaction or an explicit lock, both
of which cost more under contention.

I take that trade knowingly. Correctness of the central invariant is worth more
than portability the project is not going to use, and the alternative —
"we check carefully in the application" — is the thing that doesn't survive
contact with two simultaneous users.

## What's here

```
sql/001_schema.sql                 minimal rooms + bookings tables
sql/002_no_overlap_constraint.sql  the constraint, with the reasoning
test/no-overlap.test.js            five tests; the last one is the race
```

No framework, no ORM, no application code — `pg` and the Node built-in test
runner, so the SQL is the subject rather than the scaffolding.

---

## Context

This is a self-contained extract, published so the reasoning can be read
without access to a private repository. The production system it comes from
adds multi-property RBAC, a Stripe payment and refund lifecycle with idempotent
webhooks, housekeeping and finance back-office modules, and a 24-suite test
suite.

**[Full case study →](https://veritydigital.ie/case-studies/hotel-booking-platform)**

## Licence

**Proprietary — all rights reserved.** © 2026 Miroslav Tadej.

Published for evaluation by prospective employers, recruiters and clients. No
licence to use, copy, modify or distribute is granted — see [LICENSE](LICENSE).

The general technique (a PostgreSQL `EXCLUDE` constraint over a `daterange`) is
public knowledge and documented by PostgreSQL; nothing here restricts your use
of the technique. What is reserved is this particular expression of it.

---

**Miroslav Tadej** — Full-stack engineer, Dublin.
[veritydigital.ie](https://veritydigital.ie) ·
[LinkedIn](https://www.linkedin.com/in/miroslavtadej) ·
[GitHub](https://github.com/MiroTadej)
