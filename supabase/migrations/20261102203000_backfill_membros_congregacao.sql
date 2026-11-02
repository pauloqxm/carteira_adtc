-- Preenche congregacao (e situa como ATUALIZADO) a partir das solicitações / novo_membro.
-- Só atualiza membros sem congregação preenchida.

-- 1) Melhor solicitação por membro: emitida > aprovada > mais recente, com congregacao_nome
with ranked as (
  select distinct on (s.membro_id)
    s.membro_id,
    nullif(btrim(s.congregacao_nome), '') as congregacao
  from public.solicitacoes s
  where nullif(btrim(s.congregacao_nome), '') is not null
  order by
    s.membro_id,
    (s.emitida_em is not null) desc,
    (s.status_solicitacao = 'aprovada') desc,
    s.created_at desc
)
update public.membros m
set
  congregacao = r.congregacao,
  situacao_membro = coalesce(nullif(btrim(m.situacao_membro), ''), 'ATUALIZADO')
from ranked r
where m.id = r.membro_id
  and (m.congregacao is null or btrim(m.congregacao) = '');

-- 2) Fallback: congregação em novo_membro
with nm as (
  select distinct on (n.membro_id)
    n.membro_id,
    nullif(btrim(n.congregacao), '') as congregacao
  from public.novo_membro n
  where n.membro_id is not null
    and nullif(btrim(n.congregacao), '') is not null
  order by n.membro_id, n.created_at desc
)
update public.membros m
set
  congregacao = nm.congregacao,
  situacao_membro = coalesce(nullif(btrim(m.situacao_membro), ''), 'ATUALIZADO')
from nm
where m.id = nm.membro_id
  and (m.congregacao is null or btrim(m.congregacao) = '');

-- 3) Quem já tem emissão/aprovação, mas ainda sem situação: marcar ATUALIZADO
update public.membros m
set situacao_membro = 'ATUALIZADO'
where (m.situacao_membro is null or btrim(m.situacao_membro) = '')
  and exists (
    select 1
    from public.solicitacoes s
    where s.membro_id = m.id
      and (
        s.emitida_em is not null
        or s.status_solicitacao in ('aprovada', 'pendente')
      )
  );
