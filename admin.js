import { validarCpf, apenasDigitosCpf, formatarCpfMascara } from './validacao.js';
import JSZip from 'https://esm.sh/jszip@3.10.1';

const STORAGE_KEY = 'carteira_admin_token';
const MAX_PDFS_LOTE = 40;

let loginMode = 'token';
/** Última lista carregada (para seleção em lote). */
let listaSolicitacoesAtual = [];
/** Última lista de carteiras emitidas. */
let listaEmitidasAtual = [];
/** Paginação da lista de membros. */
let membrosPage = 1;
let membrosPages = 1;
let membrosTotal = 0;
const MEMBROS_LIMIT = 50;

/** Cache do último PDF gerado `{ chave, blob, fname }` (evita gerar duas vezes ao visualizar e descarregar). */
let carteiraPdfCache = null;
let carteiraPreviewObjectUrl = null;

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
  const { skipAuth, ...fetchOpts } = options;
  const token = skipAuth ? '' : getToken();
  const headers = {
    ...fetchOpts.headers,
  };
  if (!(fetchOpts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...fetchOpts, headers });
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

function setSairVisivel(visivel) {
  el('btn-sair-top').hidden = !visivel;
}

function setTopoSub(texto) {
  const sub = el('topo-sub');
  if (sub) sub.textContent = texto;
}

function mostrarLogin(erro, alvo) {
  el('sec-login').hidden = false;
  el('sec-hub').hidden = true;
  el('sec-painel').hidden = true;
  el('sec-gestao').hidden = true;
  setSairVisivel(false);
  setTopoSub('Acesso restrito à secretaria');
  const geral = el('login-msg');
  geral.hidden = true;
  const mp = el('login-msg-pass');
  const mt = el('login-msg-token');
  mp.hidden = true;
  mt.hidden = true;
  if (erro) {
    if (alvo === 'pass') {
      mp.textContent = erro;
      mp.hidden = false;
    } else if (alvo === 'token') {
      mt.textContent = erro;
      mt.hidden = false;
    } else {
      geral.textContent = erro;
      geral.hidden = false;
    }
  }
}

function mostrarHub() {
  el('sec-login').hidden = true;
  el('sec-hub').hidden = false;
  el('sec-painel').hidden = true;
  el('sec-gestao').hidden = true;
  setSairVisivel(true);
  setTopoSub('Escolha um módulo para continuar');
}

function abrirModuloEmissao() {
  el('sec-login').hidden = true;
  el('sec-hub').hidden = true;
  el('sec-painel').hidden = false;
  el('sec-gestao').hidden = true;
  setSairVisivel(true);
  setTopoSub('Emissão de Credencial');
  switchTab('solicitacoes');
  carregarLista();
}

function abrirModuloGestao() {
  el('sec-login').hidden = true;
  el('sec-hub').hidden = true;
  el('sec-painel').hidden = true;
  el('sec-gestao').hidden = false;
  setSairVisivel(true);
  setTopoSub('Gestão de Membros');
  mostrarVistaListaMembros();
  carregarGestaoMembros();
}

/** @deprecated use mostrarHub — mantido só se algum código antigo chamar */
function mostrarPainel() {
  mostrarHub();
}

function renderKpis(totais) {
  const n = (v) => {
    const num = Number(v);
    return Number.isFinite(num) ? String(num) : '0';
  };
  const pend = el('kpi-pendentes');
  const apr = el('kpi-aprovadas');
  const rej = el('kpi-rejeitadas');
  const emi = el('kpi-emitidas');
  if (pend) pend.textContent = n(totais?.pendente);
  if (apr) apr.textContent = n(totais?.aprovada);
  if (rej) rej.textContent = n(totais?.rejeitada);
  if (emi) emi.textContent = n(totais?.emitida);
}

function atualizarUiSelecao() {
  const checks = [...document.querySelectorAll('.admin-chk-linha')];
  const n = checks.filter((c) => c.checked).length;
  const cont = el('selecao-contagem');
  const btnLote = el('btn-baixar-pdfs-lote');
  if (cont) {
    if (n > 0) {
      cont.textContent = `${n} selecionada(s)`;
      cont.hidden = false;
    } else {
      cont.hidden = true;
      cont.textContent = '';
    }
  }
  if (btnLote) btnLote.disabled = n === 0;
  const btnEmissao = el('btn-registrar-emissao');
  if (btnEmissao) {
    const elegiveis = linhasSelecionadas().filter(
      (r) => r.status_solicitacao === 'aprovada' && !r.emitida_em,
    ).length;
    btnEmissao.disabled = elegiveis === 0;
  }
  const chkTodos = el('chk-selecionar-todos');
  if (chkTodos && checks.length) {
    chkTodos.indeterminate = n > 0 && n < checks.length;
    chkTodos.checked = n === checks.length;
  } else if (chkTodos) {
    chkTodos.indeterminate = false;
    chkTodos.checked = false;
  }
}

function renderTabela(itens) {
  listaSolicitacoesAtual = itens || [];
  const tbody = el('tbody-solicitacoes');
  tbody.innerHTML = '';
  const chkTodos = el('chk-selecionar-todos');
  if (chkTodos) {
    chkTodos.checked = false;
    chkTodos.indeterminate = false;
  }
  if (!itens?.length) {
    tbody.innerHTML = '<tr><td colspan="8">Nenhum registro.</td></tr>';
    atualizarUiSelecao();
    return;
  }
  for (const row of itens) {
    const m = row.membros || {};
    const tr = document.createElement('tr');
    tr.dataset.solicitacaoId = row.id || '';

    const tdSel = document.createElement('td');
    tdSel.className = 'admin-th-sel';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'admin-chk admin-chk-linha';
    chk.dataset.solicitacaoId = row.id || '';
    chk.setAttribute('aria-label', `Selecionar ${row.protocolo || 'solicitação'}`);
    chk.addEventListener('change', atualizarUiSelecao);
    tdSel.appendChild(chk);
    tr.appendChild(tdSel);

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
    if (row.emitida_em) {
      const em = document.createElement('span');
      em.className = 'badge badge--emitida';
      em.textContent = 'emitida';
      em.title = `Emitida em ${formatarData(row.emitida_em)}`;
      tdSt.appendChild(em);
    }
    tr.appendChild(tdSt);

    const tdAc = document.createElement('td');
    tdAc.className = 'admin-acoes';
    for (const ac of acoesLinha()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn--mini ${ac.cls}`;
      b.textContent = ac.label;
      b.addEventListener('click', () => onAcao(row, ac));
      tdAc.appendChild(b);
    }
    tr.appendChild(tdAc);

    tbody.appendChild(tr);
  }
  atualizarUiSelecao();
}

function acoesLinha() {
  return [
    { label: 'Aprovar', tipo: 'patch', status: 'aprovada', cls: 'btn--primario' },
    { label: 'Rejeitar', tipo: 'patch', status: 'rejeitada', cls: 'btn--secundario' },
    { label: 'Editar', tipo: 'editar_membro', cls: 'btn--secundario' },
    { label: 'Carteira', tipo: 'carteira', cls: 'btn--secundario' },
    { label: 'Excluir', tipo: 'delete', cls: 'btn--excluir' },
  ];
}

async function carregarLista() {
  const msg = el('lista-msg');
  msg.hidden = true;
  const tbody = el('tbody-solicitacoes');
  tbody.innerHTML = '<tr><td colspan="8">Carregando…</td></tr>';
  try {
    const { itens, totais } = await fetchLista();
    renderKpis(totais);
    renderTabela(itens);
  } catch (e) {
    tbody.innerHTML = '';
    if (e.status === 401 || String(e.message).includes('Não autorizado')) {
      setToken('');
      mostrarLogin('Sessão expirada ou acesso inválido.', loginMode === 'password' ? 'pass' : 'token');
      return;
    }
    msg.textContent = e.message || 'Erro ao carregar.';
    msg.hidden = false;
  }
}

function switchTab(nome) {
  document.querySelectorAll('.admin-tab').forEach((b) => {
    b.classList.toggle('admin-tab--active', b.dataset.tab === nome);
  });
  el('tab-solicitacoes').hidden = nome !== 'solicitacoes';
  el('tab-emitidas').hidden = nome !== 'emitidas';
  el('tab-carteira').hidden = nome !== 'carteira';
  if (nome === 'emitidas') {
    carregarEmitidas();
  }
}

function renderTabelaEmitidas(itens) {
  listaEmitidasAtual = itens || [];
  const tbody = el('tbody-emitidas');
  const kpi = el('kpi-emitidas-pagina');
  if (kpi) kpi.textContent = String(listaEmitidasAtual.length);
  tbody.innerHTML = '';
  if (!itens?.length) {
    tbody.innerHTML = '<tr><td colspan="6">Nenhuma carteira emitida registada.</td></tr>';
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

    const tdEm = document.createElement('td');
    tdEm.textContent = formatarData(row.emitida_em);
    tr.appendChild(tdEm);

    const tdAc = document.createElement('td');
    tdAc.className = 'admin-acoes';
    const btnCart = document.createElement('button');
    btnCart.type = 'button';
    btnCart.className = 'btn btn--mini btn--secundario';
    btnCart.textContent = 'Carteira';
    btnCart.addEventListener('click', () => {
      switchTab('carteira');
      invalidarCacheCarteiraPdf();
      el('carteira-protocolo').value = row.protocolo || '';
      el('carteira-solicitacao-id').value = row.id || '';
      el('carteira-msg').hidden = true;
    });
    tdAc.appendChild(btnCart);

    const btnDesfazer = document.createElement('button');
    btnDesfazer.type = 'button';
    btnDesfazer.className = 'btn btn--mini btn--fantasma';
    btnDesfazer.textContent = 'Desfazer emissão';
    btnDesfazer.addEventListener('click', () => desfazerEmissao(row));
    tdAc.appendChild(btnDesfazer);

    tr.appendChild(tdAc);
    tbody.appendChild(tr);
  }
}

async function carregarEmitidas() {
  const msg = el('emitidas-msg');
  const tbody = el('tbody-emitidas');
  if (msg) {
    msg.hidden = true;
    msg.classList.remove('admin-msg--ok');
  }
  if (tbody) tbody.innerHTML = '<tr><td colspan="6">Carregando…</td></tr>';
  try {
    const { itens } = await api('/api/admin/carteiras-emitidas');
    renderTabelaEmitidas(itens);
  } catch (e) {
    if (tbody) tbody.innerHTML = '';
    if (e.status === 401 || String(e.message).includes('Não autorizado')) {
      setToken('');
      mostrarLogin('Sessão expirada ou acesso inválido.', loginMode === 'password' ? 'pass' : 'token');
      return;
    }
    if (msg) {
      msg.textContent = e.message || 'Erro ao carregar emissões.';
      msg.hidden = false;
    }
  }
}

async function registrarEmissaoSelecionadas() {
  const selecionadas = linhasSelecionadas().filter(
    (r) => r.status_solicitacao === 'aprovada' && !r.emitida_em,
  );
  const msg = el('lista-msg');
  if (!selecionadas.length) {
    if (msg) {
      msg.textContent = 'Selecione solicitações aprovadas que ainda não foram emitidas.';
      msg.classList.remove('admin-msg--ok');
      msg.hidden = false;
    }
    return;
  }
  if (
    !confirm(
      `Registar emissão de ${selecionadas.length} carteira(s) aprovada(s)? Elas aparecerão em Carteiras emitidas.`,
    )
  ) {
    return;
  }

  const btn = el('btn-registrar-emissao');
  if (btn) btn.disabled = true;
  try {
    const out = await api('/api/admin/carteiras-emitidas', {
      method: 'POST',
      body: JSON.stringify({ ids: selecionadas.map((r) => r.id) }),
    });
    if (msg) {
      const ign = out.ignoradas?.length ? ` (${out.ignoradas.length} ignorada(s))` : '';
      msg.textContent = `${out.registadas || 0} emissão(ões) registada(s)${ign}.`;
      msg.classList.add('admin-msg--ok');
      msg.hidden = false;
    }
    await carregarLista();
  } catch (e) {
    if (msg) {
      msg.textContent = e.message || 'Falha ao registar emissão.';
      msg.classList.remove('admin-msg--ok');
      msg.hidden = false;
    }
    atualizarUiSelecao();
  }
}

async function desfazerEmissao(row) {
  if (!row?.id) return;
  if (!confirm(`Remover o registo de emissão de ${row.protocolo || 'esta carteira'}?`)) return;
  const msg = el('emitidas-msg');
  try {
    await api(`/api/admin/carteiras-emitidas/${row.id}`, { method: 'DELETE' });
    if (msg) {
      msg.textContent = 'Registo de emissão removido.';
      msg.classList.add('admin-msg--ok');
      msg.hidden = false;
    }
    await carregarEmitidas();
    await carregarLista();
  } catch (e) {
    if (msg) {
      msg.textContent = e.message || 'Falha ao desfazer emissão.';
      msg.classList.remove('admin-msg--ok');
      msg.hidden = false;
    }
  }
}

function isoParaInputDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  return s.length >= 10 ? s.slice(0, 10) : '';
}

function fecharModalEditarMembro() {
  const modal = el('modal-editar-membro');
  if (modal) modal.hidden = true;
  const msg = el('edit-membro-msg');
  if (msg) {
    msg.hidden = true;
    msg.textContent = '';
  }
}

function abrirModalEditarMembro(row) {
  const m = row.membros;
  if (!m || !m.id) {
    alert('Dados do membro em falta nesta linha.');
    return;
  }
  el('edit-membro-id').value = m.id;
  el('edit-protocolo-ref').textContent = row.protocolo || '—';
  el('edit-nome').value = m.nome_completo || '';
  el('edit-cod-membro').value = m.cod_membro != null ? String(m.cod_membro) : '';
  const cpfD = apenasDigitosCpf(m.cpf);
  el('edit-cpf').value = cpfD ? formatarCpfMascara(cpfD) : '';
  el('edit-data-nasc').value = isoParaInputDate(m.data_nasc);
  el('edit-data-batismo').value = isoParaInputDate(m.data_batismo);
  el('edit-nacionalidade').value = m.nacionalidade || '';
  el('edit-estado-civil').value = m.estado_civil || '';
  el('edit-cargo').value = m.cargo || '';
  if (el('edit-telefone')) el('edit-telefone').value = m.whatsapp_telefone || '';
  if (el('edit-congregacao')) el('edit-congregacao').value = m.congregacao || '';
  if (el('edit-situacao')) el('edit-situacao').value = m.situacao_membro || '';
  const sx = String(m.sexo || '').trim();
  const sel = el('edit-sexo');
  while (sel.options.length > 4) sel.remove(4);
  const padrao = ['', 'Masculino', 'Feminino', 'Outro'];
  if (padrao.includes(sx)) sel.value = sx;
  else if (sx) {
    const opt = document.createElement('option');
    opt.value = sx;
    opt.textContent = sx;
    sel.appendChild(opt);
    sel.value = sx;
  } else sel.value = '';
  const msg = el('edit-membro-msg');
  msg.hidden = true;
  msg.textContent = '';
  el('modal-editar-membro').hidden = false;
}

async function guardarEdicaoMembro() {
  const id = el('edit-membro-id').value.trim();
  const msg = el('edit-membro-msg');
  msg.hidden = true;
  if (!id) return;

  const nome = el('edit-nome').value.trim();
  if (nome.length < 2) {
    msg.textContent = 'Indique um nome completo válido.';
    msg.hidden = false;
    return;
  }
  const cpfDigits = apenasDigitosCpf(el('edit-cpf').value);
  if (cpfDigits) {
    const v = validarCpf(cpfDigits);
    if (!v.valido) {
      msg.textContent = v.motivo || 'CPF inválido.';
      msg.hidden = false;
      return;
    }
  }

  const codRaw = el('edit-cod-membro').value.trim();
  const cod = parseInt(codRaw, 10);
  if (!Number.isInteger(cod) || cod < 1) {
    msg.textContent = 'Código de membro inválido.';
    msg.hidden = false;
    return;
  }

  const body = {
    nome_completo: nome,
    cod_membro: cod,
    cpf: cpfDigits || null,
    data_nasc: el('edit-data-nasc').value || null,
    data_batismo: el('edit-data-batismo').value || null,
    nacionalidade: el('edit-nacionalidade').value.trim() || null,
    estado_civil: el('edit-estado-civil').value.trim() || null,
    cargo: el('edit-cargo').value.trim() || null,
    sexo: el('edit-sexo').value.trim() || null,
    congregacao: el('edit-congregacao')?.value.trim() || null,
    situacao_membro: el('edit-situacao')?.value.trim() || null,
    whatsapp_telefone: el('edit-telefone')?.value.trim() || null,
  };

  const btn = el('btn-editar-guardar');
  btn.disabled = true;
  try {
    await api(`/api/admin/membros/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    fecharModalEditarMembro();
    await carregarLista();
  } catch (e) {
    msg.textContent = e.message || 'Falha ao guardar.';
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function onAcao(row, ac) {
  if (ac.tipo === 'editar_membro') {
    abrirModalEditarMembro(row);
    return;
  }
  if (ac.tipo === 'carteira') {
    switchTab('carteira');
    invalidarCacheCarteiraPdf();
    el('carteira-protocolo').value = row.protocolo || '';
    el('carteira-solicitacao-id').value = row.id || '';
    el('carteira-msg').hidden = true;
    return;
  }
  const id = row.id;
  if (ac.tipo === 'delete') {
    if (!confirm('Excluir esta solicitação permanentemente? Esta ação não pode ser desfeita.')) return;
    try {
      await api(`/api/admin/solicitacoes/${id}`, { method: 'DELETE' });
      await carregarLista();
    } catch (e) {
      alert(e.message || 'Falha ao excluir.');
    }
    return;
  }
  if (!confirm(`Alterar status para "${ac.status}"?`)) return;
  try {
    await api(`/api/admin/solicitacoes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status_solicitacao: ac.status }),
    });
    await carregarLista();
  } catch (e) {
    alert(e.message || 'Falha ao atualizar.');
  }
}

function chaveCarteiraPdf() {
  const sid = el('carteira-solicitacao-id').value.trim();
  const prot = el('carteira-protocolo').value.trim();
  return `${sid}\t${prot}`;
}

function fecharPreviewCarteira() {
  if (carteiraPreviewObjectUrl) {
    URL.revokeObjectURL(carteiraPreviewObjectUrl);
    carteiraPreviewObjectUrl = null;
  }
  const iframe = el('carteira-preview');
  iframe.src = 'about:blank';
  iframe.hidden = true;
}

function invalidarCacheCarteiraPdf() {
  carteiraPdfCache = null;
  fecharPreviewCarteira();
}

/** Extrai o nome do ficheiro de Content-Disposition (prioriza filename* UTF-8, RFC 5987). */
function parseFilenameContentDisposition(header) {
  if (!header || typeof header !== 'string') return 'carteira.pdf';
  const mStar = header.match(/filename\*\s*=\s*UTF-8''([^;\s]+)/i);
  if (mStar && mStar[1]) {
    try {
      const dec = decodeURIComponent(mStar[1].trim());
      if (dec) return dec;
    } catch {
      /* ignore */
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:\\.|[^"\\])*)"/i);
  if (quoted) return quoted[1].replace(/\\"/g, '"');
  const plain = header.match(/filename\s*=\s*([^;\s]+)/i);
  if (plain) return plain[1].trim().replace(/^"+|"+$/g, '');
  return 'carteira.pdf';
}

async function fetchBlobCarteiraPdf({ solicitacaoId = '', protocolo = '' } = {}) {
  const sid = String(solicitacaoId || '').trim();
  const prot = String(protocolo || '').trim();
  if (!sid && !prot) {
    throw new Error('Indique o protocolo ou o ID da solicitação.');
  }
  const body = sid ? { solicitacao_id: sid } : { protocolo: prot };
  const token = getToken();
  const res = await fetch('/api/admin/gerar-carteira', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.mensagem || `Erro ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition');
  const fname = parseFilenameContentDisposition(cd);
  return { blob, fname };
}

async function obterBlobCarteiraGerada() {
  const sid = el('carteira-solicitacao-id').value.trim();
  const prot = el('carteira-protocolo').value.trim();
  if (!sid && !prot) {
    throw new Error('Indique o protocolo ou use o botão Carteira numa linha da tabela.');
  }
  const chave = chaveCarteiraPdf();
  if (carteiraPdfCache && carteiraPdfCache.chave === chave) {
    return carteiraPdfCache;
  }
  const out = await fetchBlobCarteiraPdf({ solicitacaoId: sid, protocolo: prot });
  carteiraPdfCache = { chave, ...out };
  return carteiraPdfCache;
}

function linhasSelecionadas() {
  const ids = new Set(
    [...document.querySelectorAll('.admin-chk-linha:checked')]
      .map((c) => c.dataset.solicitacaoId)
      .filter(Boolean),
  );
  return listaSolicitacoesAtual.filter((r) => r.id && ids.has(r.id));
}

function nomePdfUnicoNoZip(fname, protocolo, usados) {
  let nome = fname || 'carteira.pdf';
  if (!usados.has(nome)) {
    usados.add(nome);
    return nome;
  }
  const prot = String(protocolo || 'solicitacao').replace(/[/\\:*?|"]/g, '-');
  const ext = nome.toLowerCase().endsWith('.pdf') ? '' : '.pdf';
  const base = nome.replace(/\.pdf$/i, '');
  let tentativa = `${prot} - ${base}.pdf`;
  let i = 2;
  while (usados.has(tentativa)) {
    tentativa = `${prot} - ${base} (${i}).pdf`;
    i += 1;
  }
  usados.add(tentativa);
  return tentativa;
}

async function descarregarCarteirasLote() {
  const selecionadas = linhasSelecionadas();
  const msg = el('lista-msg');
  if (!selecionadas.length) {
    if (msg) {
      msg.textContent = 'Selecione pelo menos uma solicitação na tabela.';
      msg.hidden = false;
    }
    return;
  }
  if (selecionadas.length > MAX_PDFS_LOTE) {
    if (msg) {
      msg.textContent = `Selecione no máximo ${MAX_PDFS_LOTE} solicitações por vez.`;
      msg.hidden = false;
    }
    return;
  }

  const btn = el('btn-baixar-pdfs-lote');
  const erros = [];
  const usados = new Set();
  const zip = new JSZip();
  msg.hidden = true;
  msg.classList.remove('admin-msg--ok');
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  try {
    for (let i = 0; i < selecionadas.length; i += 1) {
      const row = selecionadas[i];
      btn.textContent = `A gerar ${i + 1}/${selecionadas.length}…`;
      try {
        const { blob, fname } = await fetchBlobCarteiraPdf({
          solicitacaoId: row.id,
          protocolo: row.protocolo,
        });
        const nomeZip = nomePdfUnicoNoZip(fname, row.protocolo, usados);
        zip.file(nomeZip, blob);
      } catch (e) {
        erros.push(`${row.protocolo || row.id}: ${e.message || 'falha'}`);
      }
    }
    const totalOk = usados.size;
    if (!totalOk) {
      throw new Error(erros.join('\n') || 'Nenhum PDF foi gerado.');
    }
    btn.textContent = 'A compactar ZIP…';
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `carteiras-${stamp}.zip`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (erros.length) {
      msg.textContent = `${totalOk} PDF(s) no ZIP. Falhas: ${erros.join('; ')}`;
      msg.classList.add('admin-msg--ok');
      msg.hidden = false;
    } else {
      msg.textContent = `${totalOk} carteira(s) descarregada(s) em ZIP.`;
      msg.classList.add('admin-msg--ok');
      msg.hidden = false;
    }
  } catch (e) {
    msg.textContent = e.message || 'Falha ao gerar ZIP.';
    msg.classList.remove('admin-msg--ok');
    msg.hidden = false;
  } finally {
    btn.textContent = textoOriginal;
    atualizarUiSelecao();
  }
}

function selecionarAprovadas() {
  document.querySelectorAll('.admin-chk-linha').forEach((chk) => {
    const id = chk.dataset.solicitacaoId;
    const row = listaSolicitacoesAtual.find((r) => r.id === id);
    chk.checked = row?.status_solicitacao === 'aprovada' && !row.emitida_em;
  });
  atualizarUiSelecao();
}

function limparSelecao() {
  document.querySelectorAll('.admin-chk-linha').forEach((c) => {
    c.checked = false;
  });
  const chkTodos = el('chk-selecionar-todos');
  if (chkTodos) {
    chkTodos.checked = false;
    chkTodos.indeterminate = false;
  }
  atualizarUiSelecao();
}

function alternarSelecionarTodos() {
  const chkTodos = el('chk-selecionar-todos');
  const marcar = chkTodos?.checked;
  document.querySelectorAll('.admin-chk-linha').forEach((c) => {
    c.checked = marcar;
  });
  atualizarUiSelecao();
}

async function visualizarCarteiraPdf() {
  const msg = el('carteira-msg');
  msg.hidden = true;
  const btnV = el('btn-visualizar-pdf');
  const btnD = el('btn-gerar-pdf');
  btnV.disabled = true;
  btnD.disabled = true;
  try {
    const { blob, fname } = await obterBlobCarteiraGerada();
    fecharPreviewCarteira();
    carteiraPreviewObjectUrl = URL.createObjectURL(blob);
    const iframe = el('carteira-preview');
    iframe.src = carteiraPreviewObjectUrl;
    iframe.title = `Pré-visualização: ${fname}`;
    iframe.hidden = false;
  } catch (e) {
    msg.textContent = e.message || 'Falha ao gerar PDF.';
    msg.hidden = false;
  } finally {
    btnV.disabled = false;
    btnD.disabled = false;
  }
}

async function descarregarCarteiraPdf() {
  const msg = el('carteira-msg');
  msg.hidden = true;
  const btnV = el('btn-visualizar-pdf');
  const btnD = el('btn-gerar-pdf');
  btnV.disabled = true;
  btnD.disabled = true;
  try {
    const { blob, fname } = await obterBlobCarteiraGerada();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    msg.textContent = e.message || 'Falha ao gerar PDF.';
    msg.hidden = false;
  } finally {
    btnV.disabled = false;
    btnD.disabled = false;
  }
}

function limparCamposLogin() {
  el('admin-token-input').value = '';
  el('admin-user').value = '';
  el('admin-pass').value = '';
}

function sair() {
  setToken('');
  limparCamposLogin();
  mostrarLogin();
}

function maxTotal(itens) {
  return Math.max(1, ...itens.map((x) => Number(x.total) || 0));
}

function renderBarras(containerId, itens, { alt = false, warn = false } = {}) {
  const box = el(containerId);
  if (!box) return;
  if (!itens?.length) {
    box.innerHTML = '<p class="admin-bars__empty">Sem dados.</p>';
    return;
  }
  const max = maxTotal(itens);
  box.innerHTML = itens
    .map((item, idx) => {
      const total = Number(item.total) || 0;
      const pct = Math.round((total / max) * 100);
      let fillCls = 'admin-bars__fill';
      if (warn && idx === 1) fillCls += ' admin-bars__fill--warn';
      else if (alt && idx % 2 === 1) fillCls += ' admin-bars__fill--alt';
      return `<div class="admin-bars__row">
        <div class="admin-bars__meta">
          <span class="admin-bars__nome">${escapeHtml(item.chave)}</span>
          <span class="admin-bars__total">${total}</span>
        </div>
        <div class="admin-bars__track"><span class="${fillCls}" style="width:${pct}%"></span></div>
      </div>`;
    })
    .join('');
}

function renderRankingCongregacoes(itens) {
  const box = el('dash-congregacoes');
  if (!box) return;
  if (!itens?.length) {
    box.innerHTML = '<p class="admin-rank__empty">Sem dados de congregação.</p>';
    return;
  }
  const max = maxTotal(itens);
  box.innerHTML = itens
    .map((item) => {
      const total = Number(item.total) || 0;
      const pct = Math.round((total / max) * 100);
      return `<div class="admin-rank__row">
        <div class="admin-rank__meta">
          <span class="admin-rank__nome">${escapeHtml(item.chave)}</span>
          <span class="admin-rank__total">${total}</span>
        </div>
        <div class="admin-rank__track"><span class="admin-rank__fill" style="width:${pct}%"></span></div>
      </div>`;
    })
    .join('');
}

function renderLinhaBatismos(itens) {
  const box = el('dash-batismos');
  if (!box) return;
  if (!itens?.length) {
    box.innerHTML = '<p class="admin-line__empty">Sem datas de batismo.</p>';
    return;
  }
  const w = 320;
  const h = 128;
  const pad = 18;
  const max = Math.max(1, ...itens.map((x) => Number(x.total) || 0));
  const n = itens.length;
  const pts = itens.map((item, i) => {
    const x = pad + (n === 1 ? (w - pad * 2) / 2 : (i * (w - pad * 2)) / (n - 1));
    const y = h - pad - ((Number(item.total) || 0) / max) * (h - pad * 2);
    return { x, y, ano: item.ano, total: item.total };
  });
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const labels =
    n <= 12
      ? pts
          .map(
            (p) =>
              `<text x="${p.x.toFixed(1)}" y="${h - 4}" text-anchor="middle" fill="#94a3b8" font-size="9">${escapeHtml(String(p.ano).slice(2))}</text>`,
          )
          .join('')
      : '';
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Batismos por ano">
    <path d="${d}" fill="none" stroke="#008ad1" stroke-width="2.5" />
    ${pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#12a0e8"><title>${escapeHtml(String(p.ano))}: ${p.total}</title></circle>`).join('')}
    ${labels}
  </svg>`;
}

function renderDashCarteiras(carteiras) {
  const box = el('dash-carteiras');
  if (!box) return;
  const c = carteiras || {};
  box.innerHTML = `
    <article class="admin-kpi admin-kpi--pendente"><span class="admin-kpi__label">Pendentes</span><strong class="admin-kpi__valor">${c.pendente ?? 0}</strong></article>
    <article class="admin-kpi admin-kpi--aprovada"><span class="admin-kpi__label">Aprovadas</span><strong class="admin-kpi__valor">${c.aprovada ?? 0}</strong></article>
    <article class="admin-kpi admin-kpi--rejeitada"><span class="admin-kpi__label">Rejeitadas</span><strong class="admin-kpi__valor">${c.rejeitada ?? 0}</strong></article>
    <article class="admin-kpi admin-kpi--emitida"><span class="admin-kpi__label">Emitidas</span><strong class="admin-kpi__valor">${c.emitida ?? 0}</strong></article>
  `;
}

function renderDashboard(data) {
  el('dash-total-membros').textContent = String(data?.total ?? 0);
  renderRankingCongregacoes(data?.por_congregacao || []);
  renderBarras('dash-sexo', data?.por_sexo || [], { alt: true });
  renderBarras('dash-situacao', data?.por_situacao || [], { warn: true });
  renderBarras('dash-faixas', data?.faixas_etarias || []);
  renderBarras('dash-cargos', data?.por_cargo || []);
  renderLinhaBatismos(data?.batismos_por_ano || []);
  renderDashCarteiras(data?.carteiras);
}

async function carregarDashboardMembros() {
  const msg = el('dash-msg');
  if (msg) {
    msg.hidden = true;
    msg.classList.remove('admin-msg--ok');
  }
  try {
    const data = await api('/api/admin/membros/dashboard');
    renderDashboard(data);
  } catch (e) {
    if (e.status === 401) {
      setToken('');
      mostrarLogin('Sessão expirada ou acesso inválido.', loginMode === 'password' ? 'pass' : 'token');
      return;
    }
    if (msg) {
      msg.textContent = e.message || 'Erro ao carregar dashboard.';
      msg.hidden = false;
    }
  }
}

function preencherSelectFiltro(selectEl, valores, placeholderTodos, placeholderVazio) {
  if (!selectEl) return;
  const atual = selectEl.value;
  selectEl.innerHTML = '';
  const optTodos = document.createElement('option');
  optTodos.value = '';
  optTodos.textContent = placeholderTodos;
  selectEl.appendChild(optTodos);
  const optVazio = document.createElement('option');
  optVazio.value = '__vazio__';
  optVazio.textContent = placeholderVazio;
  selectEl.appendChild(optVazio);
  for (const v of valores || []) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  }
  if ([...selectEl.options].some((o) => o.value === atual)) selectEl.value = atual;
}

async function carregarFiltrosMembros() {
  try {
    const data = await api('/api/admin/membros/filtros');
    preencherSelectFiltro(el('membros-filtro-cong'), data.congregacoes, 'Todas', 'Sem congregação');
    preencherSelectFiltro(el('membros-filtro-sit'), data.situacoes, 'Todas', 'Sem situação');
  } catch {
    /* filtros opcionais */
  }
}

function renderTabelaMembros(itens) {
  const tbody = el('tbody-membros');
  tbody.innerHTML = '';
  if (!itens?.length) {
    tbody.innerHTML = '<tr><td colspan="7">Nenhum membro encontrado.</td></tr>';
    return;
  }
  for (const m of itens) {
    const tr = document.createElement('tr');
    tr.className = 'admin-row--click';
    tr.innerHTML = `
      <td>${escapeHtml(String(m.cod_membro ?? '—'))}</td>
      <td><strong>${escapeHtml(m.nome_completo || '—')}</strong></td>
      <td>${escapeHtml(m.congregacao || '—')}</td>
      <td>${escapeHtml(m.situacao_membro || '—')}</td>
      <td>${escapeHtml(m.whatsapp_telefone || '—')}</td>
      <td>${escapeHtml(m.sexo || '—')}</td>
      <td>${escapeHtml(m.cargo || '—')}</td>
    `;
    tr.addEventListener('click', () => abrirFichaMembro(m.id));
    tbody.appendChild(tr);
  }
}

function atualizarPaginacaoMembros() {
  const info = el('membros-pagina-info');
  const from = membrosTotal === 0 ? 0 : (membrosPage - 1) * MEMBROS_LIMIT + 1;
  const to = Math.min(membrosPage * MEMBROS_LIMIT, membrosTotal);
  if (info) info.textContent = `${from} – ${to} / ${membrosTotal}`;
  const prev = el('btn-membros-prev');
  const next = el('btn-membros-next');
  if (prev) prev.disabled = membrosPage <= 1;
  if (next) next.disabled = membrosPage >= membrosPages;
}

async function carregarListaMembros() {
  const msg = el('membros-lista-msg');
  const tbody = el('tbody-membros');
  if (msg) {
    msg.hidden = true;
    msg.classList.remove('admin-msg--ok');
  }
  if (tbody) tbody.innerHTML = '<tr><td colspan="7">Carregando…</td></tr>';
  const params = new URLSearchParams();
  params.set('page', String(membrosPage));
  params.set('limit', String(MEMBROS_LIMIT));
  const q = el('membros-q')?.value.trim() || '';
  const cong = el('membros-filtro-cong')?.value || '';
  const sit = el('membros-filtro-sit')?.value || '';
  if (q) params.set('q', q);
  if (cong) params.set('congregacao', cong);
  if (sit) params.set('situacao', sit);
  try {
    const data = await api(`/api/admin/membros?${params.toString()}`);
    membrosTotal = data.total ?? 0;
    membrosPages = data.pages ?? 1;
    membrosPage = data.page ?? 1;
    renderTabelaMembros(data.itens);
    atualizarPaginacaoMembros();
  } catch (e) {
    if (tbody) tbody.innerHTML = '';
    if (e.status === 401) {
      setToken('');
      mostrarLogin('Sessão expirada ou acesso inválido.', loginMode === 'password' ? 'pass' : 'token');
      return;
    }
    if (msg) {
      msg.textContent = e.message || 'Erro ao listar membros.';
      msg.hidden = false;
    }
  }
}

async function carregarGestaoMembros() {
  await Promise.all([carregarDashboardMembros(), carregarFiltrosMembros(), carregarListaMembros()]);
}

function mostrarVistaListaMembros() {
  el('gestao-vista-lista').hidden = false;
  el('gestao-vista-ficha').hidden = true;
}

function mostrarVistaFicha() {
  el('gestao-vista-lista').hidden = true;
  el('gestao-vista-ficha').hidden = false;
}

function setSexoSelect(sel, valor) {
  const sx = String(valor || '').trim();
  while (sel.options.length > 4) sel.remove(4);
  const padrao = ['', 'Masculino', 'Feminino', 'Outro'];
  if (padrao.includes(sx)) sel.value = sx;
  else if (sx) {
    const opt = document.createElement('option');
    opt.value = sx;
    opt.textContent = sx;
    sel.appendChild(opt);
    sel.value = sx;
  } else sel.value = '';
}

async function abrirFichaMembro(id) {
  if (!id) return;
  const msg = el('ficha-msg');
  if (msg) {
    msg.hidden = true;
    msg.classList.remove('admin-msg--ok');
  }
  mostrarVistaFicha();
  el('ficha-titulo').textContent = 'A carregar…';
  try {
    const data = await api(`/api/admin/membros/${id}`);
    const m = data.membro;
    el('ficha-membro-id').value = m.id;
    el('ficha-titulo').textContent = m.nome_completo || 'Ficha do membro';
    el('ficha-nome').value = m.nome_completo || '';
    el('ficha-cod').value = m.cod_membro != null ? String(m.cod_membro) : '';
    const cpfD = apenasDigitosCpf(m.cpf);
    el('ficha-cpf').value = cpfD ? formatarCpfMascara(cpfD) : '';
    el('ficha-telefone').value = m.whatsapp_telefone || '';
    el('ficha-congregacao').value = m.congregacao || '';
    el('ficha-situacao').value = m.situacao_membro || '';
    el('ficha-data-nasc').value = isoParaInputDate(m.data_nasc);
    el('ficha-data-batismo').value = isoParaInputDate(m.data_batismo);
    el('ficha-nacionalidade').value = m.nacionalidade || '';
    el('ficha-estado-civil').value = m.estado_civil || '';
    el('ficha-cargo').value = m.cargo || '';
    setSexoSelect(el('ficha-sexo'), m.sexo);

    const tbody = el('tbody-ficha-sols');
    tbody.innerHTML = '';
    const sols = data.solicitacoes || [];
    if (!sols.length) {
      tbody.innerHTML = '<tr><td colspan="5">Nenhuma solicitação associada.</td></tr>';
    } else {
      for (const s of sols) {
        const tr = document.createElement('tr');
        const tdProt = document.createElement('td');
        tdProt.innerHTML = `<strong>${escapeHtml(s.protocolo || '')}</strong>`;
        tr.appendChild(tdProt);
        const tdSt = document.createElement('td');
        const sp = document.createElement('span');
        sp.className = badgeClass(s.status_solicitacao);
        sp.textContent = s.status_solicitacao || '';
        tdSt.appendChild(sp);
        if (s.emitida_em) {
          const em = document.createElement('span');
          em.className = 'badge badge--emitida';
          em.textContent = 'emitida';
          tdSt.appendChild(em);
        }
        tr.appendChild(tdSt);
        const tdC = document.createElement('td');
        tdC.textContent = formatarData(s.created_at);
        tr.appendChild(tdC);
        const tdE = document.createElement('td');
        tdE.textContent = s.emitida_em ? formatarData(s.emitida_em) : '—';
        tr.appendChild(tdE);
        const tdA = document.createElement('td');
        tdA.className = 'admin-acoes';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--mini btn--secundario';
        btn.textContent = 'Carteira';
        btn.addEventListener('click', () => {
          abrirModuloEmissao();
          switchTab('carteira');
          invalidarCacheCarteiraPdf();
          el('carteira-protocolo').value = s.protocolo || '';
          el('carteira-solicitacao-id').value = s.id || '';
          el('carteira-msg').hidden = true;
        });
        tdA.appendChild(btn);
        tr.appendChild(tdA);
        tbody.appendChild(tr);
      }
    }
  } catch (e) {
    if (msg) {
      msg.textContent = e.message || 'Erro ao abrir ficha.';
      msg.hidden = false;
    }
    el('ficha-titulo').textContent = 'Ficha do membro';
  }
}

async function guardarFichaMembro() {
  const id = el('ficha-membro-id').value.trim();
  const msg = el('ficha-msg');
  msg.hidden = true;
  msg.classList.remove('admin-msg--ok');
  if (!id) return;

  const nome = el('ficha-nome').value.trim();
  if (nome.length < 2) {
    msg.textContent = 'Indique um nome completo válido.';
    msg.hidden = false;
    return;
  }
  const cpfDigits = apenasDigitosCpf(el('ficha-cpf').value);
  if (cpfDigits) {
    const v = validarCpf(cpfDigits);
    if (!v.valido) {
      msg.textContent = v.motivo || 'CPF inválido.';
      msg.hidden = false;
      return;
    }
  }
  const cod = parseInt(el('ficha-cod').value.trim(), 10);
  if (!Number.isInteger(cod) || cod < 1) {
    msg.textContent = 'Código de membro inválido.';
    msg.hidden = false;
    return;
  }

  const body = {
    nome_completo: nome,
    cod_membro: cod,
    cpf: cpfDigits || null,
    whatsapp_telefone: el('ficha-telefone').value.trim() || null,
    congregacao: el('ficha-congregacao').value.trim() || null,
    situacao_membro: el('ficha-situacao').value.trim() || null,
    data_nasc: el('ficha-data-nasc').value || null,
    data_batismo: el('ficha-data-batismo').value || null,
    nacionalidade: el('ficha-nacionalidade').value.trim() || null,
    estado_civil: el('ficha-estado-civil').value.trim() || null,
    cargo: el('ficha-cargo').value.trim() || null,
    sexo: el('ficha-sexo').value.trim() || null,
  };

  const btn = el('btn-ficha-guardar');
  btn.disabled = true;
  try {
    await api(`/api/admin/membros/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    msg.textContent = 'Alterações guardadas.';
    msg.classList.add('admin-msg--ok');
    msg.hidden = false;
    el('ficha-titulo').textContent = nome;
    await Promise.all([carregarDashboardMembros(), carregarFiltrosMembros(), carregarListaMembros()]);
  } catch (e) {
    msg.textContent = e.message || 'Falha ao guardar.';
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function carregarConfigLogin() {
  const cfg = await fetch('/api/admin/config').then((r) => r.json());
  loginMode = cfg.loginMode === 'password' ? 'password' : 'token';
  el('login-password-block').hidden = loginMode !== 'password';
  el('login-token-block').hidden = loginMode !== 'token';
  if (loginMode === 'password') {
    el('admin-user').value = cfg.defaultUsername || 'admin';
  }
}

async function init() {
  try {
    await carregarConfigLogin();
  } catch {
    loginMode = 'token';
    el('login-password-block').hidden = true;
    el('login-token-block').hidden = false;
  }

  if (getToken()) {
    mostrarHub();
  } else {
    mostrarLogin();
  }

  async function validarSessaoEEntrarNoHub() {
    await api('/api/admin/config');
    // Confirma token com um endpoint protegido leve
    await api('/api/admin/solicitacoes?status=pendente');
    mostrarHub();
  }

  el('btn-login-pass').addEventListener('click', async () => {
    const username = el('admin-user').value.trim();
    const password = el('admin-pass').value;
    if (!username || !password) {
      mostrarLogin('Preencha utilizador e senha.', 'pass');
      return;
    }
    try {
      const { token } = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        skipAuth: true,
      });
      setToken(token);
      mostrarHub();
    } catch (e) {
      setToken('');
      mostrarLogin(e.message || 'Erro ao entrar.', 'pass');
    }
  });

  el('btn-login-token').addEventListener('click', async () => {
    const t = el('admin-token-input').value.trim();
    if (!t) {
      mostrarLogin('Informe o token.', 'token');
      return;
    }
    setToken(t);
    try {
      await validarSessaoEEntrarNoHub();
    } catch (e) {
      setToken('');
      mostrarLogin(
        e.status === 401 || String(e.message).includes('Não autorizado')
          ? 'Token recusado pelo servidor.'
          : e.message || 'Erro ao validar.',
        'token',
      );
    }
  });

  const sairHandler = () => sair();
  el('btn-sair')?.addEventListener('click', sairHandler);
  el('btn-sair-top').addEventListener('click', sairHandler);

  el('hub-emissao')?.addEventListener('click', () => abrirModuloEmissao());
  el('hub-gestao')?.addEventListener('click', () => abrirModuloGestao());
  el('btn-voltar-hub-emissao')?.addEventListener('click', () => mostrarHub());
  el('btn-voltar-hub-gestao')?.addEventListener('click', () => mostrarHub());

  el('btn-atualizar').addEventListener('click', () => carregarLista());
  el('filtro-status').addEventListener('change', () => carregarLista());
  el('btn-selecionar-aprovadas')?.addEventListener('click', selecionarAprovadas);
  el('btn-limpar-selecao')?.addEventListener('click', limparSelecao);
  el('btn-registrar-emissao')?.addEventListener('click', () => registrarEmissaoSelecionadas());
  el('btn-baixar-pdfs-lote')?.addEventListener('click', () => descarregarCarteirasLote());
  el('chk-selecionar-todos')?.addEventListener('change', alternarSelecionarTodos);
  el('btn-atualizar-emitidas')?.addEventListener('click', () => carregarEmitidas());

  document.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  el('carteira-protocolo').addEventListener('input', () => {
    el('carteira-solicitacao-id').value = '';
    invalidarCacheCarteiraPdf();
  });

  el('btn-visualizar-pdf').addEventListener('click', () => visualizarCarteiraPdf());
  el('btn-gerar-pdf').addEventListener('click', () => descarregarCarteiraPdf());

  el('modal-editar-backdrop').addEventListener('click', fecharModalEditarMembro);
  el('btn-editar-cancelar').addEventListener('click', fecharModalEditarMembro);
  el('btn-editar-guardar').addEventListener('click', () => guardarEdicaoMembro());
  const cpfEdit = el('edit-cpf');
  if (cpfEdit) {
    cpfEdit.addEventListener('input', () => {
      const d = apenasDigitosCpf(cpfEdit.value);
      cpfEdit.value = d ? formatarCpfMascara(d) : '';
    });
  }

  el('btn-membros-buscar')?.addEventListener('click', () => {
    membrosPage = 1;
    carregarListaMembros();
  });
  el('btn-membros-atualizar')?.addEventListener('click', () => carregarGestaoMembros());
  el('membros-q')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      membrosPage = 1;
      carregarListaMembros();
    }
  });
  el('membros-filtro-cong')?.addEventListener('change', () => {
    membrosPage = 1;
    carregarListaMembros();
  });
  el('membros-filtro-sit')?.addEventListener('change', () => {
    membrosPage = 1;
    carregarListaMembros();
  });
  el('btn-membros-prev')?.addEventListener('click', () => {
    if (membrosPage > 1) {
      membrosPage -= 1;
      carregarListaMembros();
    }
  });
  el('btn-membros-next')?.addEventListener('click', () => {
    if (membrosPage < membrosPages) {
      membrosPage += 1;
      carregarListaMembros();
    }
  });
  el('btn-voltar-lista-membros')?.addEventListener('click', () => {
    mostrarVistaListaMembros();
    carregarListaMembros();
  });
  el('btn-ficha-guardar')?.addEventListener('click', () => guardarFichaMembro());
  const cpfFicha = el('ficha-cpf');
  if (cpfFicha) {
    cpfFicha.addEventListener('input', () => {
      const d = apenasDigitosCpf(cpfFicha.value);
      cpfFicha.value = d ? formatarCpfMascara(d) : '';
    });
  }
}

init();
