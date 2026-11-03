-- Nível Administrador: único com permissão de exclusão no painel.

alter table public.admin_users
  drop constraint if exists admin_users_nivel_check;

alter table public.admin_users
  add constraint admin_users_nivel_check
  check (nivel in ('administrador', 'editar', 'consultar'));
