-- Controlo de emissões: data em que a carteira aprovada foi registada como emitida.
alter table public.solicitacoes
add column if not exists emitida_em timestamptz;

create index if not exists idx_solicitacoes_emitida_em
  on public.solicitacoes (emitida_em)
  where emitida_em is not null;
