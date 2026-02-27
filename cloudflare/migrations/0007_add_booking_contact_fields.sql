ALTER TABLE bookings ADD COLUMN customer_phone TEXT;
ALTER TABLE bookings ADD COLUMN preferred_contact_method TEXT NOT NULL DEFAULT 'email';
