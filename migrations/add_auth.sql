-- ============================================================
-- Authentication: users & user_tenants
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name          VARCHAR(255),
    role          VARCHAR(50)  NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
    is_active     BOOLEAN      NOT NULL DEFAULT true,
    created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Maps non-admin users to their accessible tenants
CREATE TABLE IF NOT EXISTS public.user_tenants (
    user_id     UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    tenant_slug VARCHAR(50) NOT NULL REFERENCES public.tenants(slug) ON DELETE CASCADE,
    PRIMARY KEY (user_id, tenant_slug)
);
