-- Minimal schema for the double-booking demonstration.
--
-- This is a reduced extract: the production table carries ~30 more columns
-- (guest details, payment ids, channel, cancellation metadata). Everything the
-- concurrency guarantee depends on is here and nothing else, so the constraint
-- can be read without wading through the rest.

CREATE TABLE rooms (
  id          SERIAL PRIMARY KEY,
  room_number TEXT NOT NULL UNIQUE
);

CREATE TABLE bookings (
  id          SERIAL PRIMARY KEY,
  room_id     INT  NOT NULL REFERENCES rooms(id),
  check_in    DATE NOT NULL,
  check_out   DATE NOT NULL,
  -- Money is stored as integer cents, never a float: 1/100th of a currency
  -- unit is the smallest thing anyone is billed for, and floating point can't
  -- represent 0.10 exactly. Formatting to "€120.00" is a presentation concern.
  total_price INT  NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A stay must last at least one night. Enforced here rather than only in the
  -- application, because "the database should never hold a row that violates
  -- this" is a different claim from "our code doesn't write one".
  CONSTRAINT check_dates CHECK (check_out > check_in)
);

CREATE INDEX idx_bookings_room_dates ON bookings (room_id, check_in, check_out);
