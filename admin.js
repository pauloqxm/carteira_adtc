const STORAGE_KEY = 'carteira_admin_token';

const el = (id) => document.getElementById(id);

function getToken() {
  return sessionStorage.getItem(STORAGE_KEY) || '';
}

function setToken(t) {
  if (t) sessionStorage.setItem(STORAGE_KEY, t);
  else sessionStorage.removeItem(STORAGE_KEY);
}

function formatarCpfExibicao(digitos) {
  const d = String(digitos || '').replace(/\D/g, '');
  if (d.length !== 11) return d || '—';
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function formatarData(iso) {
  if (!iso) return '—';
  const date = new Date(String(iso));
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  return date.toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function badgeClass(status) {
  if (status === 'aprovada') return 'badge badge--aprovada';
  if (status === 'rejeitada') return 'badge badge--rejeitada';
  return 'badge badge--pendente';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** URL segura para atributo src/href (apenas http/https). */
function urlFoto(u) {
  if (!u || typeof u !== 'string') return '';
  try {
    const x = new URL(u.trim());
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return '';
    return x.href;
  } catch {
    return '';
  }
}

async function api(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    'X-Admin-Token': token,
    ...options.headers,
  };
  const res = await fetch(path, { ...options, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.mensagem || json.error || `Erro ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function fetchLista() {
  const status = el('filtro-status').value;
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return api(`/api/admin/solicitacoes${q}`);
}

function mostrarLogin(erro) {
  el('sec-login').hidden = false;
  el('sec-painel').hidden = true;
  const m = el('login-msg');
  if (erro) {
    m.textContent = erro;
    m.hidden = false;
  } else {
    m.hidden = true;
  }
}

function mostrarPainel() {
  el('sec-login').hidden = true;
  el('sec-painel').hidden = false;
}

function renderTabela(itens) {
  const tbody = el('tbody-solicitacoes');
  tbody.innerHTML = '';
  if (!itens?.length) {
    tbody.innerHTML = '<tr><td colspan="7">Nenhum registro.</td></tr>';
    return;
  }
  for (const row of itens) {
    const m = row.membros || {};
    const tr = document.createElement('tr');
    const u = urlFoto(row.foto_url);
    const fotoCell = document.createElement('td');
    if (u) {
      const a = document.createElement('a');
      a.href = u;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'admin-foto';
      img.src = u;
      img.alt = '';
      img.loading = 'lazy';
      a.appendChild(img);
      fotoCell.appendChild(a);
    } else {
      fotoCell.textContent = '—';
    }
    tr.appendChild(fotoCell);

    const tdProt = document.createElement('td');
    tdProt.innerHTML = `<strong>${escapeHtml(row.protocolo || '')}</strong>`;
    tr.appendChild(tdProt);

    const tdNome = document.createElement('td');
    tdNome.innerHTML = `${escapeHtml(m.nome_completo || '—')} <small style="color:var(--cor-texto-mudo)">#${escapeHtml(String(m.cod_membro ?? '—'))}</small>`;
    tr.appendChild(tdNome);

    const tdCpf = document.createElement('td');
    tdCpf.className = 'admin-cpf';
    tdCpf.textContent = formatarCpfExibicao(m.cpf);
    tr.appendChild(tdCpf);

    const tdData = document.createElement('td');
    tdData.textContent = formatarData(row.created_at);
    tr.appendChild(tdData);

    const tdSt = document.createElement('td');
    const sp = document.createElement('span');
    sp.className = badgeClass(row.status_solicitacao);
    sp.textContent = row.status_solicitacao || '';
    tdSt.appendChild(sp);
    tr.appendChild(tdSt);

    const tdAc = document.createElement('td');
    tdAc.className = 'admin-acoes';
    for (const { label, status, cls } of acoesPara(row.status_solicitacao)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn--mini ${cls}`;
      b.textContent = label;
      b.addEventListener('click', () => onAcao(row.id, status));
      tdAc.appendChild(b);
    }
    if (!tdAc.children.length) tdAc.textContent = '—';
    tr.appendChild(tdAc);

    tbody.appendChild(tr);
  }
}

function acoesPara(st) {
  const out = [];
  if (st !== 'aprovada') out.push({ label: 'Aprovar', status: 'aprovada', cls: 'btn--primario' });
  if (st !== 'rejeitada') out.push({ label: 'Rejeitar', status: 'rejeitada', cls: 'btn--secundario' });
  if (st !== 'pendente') out.push({ label: 'Pendente', status: 'pendente', cls: 'btn--fantasma' });
  return out;
}

async function carregarLista() {
  const msg = el('lista-msg');
  msg.hidden = true;
  const tbody = el('tbody-solicitacoes');
  tbody.innerHTML = '<tr><td colspan="7">Carregando…</td></tr>';
  try {
    const { itens } = await fetchLista();
    renderTabela(itens);
  } catch (e) {
    tbody.innerHTML = '';
    if (e.status === 401 || String(e.message).includes('Não autorizado')) {
      setToken('');
      mostrarLogin('Sessão expirada ou token inválido.');
      return;
    }
    msg.textContent = e.message || 'Erro ao carregar.';
    msg.hidden = false;
  }
}

async function onAcao(id, status) {
  if (!confirm(`Alterar status para "${status}"?`)) return;
  try {
    await api(`/api/admin/solicitacoes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status_solicitacao: status }),
    });
    await carregarLista();
  } catch (e) {
    alert(e.message || 'Falha ao atualizar.');
  }
}

function init() {
  if (getToken()) {
    mostrarPainel();
    carregarLista();
  } else {
    mostrarLogin();
  }

  el('btn-login').addEventListener('click', async () => {
    const t = el('admin-token-input').value.trim();
    if (!t) {
      mostrarLogin('Informe o token.');
      return;
    }
    setToken(t);
    try {
      const { itens } = await fetchLista();
      mostrarPainel();
      renderTabela(itens);
    } catch (e) {
      setToken('');
      mostrarLogin(
        e.status === 401 || String(e.message).includes('Não autorizado')
          ? 'Token recusado pelo servidor.'
          : e.message || 'Erro ao validar.',
      );
    }
  });

  el('btn-sair').addEventListener('click', () => {
    setToken('');
    el('admin-token-input').value = '';
    mostrarLogin();
  });

  el('btn-atualizar').addEventListener('click', () => carregarLista());
  el('filtro-status').addEventListener('change', () => carregarLista());
}

init();
