-- Administração: utilizadores do painel e registo de auditoria.
-- Acesso apenas via service role no Node (RLS ligado, sem policies públicas).
-- Bootstrap: manter ADMIN_CREDENTIALS / ADMIN_PASSWORD_SHA256 no .env;
-- criar o 1.º utilizador na UI após login, ou INSERT manual com password_sha256 = encode(digest('senha','sha256'),'hex').

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_sha256 text not null,
  nome_exibicao text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_users_username_len check (char_length(trim(username)) >= 2),
  constraint admin_users_password_sha256_hex check (password_sha256 ~ '^[0-9a-f]{64}$')
);

create unique index if not exists idx_admin_users_username_lower
  on public.admin_users (lower(username));

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_username text not null,
  acao text not null,
  entidade text not null,
  entidade_id text,
  resumo text not null default '',
  antes jsonb,
  depois jsonb
);

create index if not exists idx_audit_log_created_at on public.audit_log (created_at desc);
create index if not exists idx_audit_log_acao on public.audit_log (acao);
create index if not exists idx_audit_log_actor on public.audit_log (actor_username);

alter table public.admin_users enable row level security;
alter table public.audit_log enable row level security;
