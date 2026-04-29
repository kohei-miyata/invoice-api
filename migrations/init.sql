-- ============================================================
-- Public schema: tenant registry
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tenants (
    id     SERIAL PRIMARY KEY,
    slug   VARCHAR(50)  UNIQUE NOT NULL,
    name   VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- provision_tenant(): create schema + tables for a new tenant
-- ============================================================
CREATE OR REPLACE FUNCTION public.provision_tenant(p_slug TEXT, p_name TEXT)
RETURNS VOID AS $$
DECLARE
    s TEXT := 'tenant_' || p_slug;
BEGIN
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', s);

    -- companies (会社マスタ)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.companies (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name                VARCHAR(255) NOT NULL,
            registration_number VARCHAR(50),
            address             TEXT,
            phone               VARCHAR(50),
            email               VARCHAR(255),
            notes               TEXT,
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        )', s);

    -- invoices (請求書)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.invoices (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            s3_key            VARCHAR(500) NOT NULL,
            original_filename VARCHAR(255),
            file_type         VARCHAR(20),
            status            VARCHAR(50) DEFAULT ''pending'',
            extracted_data    JSONB,
            company_id        UUID REFERENCES %I.companies(id) ON DELETE SET NULL,
            matching_score    FLOAT,
            created_at        TIMESTAMP DEFAULT NOW(),
            updated_at        TIMESTAMP DEFAULT NOW()
        )', s, s);

    -- approvals (承認)
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I.approvals (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            invoice_id    UUID REFERENCES %I.invoices(id) ON DELETE CASCADE,
            approver_id   VARCHAR(255) NOT NULL,
            approver_name VARCHAR(255),
            status        VARCHAR(50) DEFAULT ''pending'',
            comment       TEXT,
            created_at    TIMESTAMP DEFAULT NOW(),
            updated_at    TIMESTAMP DEFAULT NOW()
        )', s, s);

    INSERT INTO public.tenants (slug, name)
    VALUES (p_slug, p_name)
    ON CONFLICT (slug) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Default tenants for local development
-- ============================================================
SELECT public.provision_tenant('default', 'Default Tenant');
SELECT public.provision_tenant('demo', 'Demo Company');

-- Seed demo company master
SET search_path = tenant_demo, public;

INSERT INTO companies (name, registration_number, address, phone, email) VALUES
    ('株式会社サンプル',    'T1234567890123', '東京都千代田区1-1-1', '03-1234-5678', 'info@sample.co.jp'),
    ('テスト商事株式会社',  'T9876543210987', '大阪府大阪市北区2-2-2', '06-9876-5432', 'contact@test-shoji.co.jp'),
    ('デモ工業株式会社',    'T1111222233334', '愛知県名古屋市中区3-3-3', '052-111-2222', 'demo@demo-kogyo.co.jp')
ON CONFLICT DO NOTHING;

RESET search_path;
