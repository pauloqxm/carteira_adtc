-- Cadastro público quando o CPF ainda não existe em membros (espelha template_cadastro.csv + ligação à solicitação)

create table if not exists public.novo_membro (
  id uuid primary key default gen_random_uuid(),
  membro_id uuid references public.membros (id) on delete set null,
  protocolo text not null unique,
  foto_url text not null,
  cod_membro integer not null,
  nome_completo text not null,
  cpf text not null,
  data_nasc date not null,
  data_batismo date not null,
  estado_civil text not null,
  nacionalidade text not null,
  cargo text not null,
  sexo text not null,
  whatsapp_telefone text,
  bairro_distrito text,
  endereco text,
  nome_pai text,
  nome_mae text,
  naturalidade text,
  congregacao text,
  data_consag_auxiliar date,
  data_consag_diacono date,
  data_consag_presbitero date,
  situacao_membro text,
  created_at timestamptz not null default now()
);

create index if not exists idx_novo_membro_cpf on public.novo_membro (cpf);
create index if not exists idx_novo_membro_membro on public.novo_membro (membro_id);

alter table public.novo_membro enable row level security;
