import { validarCpf, apenasDigitosCpf, formatarCpfMascara } from './validacao.js';
import JSZip from 'https://esm.sh/jszip@3.10.1';

const STORAGE_KEY = 'carteira_admin_token';
const MAX_PDFS_LOTE = 40;

let loginMode = 'token';
/** Última lista carregada (para seleção em lote). */
let listaSolicitacoesAtual = [];

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

function mostrarLogin(erro, alvo) {
  el('sec-login').hidden = false;
  el('sec-painel').hidden = true;
  setSairVisivel(false);
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

function mostrarPainel() {
  el('sec-login').hidden = true;
  el('sec-painel').hidden = false;
  setSairVisivel(true);
}

function renderKpis(totais) {
  const n = (v) => {
    const num = Number(v);
    return Number.isFinite(num) ? String(num) : '0';
  };
  const pend = el('kpi-pendentes');
  const apr = el('kpi-aprovadas');
  const rej = el('kpi-rejeitadas');
  if (pend) pend.textContent = n(totais?.pendente);
  if (apr) apr.textContent = n(totais?.aprovada);
  if (rej) rej.textContent = n(totais?.rejeitada);
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
  el('tab-carteira').hidden = nome !== 'carteira';
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
    chk.checked = row?.status_solicitacao === 'aprovada';
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
    mostrarPainel();
    carregarLista();
  } else {
    mostrarLogin();
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
      const { itens } = await fetchLista();
      mostrarPainel();
      renderTabela(itens);
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
      const { itens } = await fetchLista();
      mostrarPainel();
      renderTabela(itens);
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
  el('btn-sair').addEventListener('click', sairHandler);
  el('btn-sair-top').addEventListener('click', sairHandler);

  el('btn-atualizar').addEventListener('click', () => carregarLista());
  el('filtro-status').addEventListener('change', () => carregarLista());
  el('btn-selecionar-aprovadas')?.addEventListener('click', selecionarAprovadas);
  el('btn-limpar-selecao')?.addEventListener('click', limparSelecao);
  el('btn-baixar-pdfs-lote')?.addEventListener('click', () => descarregarCarteirasLote());
  el('chk-selecionar-todos')?.addEventListener('change', alternarSelecionarTodos);

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
}

init();
