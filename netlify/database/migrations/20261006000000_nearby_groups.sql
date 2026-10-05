-- Location-based discovery, similar-group alerts and fill-by deadlines.
-- Coordinates are stored rounded to 2 decimals (about 1 km) so exact homes are never kept.

ALTER TABLE app_user
  ADD COLUMN home_lat         double precision,
  ADD COLUMN home_lng         double precision,
  ADD COLUMN home_label       text,
  ADD COLUMN alerts_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN alert_radius_km  integer NOT NULL DEFAULT 10 CHECK (alert_radius_km BETWEEN 1 AND 50);
CREATE INDEX app_user_alerts_geo ON app_user (home_lat, home_lng) WHERE alerts_enabled;

ALTER TABLE group_order
  ADD COLUMN lat         double precision,
  ADD COLUMN lng         double precision,
  ADD COLUMN area_label  text,
  ADD COLUMN radius_km   integer NOT NULL DEFAULT 10 CHECK (radius_km BETWEEN 1 AND 50),
  ADD COLUMN fill_by     timestamptz;
CREATE INDEX group_order_open_geo ON group_order (lat, lng) WHERE status = 'open';
CREATE INDEX group_order_fill_by ON group_order (fill_by) WHERE status = 'open';

CREATE TABLE notification (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL REFERENCES app_user(id),
  kind              text NOT NULL CHECK (kind IN ('similar_group', 'nearby_group', 'checkout_needed', 'hold_expired', 'group_cancelled')),
  group_order_id    uuid NOT NULL REFERENCES group_order(id),
  related_group_id  uuid REFERENCES group_order(id),
  title             text NOT NULL,
  body              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  read_at           timestamptz
);
CREATE UNIQUE INDEX notification_once ON notification (user_id, kind, group_order_id, COALESCE(related_group_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX notification_inbox ON notification (user_id, created_at DESC);
