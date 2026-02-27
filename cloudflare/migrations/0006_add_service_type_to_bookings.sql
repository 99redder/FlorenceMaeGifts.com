ALTER TABLE bookings ADD COLUMN service_type TEXT NOT NULL DEFAULT 'openclaw_setup';

CREATE INDEX IF NOT EXISTS idx_bookings_service_type ON bookings(service_type);
