-- The guarantee: the same room can never be sold twice for overlapping nights.
--
-- WHY THIS ISN'T DONE IN THE APPLICATION
--
-- The obvious approach is to check availability before inserting:
--
--   SELECT 1 FROM bookings
--   WHERE room_id = $1 AND check_in < $3 AND check_out > $2
--     AND status IN ('confirmed', 'checked_in');
--   -- ...if no rows, INSERT
--
-- That check is necessary but not sufficient. Under READ COMMITTED — the
-- PostgreSQL default — two concurrent transactions can BOTH run the SELECT
-- before either commits. Both see an empty result. Both insert. The room is
-- sold twice, and no amount of application-level care prevents it, because
-- neither transaction can see the other's uncommitted row.
--
-- Locking the room row (SELECT ... FOR UPDATE) would work, but it serialises
-- every booking attempt for that room behind a single lock — including the
-- overwhelming majority that don't conflict at all.
--
-- An EXCLUDE constraint pushes the invariant into the database, where the
-- conflict is detected at write time rather than guessed at read time. Two
-- racing inserts are resolved by the index: the second blocks until the first
-- commits, then fails with SQLSTATE 23P01. Non-overlapping bookings never
-- contend.
--
-- WHY THE RANGE IS HALF-OPEN
--
-- daterange(check_in, check_out, '[)') includes the check-in date and excludes
-- the check-out date, which is exactly how hotel nights work: a guest checking
-- out on the 4th does not occupy the night of the 4th. Without the '[)' the
-- constraint would reject same-day turnover — the most valuable booking pattern
-- a hotel has — and the bug would only surface on a fully booked date.
--
-- WHY PENDING BOOKINGS ARE EXCLUDED
--
-- The partial WHERE covers only inventory that is actually sold. Pending holds
-- expire after 30 minutes and are policed by the availability query instead;
-- constraining them would mean an abandoned checkout could block a room for
-- half an hour with no way to override it.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- needed to mix `=` with `&&` in one index

ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    room_id                                   WITH =,   -- same room, and
    daterange(check_in, check_out, '[)')      WITH &&   -- overlapping nights
  )
  WHERE (status IN ('confirmed', 'checked_in'));
