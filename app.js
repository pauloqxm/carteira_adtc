import {
  apenasDigitosCpf,
  formatarCpfMascara,
  validarCpf,
  validarArquivoFoto,
} from './validacao.js';
import { buscarMembroPorCpf } from './supabase.js';
import {
  initCameraUI,
  initCameraUINovo,
  getArquivoFotoAtual,
  getArquivoFotoNovo,
  limparFoto,
  limparFotoNovo,
} from './camera.js';

/** @type {object | null} */
let membroSelecionado = null;

const el = (id) => document.getElementById(id);

function mostrarEtapa(nome) {
  document.querySelectorAll('[data-etapa]').forEach((sec) => {
    sec.hidden = sec.dataset.etapa !== nome;
  });
}

function formatarDataBR(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function preencherResumo(membro) {
  el('res-nome').textContent = membro.nome_completo || '—';
  el('res-nasc').textContent = formatarDataBR(membro.data_nasc);
  el('res-batismo').textContent = formatarDataBR(membro.data_batismo);
  el('res-cargo').textContent = membro.cargo || '—';
  el('res-sexo').textContent = membro.sexo || '—';
}

function setMensagemCpF(texto, tipo) {
  const box = el('msg-cpf');
  if (!box) return;
  box.textContent = texto || '';
  box.dataset.tipo = tipo || '';
  box.hidden = !texto;
}

function setMensagemCadastro(texto, tipo) {
  const box = el('msg-cad');
  if (!box) return;
  box.textContent = texto || '';
  box.dataset.tipo = tipo || '';
  box.hidden = !texto;
}

function abrirCadastroNovoComCpf(digitosFormatados) {
  const form = el('form-cadastro-novo');
  if (form) {
    form.reset();
  }
  const cadCpf = el('cad-cpf');
  if (cadCpf) cadCpf.value = digitosFormatados;
  limparFotoNovo();
  setMensagemCadastro(
    `CPF ${digitosFormatados} não constava na base. Preencha os campos obrigatórios e anexe a foto; a secretaria analisará a solicitação.`,
    'info',
  );
  mostrarEtapa('cadastro-novo');
}

async function onBuscarCpf() {
  const input = el('cpf');
  const digitos = apenasDigitosCpf(input.value);
  input.value = formatarCpfMascara(digitos);

  const v = validarCpf(digitos);
  if (!v.valido) {
    setMensagemCpF(v.motivo, 'erro');
    membroSelecionado = null;
    return;
  }
  setMensagemCpF('Buscando…', 'info');
  membroSelecionado = null;

  try {
    const row = await buscarMembroPorCpf(digitos);
    if (!row) {
      setMensagemCpF('', '');
      abrirCadastroNovoComCpf(formatarCpfMascara(digitos));
      return;
    }
    if (!row.cpf) {
      setMensagemCpF(
        'Este cadastro não possui CPF vinculado. Procure a secretaria para atualizar seus dados.',
        'erro',
      );
      return;
    }
    membroSelecionado = row;
    setMensagemCpF('Membro encontrado.', 'ok');
    preencherResumo(row);
    limparFoto();
    mostrarEtapa('dados');
  } catch (e) {
    console.error(e);
    setMensagemCpF(
      'Erro ao consultar. Tente novamente em instantes ou contate o suporte.',
      'erro',
    );
  }
}

async function onEnviarSolicitacao() {
  if (!membroSelecionado?.id) {
    alert('Busque um membro válido antes de enviar.');
    return;
  }
  const file = getArquivoFotoAtual();
  const v = validarArquivoFoto(file);
  if (!v.valido) {
    alert(v.motivo);
    return;
  }

  const fd = new FormData();
  fd.append('membro_id', membroSelecionado.id);
  fd.append('foto', file, file.name || 'foto.jpg');

  const btn = el('btn-enviar');
  btn.disabled = true;
  try {
    const res = await fetch('/api/solicitacao', { method: 'POST', body: fd });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.mensagem || json.error || `Erro ${res.status}`);
    }
    el('protocolo-sucesso').textContent = json.protocolo || '—';
    mostrarEtapa('sucesso');
  } catch (err) {
    console.error(err);
    alert(err.message || 'Falha ao enviar solicitação.');
  } finally {
    btn.disabled = false;
  }
}

function montarFormDataCadastroNovo() {
  const fd = new FormData();
  fd.append('nome_completo', el('cad-nome')?.value?.trim() || '');
  fd.append('cpf', el('cad-cpf')?.value || '');
  fd.append('data_nasc', el('cad-data-nasc')?.value || '');
  fd.append('data_batismo', el('cad-data-batismo')?.value || '');
  fd.append('estado_civil', el('cad-estado-civil')?.value || '');
  fd.append('nacionalidade', el('cad-nacionalidade')?.value || '');
  fd.append('cargo', el('cad-cargo')?.value || '');
  fd.append('sexo', el('cad-sexo')?.value || '');

  const opcionais = [
    ['congregacao', 'cad-congregacao'],
    ['whatsapp_telefone', 'cad-whatsapp'],
    ['bairro_distrito', 'cad-bairro'],
    ['endereco', 'cad-endereco'],
    ['nome_pai', 'cad-nome-pai'],
    ['nome_mae', 'cad-nome-mae'],
    ['naturalidade', 'cad-naturalidade'],
    ['data_consag_auxiliar', 'cad-data-consag-aux'],
    ['data_consag_diacono', 'cad-data-consag-diac'],
    ['data_consag_presbitero', 'cad-data-consag-presb'],
    ['situacao_membro', 'cad-situacao'],
  ];
  for (const [key, id] of opcionais) {
    const v = el(id)?.value?.trim();
    if (v) fd.append(key, v);
  }
  return fd;
}

async function onSubmitCadastroNovo(ev) {
  ev.preventDefault();
  const file = getArquivoFotoNovo();
  const v = validarArquivoFoto(file);
  if (!v.valido) {
    alert(v.motivo);
    return;
  }

  const fd = montarFormDataCadastroNovo();
  fd.append('foto', file, file.name || 'foto.jpg');

  const btn = el('cad-btn-enviar');
  btn.disabled = true;
  try {
    const res = await fetch('/api/solicitacao-novo-membro', { method: 'POST', body: fd });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.mensagem || json.error || `Erro ${res.status}`);
    }
    el('protocolo-sucesso').textContent = json.protocolo || '—';
    setMensagemCadastro('', '');
    limparFotoNovo();
    limparFoto();
    mostrarEtapa('sucesso');
  } catch (err) {
    console.error(err);
    alert(err.message || 'Falha ao enviar solicitação.');
  } finally {
    btn.disabled = false;
  }
}

function init() {
  const protQr = new URLSearchParams(window.location.search).get('protocolo');
  if (protQr && protQr.trim()) {
    window.location.replace('/membro-qr?protocolo=' + encodeURIComponent(protQr.trim()));
    return;
  }

  const cpfInput = el('cpf');
  if (cpfInput) {
    cpfInput.addEventListener('input', () => {
      const d = apenasDigitosCpf(cpfInput.value);
      cpfInput.value = formatarCpfMascara(d);
    });
    cpfInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') onBuscarCpf();
    });
  }
  el('btn-buscar')?.addEventListener('click', onBuscarCpf);
  el('btn-voltar-cpf')?.addEventListener('click', () => {
    membroSelecionado = null;
    mostrarEtapa('cpf');
  });
  el('btn-enviar')?.addEventListener('click', onEnviarSolicitacao);
  el('btn-nova')?.addEventListener('click', () => {
    membroSelecionado = null;
    if (cpfInput) cpfInput.value = '';
    setMensagemCpF('', '');
    limparFoto();
    limparFotoNovo();
    mostrarEtapa('cpf');
  });

  el('form-cadastro-novo')?.addEventListener('submit', onSubmitCadastroNovo);
  el('cad-btn-voltar')?.addEventListener('click', () => {
    setMensagemCpF('', '');
    setMensagemCadastro('', '');
    limparFotoNovo();
    mostrarEtapa('cpf');
  });

  initCameraUI({
    onFotoPronta: () => {},
    onFotoRemovida: () => {},
  });
  initCameraUINovo({
    onFotoPronta: () => {},
    onFotoRemovida: () => {},
  });

  mostrarEtapa('cpf');
}

init();
