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
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS amount bigint;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS currency text DEFAULT 'INR';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fulfillment_status text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS licenses_payment_unique
  ON public.licenses(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS licenses_order_unique
  ON public.licenses(order_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.processed_webhooks (
  event_id text PRIMARY KEY,
  event text,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_webhooks ENABLE ROW LEVEL SECURITY;

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
END $$;

-- One transaction shared by signature verification and payment.captured webhooks.
-- ON CONFLICT DO NOTHING plus the unique indexes makes concurrent retries idempotent.
CREATE OR REPLACE FUNCTION public.fulfill_order(
  p_order_id text,
  p_payment_id text,
  p_email text,
  p_plan text,
  p_hash text,
  p_hint text,
  p_created_at timestamptz,
  p_expires_at timestamptz
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
    hash, hint, email, plan, created_at, expires_at, payment_id, order_id, devices, revoked
  ) VALUES (
    p_hash, p_hint, p_email, p_plan, p_created_at, p_expires_at,
    p_payment_id, p_order_id, '{}', false
  ) ON CONFLICT DO NOTHING;

  SELECT hash INTO result_hash
    FROM public.licenses
   WHERE (p_order_id IS NOT NULL AND order_id = p_order_id)
      OR (p_payment_id IS NOT NULL AND payment_id = p_payment_id)
   ORDER BY created_at DESC
   LIMIT 1;
  IF result_hash IS NULL THEN
    RAISE EXCEPTION 'no license available for order %', p_order_id;
  END IF;

  UPDATE public.orders
     SET status = 'paid', fulfillment_status = 'FULFILLED',
         payment_id = p_payment_id, fulfilled_at = now(), updated_at = now()
   WHERE order_id = p_order_id;
  RETURN result_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.fulfill_order(text,text,text,text,text,text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fulfill_order(text,text,text,text,text,text,timestamptz,timestamptz) TO service_role;


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


CREATE OR REPLACE FUNCTION public.reissue_license(
  p_old_hash text, p_new_hash text, p_new_hint text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.licenses
     SET revoked = true, revoked_reason = 'support_reissue', revoked_at = now()
   WHERE hash = p_old_hash AND revoked = false;
  IF NOT FOUND THEN RAISE EXCEPTION 'active license not found'; END IF;

  INSERT INTO public.licenses (
    hash, hint, email, plan, created_at, expires_at,
    payment_id, order_id, original_payment_id, original_order_id,
    reissued_from, devices, revoked
  )
  SELECT p_new_hash, p_new_hint, email, plan, now(), expires_at,
         null, null, COALESCE(original_payment_id, payment_id), COALESCE(original_order_id, order_id),
         hint, '{}', false
    FROM public.licenses WHERE hash = p_old_hash;
  RETURN p_new_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.reissue_license(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reissue_license(text,text,text) TO service_role;
