-- Trade Lock Schema for Supabase Cloud PostgreSQL.
-- Safe to reapply for a new deployment. Back up and de-duplicate legacy rows first.
CREATE TABLE IF NOT EXISTS public.licenses (
  hash text PRIMARY KEY,
  hint text NOT NULL,
  email text,
  plan text NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  payment_id text,
  order_id text,
  devices text[] DEFAULT '{}',
  revoked boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.orders (
  order_id text PRIMARY KEY,
  email text,
  plan text NOT NULL,
  status text NOT NULL,
  payment_id text,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS original_payment_id text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS original_order_id text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS reissued_from text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS revoked_reason text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS subscription_id text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS provider_plan_id text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS billing_model text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS billing_status text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS current_period_start timestamptz;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS current_period_end timestamptz;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean DEFAULT false;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS billing_event_at timestamptz;
ALTER TABLE public.licenses ADD COLUMN IF NOT EXISTS failure_reason text;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS amount bigint;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS currency text DEFAULT 'INR';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fulfillment_status text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS subscription_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS billing_model text;

-- Legacy prepaid monthly/yearly keys must stay prepaid. Only an actual Razorpay
-- subscription ID (or an already-populated subscription linkage) implies
-- recurring billing; the current plan name alone does not.
UPDATE public.licenses
   SET subscription_id = order_id
 WHERE subscription_id IS NULL AND order_id LIKE 'sub\_%' ESCAPE '\';
UPDATE public.licenses
   SET billing_model = CASE
         WHEN subscription_id IS NOT NULL OR order_id LIKE 'sub\_%' ESCAPE '\' THEN 'recurring'
         WHEN plan IN ('founder_lifetime', 'lifetime') THEN 'lifetime'
         ELSE 'prepaid'
       END
 WHERE billing_model IS NULL;
UPDATE public.licenses
   SET billing_status = CASE WHEN revoked THEN 'revoked' ELSE 'active' END
 WHERE billing_status IS NULL;
UPDATE public.licenses
   SET current_period_start = COALESCE(current_period_start, created_at),
       current_period_end = COALESCE(current_period_end, expires_at)
 WHERE current_period_start IS NULL OR current_period_end IS NULL;

UPDATE public.orders
   SET subscription_id = order_id
 WHERE subscription_id IS NULL AND order_id LIKE 'sub\_%' ESCAPE '\';
UPDATE public.orders
   SET billing_model = CASE
         WHEN subscription_id IS NOT NULL OR order_id LIKE 'sub\_%' ESCAPE '\' THEN 'recurring'
         WHEN plan IN ('founder_lifetime', 'lifetime') THEN 'lifetime'
         ELSE 'prepaid'
       END
 WHERE billing_model IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS licenses_payment_unique
  ON public.licenses(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS licenses_order_unique
  ON public.licenses(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS licenses_subscription_unique
  ON public.licenses(subscription_id) WHERE subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.processed_webhooks (
  event_id text PRIMARY KEY,
  event text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Payment history: every captured payment linked to a license/subscription.
-- Idempotent on payment_id (unique). Supports refund reconciliation of historical payments.
CREATE TABLE IF NOT EXISTS public.payment_history (
  payment_id text PRIMARY KEY,
  license_hash text NOT NULL,
  subscription_id text,
  order_id text,
  email text,
  plan text,
  amount bigint,
  currency text DEFAULT 'INR',
  captured_at timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz,
  refunded boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS payment_history_license_hash_idx ON public.payment_history(license_hash);
CREATE INDEX IF NOT EXISTS payment_history_subscription_id_idx ON public.payment_history(subscription_id) WHERE subscription_id IS NOT NULL;

-- Backfill one historical row per known payment. Active replacements are
-- preferred over revoked reissue lineage when both reference the same payment.
INSERT INTO public.payment_history (
  payment_id, license_hash, subscription_id, order_id, email, plan,
  amount, currency, captured_at, refunded, refunded_at
)
SELECT COALESCE(l.payment_id, l.original_payment_id), l.hash,
       l.subscription_id, COALESCE(l.order_id, l.original_order_id),
       l.email, l.plan, o.amount, COALESCE(o.currency, 'INR'),
       COALESCE(l.created_at, now()),
       (l.revoked_reason = 'payment_refunded'),
       CASE WHEN l.revoked_reason = 'payment_refunded' THEN l.revoked_at ELSE NULL END
  FROM public.licenses l
  LEFT JOIN public.orders o ON o.order_id = COALESCE(l.order_id, l.original_order_id)
 WHERE COALESCE(l.payment_id, l.original_payment_id) IS NOT NULL
 ORDER BY l.revoked ASC, l.created_at DESC
ON CONFLICT (payment_id) DO NOTHING;

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'licenses' AND policyname = 'service_role_all_licenses') THEN
    CREATE POLICY service_role_all_licenses ON public.licenses FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'orders' AND policyname = 'service_role_all_orders') THEN
    CREATE POLICY service_role_all_orders ON public.orders FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'processed_webhooks' AND policyname = 'service_role_all_webhooks') THEN
    CREATE POLICY service_role_all_webhooks ON public.processed_webhooks FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payment_history' AND policyname = 'service_role_all_payment_history') THEN
    CREATE POLICY service_role_all_payment_history ON public.payment_history FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- fulfill_order: atomically inserts one license and marks the order fulfilled.
-- Now includes all subscription/billing fields so a recurring license is fully
-- populated immediately; no later email-sync is needed to complete the record.
-- ON CONFLICT DO NOTHING plus unique indexes makes concurrent retries idempotent.
CREATE OR REPLACE FUNCTION public.fulfill_order(
  p_order_id text,
  p_payment_id text,
  p_email text,
  p_plan text,
  p_hash text,
  p_hint text,
  p_created_at timestamptz,
  p_expires_at timestamptz,
  p_subscription_id text DEFAULT NULL,
  p_provider_plan_id text DEFAULT NULL,
  p_billing_model text DEFAULT NULL,
  p_billing_status text DEFAULT 'active',
  p_current_period_start timestamptz DEFAULT NULL,
  p_current_period_end timestamptz DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result_hash text;
  existing_payment text;
BEGIN
  IF p_order_id IS NULL OR p_payment_id IS NULL THEN
    RAISE EXCEPTION 'order and payment are required';
  END IF;

  SELECT payment_id INTO existing_payment FROM public.orders
   WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown order %', p_order_id;
  END IF;

  -- A retry for the same order may reuse its license, but a different payment
  -- must never overwrite the original order/payment linkage.
  IF existing_payment IS NOT NULL AND existing_payment <> p_payment_id THEN
    SELECT hash INTO result_hash FROM public.licenses WHERE order_id = p_order_id;
    IF result_hash IS NULL THEN
      RAISE EXCEPTION 'order % is linked to a different payment without a license', p_order_id;
    END IF;
    RETURN result_hash;
  END IF;

  UPDATE public.orders
     SET status = 'PAID_PENDING_FULFILLMENT', payment_id = p_payment_id,
         paid_at = COALESCE(paid_at, now()), updated_at = now()
   WHERE order_id = p_order_id;

  INSERT INTO public.licenses (
    hash, hint, email, plan, created_at, expires_at, payment_id, order_id,
    subscription_id, provider_plan_id, billing_model, billing_status,
    current_period_start, current_period_end, cancel_at_period_end,
    devices, revoked
  ) VALUES (
    p_hash, p_hint, p_email, p_plan, p_created_at, p_expires_at,
    p_payment_id, p_order_id,
    p_subscription_id, p_provider_plan_id, p_billing_model,
    COALESCE(p_billing_status, 'active'),
    p_current_period_start, p_current_period_end,
    COALESCE(p_cancel_at_period_end, false),
    '{}', false
  ) ON CONFLICT DO NOTHING;

  SELECT hash INTO result_hash
    FROM public.licenses
   WHERE (p_order_id IS NOT NULL AND order_id = p_order_id)
      OR (p_subscription_id IS NOT NULL AND subscription_id = p_subscription_id)
      OR (p_payment_id IS NOT NULL AND payment_id = p_payment_id)
   ORDER BY created_at DESC
   LIMIT 1;
  IF result_hash IS NULL THEN
    RAISE EXCEPTION 'no license available for order %', p_order_id;
  END IF;

  UPDATE public.orders
     SET status = 'paid', fulfillment_status = 'FULFILLED',
         payment_id = p_payment_id, fulfilled_at = now(), updated_at = now(),
         subscription_id = COALESCE(p_subscription_id, subscription_id),
         billing_model = COALESCE(p_billing_model, billing_model)
   WHERE order_id = p_order_id;

  -- Record initial payment in history (idempotent)
  INSERT INTO public.payment_history (
    payment_id, license_hash, subscription_id, order_id, email, plan,
    amount, currency, captured_at
  ) VALUES (
    p_payment_id, result_hash, p_subscription_id, p_order_id, p_email, p_plan,
    (SELECT amount FROM public.orders WHERE order_id = p_order_id),
    COALESCE((SELECT currency FROM public.orders WHERE order_id = p_order_id), 'INR'),
    now()
  ) ON CONFLICT (payment_id) DO NOTHING;

  RETURN result_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.fulfill_order(text,text,text,text,text,text,timestamptz,timestamptz,text,text,text,text,timestamptz,timestamptz,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fulfill_order(text,text,text,text,text,text,timestamptz,timestamptz,text,text,text,text,timestamptz,timestamptz,boolean) TO service_role;

-- Drop the old 8-arg signature if it still exists (migration safety).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fulfill_order' AND pronargs = 8
  ) THEN
    DROP FUNCTION IF EXISTS public.fulfill_order(text,text,text,text,text,text,timestamptz,timestamptz);
  END IF;
END $$;


CREATE OR REPLACE FUNCTION public.register_device(
  p_hash text, p_device_id text, p_max_devices integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_devices text[];
  current_revoked boolean;
  current_expires timestamptz;
  allowed boolean;
BEGIN
  SELECT devices, revoked, expires_at INTO current_devices, current_revoked, current_expires
    FROM public.licenses WHERE hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'devices_used', 0, 'reason', 'not_found');
  END IF;
  IF current_revoked OR (current_expires IS NOT NULL AND current_expires <= now()) THEN
    RETURN jsonb_build_object('allowed', false, 'devices_used', 0, 'reason', 'inactive');
  END IF;
  current_devices := COALESCE(current_devices, '{}');
  IF p_device_id = ANY(current_devices) THEN
    RETURN jsonb_build_object('allowed', true, 'devices_used', array_length(current_devices, 1));
  END IF;
  allowed := COALESCE(array_length(current_devices, 1), 0) < GREATEST(1, p_max_devices);
  IF allowed THEN
    current_devices := array_append(current_devices, p_device_id);
    UPDATE public.licenses SET devices = current_devices WHERE hash = p_hash;
  END IF;
  RETURN jsonb_build_object('allowed', allowed, 'devices_used', COALESCE(array_length(current_devices, 1), 0));
END;
$$;

REVOKE ALL ON FUNCTION public.register_device(text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_device(text,text,integer) TO service_role;


-- reissue_license: atomically revokes the old key and inserts a replacement,
-- transferring the active subscription linkage to the replacement.
-- The old row keeps its original_* fields for payment lineage.
-- Unique indexes (order_id, payment_id, subscription_id) are handled by
-- nulling them on the old row BEFORE inserting the replacement.
CREATE OR REPLACE FUNCTION public.reissue_license(
  p_old_hash text, p_new_hash text, p_new_hint text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_row public.licenses%ROWTYPE;
BEGIN
  SELECT * INTO old_row FROM public.licenses WHERE hash = p_old_hash AND revoked = false FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active license not found'; END IF;

  -- Preserve lineage fields on the old row before nulling unique columns.
  UPDATE public.licenses
     SET revoked = true, revoked_reason = 'support_reissue', revoked_at = now(),
         billing_status = 'revoked',
         -- Null out the unique-indexed columns so the replacement can own them.
         order_id = NULL,
         payment_id = NULL,
         subscription_id = NULL,
         -- Keep original_* as historical lineage.
         original_payment_id = COALESCE(original_payment_id, old_row.payment_id),
         original_order_id   = COALESCE(original_order_id, old_row.order_id)
   WHERE hash = p_old_hash;

  -- Insert the replacement with the active subscription linkage transferred.
  INSERT INTO public.licenses (
    hash, hint, email, plan, created_at, expires_at,
    payment_id, order_id, subscription_id, provider_plan_id,
    billing_model, billing_status,
    current_period_start, current_period_end, cancel_at_period_end,
    last_payment_at, billing_event_at, failure_reason,
    cancelled_at, cancel_reason,
    original_payment_id, original_order_id,
    reissued_from, devices, revoked
  )
  SELECT p_new_hash, p_new_hint, old_row.email, old_row.plan, now(), old_row.expires_at,
         old_row.payment_id, old_row.order_id,
         old_row.subscription_id,
         old_row.provider_plan_id,
         old_row.billing_model, old_row.billing_status,
         old_row.current_period_start, old_row.current_period_end,
         old_row.cancel_at_period_end,
         old_row.last_payment_at, old_row.billing_event_at, old_row.failure_reason,
         old_row.cancelled_at, old_row.cancel_reason,
         COALESCE(old_row.original_payment_id, old_row.payment_id),
         COALESCE(old_row.original_order_id, old_row.order_id),
         old_row.hint, '{}', false;

  -- Update payment history so future webhooks find the replacement hash.
  UPDATE public.payment_history
     SET license_hash = p_new_hash
   WHERE license_hash = p_old_hash;

  RETURN p_new_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.reissue_license(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reissue_license(text,text,text) TO service_role;


-- record_payment: idempotent payment-history append (used for renewals).
CREATE OR REPLACE FUNCTION public.record_payment(
  p_payment_id text,
  p_license_hash text,
  p_subscription_id text DEFAULT NULL,
  p_order_id text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_plan text DEFAULT NULL,
  p_amount bigint DEFAULT NULL,
  p_currency text DEFAULT 'INR'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_hash text;
BEGIN
  IF p_payment_id IS NULL OR p_license_hash IS NULL THEN
    RAISE EXCEPTION 'payment and license hash are required';
  END IF;
  INSERT INTO public.payment_history (
    payment_id, license_hash, subscription_id, order_id, email, plan, amount, currency, captured_at
  ) VALUES (
    p_payment_id, p_license_hash, p_subscription_id, p_order_id, p_email, p_plan, p_amount, p_currency, now()
  ) ON CONFLICT (payment_id) DO NOTHING;

  SELECT license_hash INTO existing_hash FROM public.payment_history
   WHERE payment_id = p_payment_id FOR UPDATE;
  IF existing_hash IS DISTINCT FROM p_license_hash THEN
    RAISE EXCEPTION 'payment % is already linked to another license', p_payment_id;
  END IF;

  UPDATE public.payment_history
     SET subscription_id = COALESCE(subscription_id, p_subscription_id),
         order_id = COALESCE(order_id, p_order_id),
         email = COALESCE(email, p_email), plan = COALESCE(plan, p_plan),
         amount = COALESCE(amount, p_amount),
         currency = COALESCE(currency, p_currency, 'INR')
   WHERE payment_id = p_payment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment(text,text,text,text,text,text,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_payment(text,text,text,text,text,text,bigint,text) TO service_role;


-- mark_payment_refunded: marks a specific historical payment refunded (idempotent).
CREATE OR REPLACE FUNCTION public.mark_payment_refunded(
  p_payment_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash text;
BEGIN
  IF p_payment_id IS NULL THEN RAISE EXCEPTION 'payment is required'; END IF;
  UPDATE public.payment_history
     SET refunded = true, refunded_at = COALESCE(refunded_at, now())
   WHERE payment_id = p_payment_id
  RETURNING license_hash INTO v_hash;
  RETURN v_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_payment_refunded(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_payment_refunded(text) TO service_role;
