-- Campos mínimos para dashboard e ficha de Gestão de Membros
alter table public.membros
  add column if not exists congregacao text,
  add column if not exists situacao_membro text;

create index if not exists idx_membros_congregacao on public.membros (congregacao);
create index if not exists idx_membros_situacao on public.membros (situacao_membro);
