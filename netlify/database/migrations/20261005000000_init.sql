-- Kitty: Vendor Connect marketplace with decentralized checkout redirection.
-- Money is integer minor units (cents). Every provider-facing row keeps the provider's own id.

CREATE TABLE app_user (
  id          text PRIMARY KEY,                -- the identity provider's subject (sub)
  email       text,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        text NOT NULL UNIQUE REFERENCES app_user(id),
  name            text NOT NULL,
  area            text,
  about           text,
  pickup_address  text,                         -- where couriers collect portions
  pickup_phone    text,
  delivery        jsonb NOT NULL DEFAULT '{}',  -- {doordash:{on,fee,eta}, uber:{...}, pickup:{on,eta}}
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_connection (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id            uuid NOT NULL REFERENCES vendor(id),
  provider             text NOT NULL CHECK (provider IN ('stripe', 'paypal', 'adyen')),
  provider_account_id  text,
  status               text NOT NULL CHECK (status IN ('onboarding', 'pending', 'restricted', 'active', 'disconnected')),
  capabilities         jsonb NOT NULL DEFAULT '{}',
  fee_bps              integer NOT NULL DEFAULT 300 CHECK (fee_bps BETWEEN 0 AND 2000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX merchant_connection_one_live ON merchant_connection(vendor_id) WHERE status <> 'disconnected';
CREATE UNIQUE INDEX merchant_connection_account ON merchant_connection(provider, provider_account_id) WHERE provider_account_id IS NOT NULL;

CREATE TABLE item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendor(id),
  name         text NOT NULL,
  emoji        text,
  category     text,
  description  text,
  price        integer NOT NULL CHECK (price > 0),
  currency     text NOT NULL DEFAULT 'usd',
  stock        integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_vendor ON item(vendor_id) WHERE active;

CREATE TABLE group_order (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id            uuid NOT NULL REFERENCES vendor(id),
  item_id              uuid NOT NULL REFERENCES item(id),
  connection_id        uuid NOT NULL REFERENCES merchant_connection(id),
  item_name            text NOT NULL,
  item_emoji           text,
  price                integer NOT NULL,
  currency             text NOT NULL,
  seats                integer NOT NULL CHECK (seats BETWEEN 2 AND 10),
  initiator_id         text NOT NULL REFERENCES app_user(id),
  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'authorizing', 'capturing', 'captured', 'compensating', 'cancelled', 'complete')),
  cancel_reason        text,
  closed_at            timestamptz,
  authorize_by         timestamptz,
  capture_started_at   timestamptz,
  captured_at          timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  stock_taken          boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_order_status ON group_order(status, created_at DESC);
CREATE INDEX group_order_vendor ON group_order(vendor_id, created_at DESC);

CREATE TABLE cart (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_order_id   uuid NOT NULL REFERENCES group_order(id),
  shopper_id       text NOT NULL REFERENCES app_user(id),
  delivery_method  text NOT NULL CHECK (delivery_method IN ('doordash', 'uber', 'pickup')),
  delivery_fee     integer NOT NULL DEFAULT 0,
  item_share       integer,                     -- fixed when the group closes
  amount           integer,                     -- item_share + delivery_fee
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'authorized', 'captured', 'voided', 'refunded', 'cancelled')),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_order_id, shopper_id)
);
CREATE INDEX cart_shopper ON cart(shopper_id);

-- Encrypted at rest; readable only through the API by the shopper, the group's vendor and the dispatcher.
CREATE TABLE shipping_address (
  cart_id     uuid PRIMARY KEY REFERENCES cart(id) ON DELETE CASCADE,
  ciphertext  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_attempt (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id              uuid NOT NULL REFERENCES cart(id),
  provider             text NOT NULL,
  provider_session_id  text UNIQUE,
  provider_auth_id     text,
  amount               integer NOT NULL,
  fee_amount           integer NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'authorized', 'declined', 'expired', 'voided', 'captured', 'refunded')),
  decline_reason       text,
  auth_expires_at      timestamptz,
  card_brand           text,
  card_last4           text,
  return_nonce         text NOT NULL UNIQUE,
  return_used_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_attempt_cart ON payment_attempt(cart_id, created_at DESC);
CREATE INDEX payment_attempt_auth ON payment_attempt(provider, provider_auth_id);

-- Append-only record of every money movement.
CREATE TABLE ledger_entry (
  id              bigserial PRIMARY KEY,
  group_order_id  uuid NOT NULL REFERENCES group_order(id),
  cart_id         uuid REFERENCES cart(id),
  type            text NOT NULL CHECK (type IN ('authorized', 'expired', 'voided', 'captured', 'fee', 'refunded')),
  amount          integer NOT NULL,
  currency        text NOT NULL,
  provider_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_group ON ledger_entry(group_order_id);

-- Webhook inbox: deduplicated by (provider, event_id), processed asynchronously.
CREATE TABLE webhook_event (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  event_id      text NOT NULL,
  account_id    text,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  processed_at  timestamptz,
  result        text,
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_event_pending ON webhook_event(id) WHERE processed_at IS NULL;

CREATE TABLE delivery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id       uuid NOT NULL UNIQUE REFERENCES cart(id),
  courier       text NOT NULL CHECK (courier IN ('doordash', 'uber', 'pickup', 'manual')),
  external_id   text,
  status        text NOT NULL CHECK (status IN ('requested', 'ready_for_pickup', 'picked_up', 'delivered', 'failed', 'cancelled')),
  tracking_url  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_active ON delivery(status) WHERE status IN ('requested', 'picked_up');

CREATE TABLE reconciliation_result (
  id              bigserial PRIMARY KEY,
  run_at          timestamptz NOT NULL DEFAULT now(),
  group_order_id  uuid NOT NULL REFERENCES group_order(id),
  ledger_net      integer NOT NULL,
  provider_net    integer NOT NULL,
  matched         boolean NOT NULL,
  detail          text
);
