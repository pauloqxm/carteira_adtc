-- Carteira de membro: tabelas, RLS e bucket de fotos
-- Aplicado via Supabase CLI (db push) ou integração GitHub do projeto.

create extension if not exists "uuid-ossp";

create table if not exists public.membros (
  id uuid primary key default gen_random_uuid(),
  cod_membro integer not null unique,
  nome_completo text not null,
  cpf text,
  data_nasc date,
  nacionalidade text,
  estado_civil text,
  data_batismo date,
  cargo text,
  sexo text,
  created_at timestamptz not null default now()
);

create index if not exists idx_membros_cpf on public.membros (cpf);

create table if not exists public.solicitacoes (
  id uuid primary key default gen_random_uuid(),
  membro_id uuid not null references public.membros (id) on delete restrict,
  foto_url text not null,
  protocolo text not null unique,
  status_solicitacao text not null default 'pendente'
    check (status_solicitacao in ('pendente', 'aprovada', 'rejeitada')),
  created_at timestamptz not null default now()
);

create index if not exists idx_solicitacoes_membro on public.solicitacoes (membro_id);
create index if not exists idx_solicitacoes_status on public.solicitacoes (membro_id, status_solicitacao);

alter table public.membros enable row level security;
alter table public.solicitacoes enable row level security;

drop policy if exists "membros_select_anon" on public.membros;
create policy "membros_select_anon"
  on public.membros for select
  to anon
  using (true);

drop policy if exists "membros_select_authenticated" on public.membros;
create policy "membros_select_authenticated"
  on public.membros for select
  to authenticated
  using (true);

insert into storage.buckets (id, name, public)
values ('fotos-membros', 'fotos-membros', true)
on conflict (id) do nothing;

drop policy if exists "fotos_public_read" on storage.objects;
create policy "fotos_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'fotos-membros');

drop policy if exists "fotos_authenticated_insert" on storage.objects;
create policy "fotos_authenticated_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'fotos-membros');
