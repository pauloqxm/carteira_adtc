-- Executar no SQL Editor do Supabase (projeto: rixzxbsareoyfvjmeavu)
-- Ajuste políticas conforme a política de segurança da igreja.

-- Extensão para UUID (geralmente já habilitada)
create extension if not exists "uuid-ossp";

-- Tabela membros
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

-- Tabela solicitacoes
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

-- RLS
alter table public.membros enable row level security;
alter table public.solicitacoes enable row level security;

-- Leitura de membros para o app público (busca por CPF no cliente com anon)
drop policy if exists "membros_select_anon" on public.membros;
create policy "membros_select_anon"
  on public.membros for select
  to anon
  using (true);

-- Opcional: authenticated idem (se usar login no futuro)
drop policy if exists "membros_select_authenticated" on public.membros;
create policy "membros_select_authenticated"
  on public.membros for select
  to authenticated
  using (true);

-- solicitacoes: sem políticas para anon/authenticated — uso via service_role no servidor

-- Storage: bucket fotos-membros (criar no painel ou via SQL abaixo)
insert into storage.buckets (id, name, public)
values ('fotos-membros', 'fotos-membros', true)
on conflict (id) do nothing;

-- Políticas de storage: leitura pública; escrita só com service_role (sem policy para anon = bloqueado)
drop policy if exists "fotos_public_read" on storage.objects;
create policy "fotos_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'fotos-membros');

-- Autenticados podem enviar (se no futuro usar Supabase Auth no upload direto)
drop policy if exists "fotos_authenticated_insert" on storage.objects;
create policy "fotos_authenticated_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'fotos-membros');
