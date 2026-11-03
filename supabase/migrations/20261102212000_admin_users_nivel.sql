-- Níveis de acesso do painel: editar (leitura+escrita) | consultar (só leitura).
-- Utilizadores existentes ficam com 'editar'.

alter table public.admin_users
  add column if not exists nivel text not null default 'editar';

alter table public.admin_users
  drop constraint if exists admin_users_nivel_check;

alter table public.admin_users
  add constraint admin_users_nivel_check
  check (nivel in ('administrador', 'editar', 'consultar'));

update public.admin_users
set nivel = 'editar'
where nivel is null or nivel not in ('administrador', 'editar', 'consultar');
