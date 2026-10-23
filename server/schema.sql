-- Trade Lock Schema for Supabase Cloud PostgreSQL
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

-- Enable Row Level Security (RLS)
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Service role full access policy
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'licenses' AND policyname = 'service_role_all_licenses'
  ) THEN
    CREATE POLICY service_role_all_licenses ON public.licenses FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'orders' AND policyname = 'service_role_all_orders'
  ) THEN
    CREATE POLICY service_role_all_orders ON public.orders FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
