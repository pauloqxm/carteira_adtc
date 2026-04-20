import { TAMANHO_MAX_FOTO_BYTES, TIPOS_FOTO_ACEITOS, validarArquivoFoto } from './validacao.js';

/** Largura × altura finais 3×4 (retrato), proporcionais ao padrão de carteirinha. */
const SAIDA_3X4_LARGURA = 768;
const SAIDA_3X4_ALTURA = 1024;

const IDS_MEMBRO_EXISTENTE = {
  inputCamera: 'input-foto-camera',
  inputGaleria: 'input-foto-galeria',
  preview: 'preview-foto',
  previewWrap: 'foto-preview-wrap',
  btnCamera: 'btn-abrir-camera',
  btnGaleria: 'btn-escolher-foto',
  btnRefazer: 'btn-refazer-foto',
};

const IDS_CADASTRO_NOVO = {
  inputCamera: 'cad-input-foto-camera',
  inputGaleria: 'cad-input-foto-galeria',
  preview: 'cad-preview-foto',
  previewWrap: 'cad-foto-preview-wrap',
  btnCamera: 'cad-btn-abrir-camera',
  btnGaleria: 'cad-btn-escolher-foto',
  btnRefazer: 'cad-btn-refazer-foto',
};

/**
 * @param {typeof IDS_MEMBRO_EXISTENTE} ids
 */
function criarFotoSlot(ids) {
  let arquivoAtual = null;

  function limparValorInputs() {
    const ic = document.getElementById(ids.inputCamera);
    const ig = document.getElementById(ids.inputGaleria);
    if (ic) ic.value = '';
    if (ig) ig.value = '';
  }

  function mostrarPreview(imgEl, wrapEl, file) {
    const url = URL.createObjectURL(file);
    if (imgEl.dataset.revokeUrl) URL.revokeObjectURL(imgEl.dataset.revokeUrl);
    imgEl.dataset.revokeUrl = url;
    imgEl.src = url;
    imgEl.hidden = false;
    if (wrapEl) wrapEl.hidden = false;
  }

  return {
    init({ onFotoPronta, onFotoRemovida }) {
      const inputCamera = document.getElementById(ids.inputCamera);
      const inputGaleria = document.getElementById(ids.inputGaleria);
      const preview = document.getElementById(ids.preview);
      const wrap = document.getElementById(ids.previewWrap);
      const btnCamera = document.getElementById(ids.btnCamera);
      const btnGaleria = document.getElementById(ids.btnGaleria);
      const btnRefazer = document.getElementById(ids.btnRefazer);

      if (!inputCamera || !inputGaleria || !preview || !btnCamera || !btnGaleria || !btnRefazer) return;

      const accept = TIPOS_FOTO_ACEITOS.join(',');
      inputCamera.setAttribute('accept', accept);
      inputGaleria.setAttribute('accept', accept);

      const aoEscolherFicheiro = async (inputEl) => {
        const file = inputEl.files?.[0];
        if (!file) return;
        let f = file;
        const v = validarArquivoFoto(f);
        if (!v.valido) {
          alert(v.motivo);
          limparValorInputs();
          return;
        }
        try {
          f = await recortarParaFormato3x4(f);
        } catch (e) {
          console.error(e);
          alert(e.message || 'Não foi possível ajustar a foto ao formato 3×4.');
          limparValorInputs();
          return;
        }
        if (f.size > TAMANHO_MAX_FOTO_BYTES) {
          f = await comprimirImagemAteLimite(f, TAMANHO_MAX_FOTO_BYTES);
        }
        arquivoAtual = f;
        mostrarPreview(preview, wrap, f);
        btnRefazer.hidden = false;
        limparValorInputs();
        onFotoPronta?.(f);
      };

      inputCamera.addEventListener('change', () => aoEscolherFicheiro(inputCamera));
      inputGaleria.addEventListener('change', () => aoEscolherFicheiro(inputGaleria));

      btnCamera.addEventListener('click', () => inputCamera.click());
      btnGaleria.addEventListener('click', () => inputGaleria.click());

      btnRefazer.addEventListener('click', () => {
        limparValorInputs();
        arquivoAtual = null;
        preview.removeAttribute('src');
        preview.hidden = true;
        if (wrap) wrap.hidden = true;
        btnRefazer.hidden = true;
        onFotoRemovida?.();
      });
    },

    getArquivo() {
      return arquivoAtual;
    },

    limpar() {
      limparValorInputs();
      const preview = document.getElementById(ids.preview);
      const wrap = document.getElementById(ids.previewWrap);
      const btnRefazer = document.getElementById(ids.btnRefazer);
      arquivoAtual = null;
      if (preview) {
        preview.removeAttribute('src');
        preview.hidden = true;
      }
      if (wrap) wrap.hidden = true;
      if (btnRefazer) btnRefazer.hidden = true;
    },
  };
}

const slotMembro = criarFotoSlot(IDS_MEMBRO_EXISTENTE);
const slotNovo = criarFotoSlot(IDS_CADASTRO_NOVO);

export function initCameraUI(opts) {
  slotMembro.init(opts);
}

export function initCameraUINovo(opts) {
  slotNovo.init(opts);
}

export function getArquivoFotoAtual() {
  return slotMembro.getArquivo();
}

export function getArquivoFotoNovo() {
  return slotNovo.getArquivo();
}

export function limparFoto() {
  slotMembro.limpar();
}

export function limparFotoNovo() {
  slotNovo.limpar();
}

async function recortarParaFormato3x4(file) {
  const bitmap = await createImageBitmap(file);
  const iw = bitmap.width;
  const ih = bitmap.height;
  if (iw < 2 || ih < 2) {
    bitmap.close();
    throw new Error('Imagem demasiado pequena.');
  }

  const ratioWporH = 3 / 4;
  const imRatio = iw / ih;
  let sx;
  let sy;
  let sw;
  let sh;

  if (imRatio > ratioWporH) {
    sh = ih;
    sw = Math.round(ih * ratioWporH);
    sx = Math.round((iw - sw) / 2);
    sy = 0;
  } else {
    sw = iw;
    sh = Math.round(iw / ratioWporH);
    sx = 0;
    sy = Math.round((ih - sh) / 2);
  }

  const canvas = document.createElement('canvas');
  canvas.width = SAIDA_3X4_LARGURA;
  canvas.height = SAIDA_3X4_ALTURA;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, SAIDA_3X4_LARGURA, SAIDA_3X4_ALTURA);
  bitmap.close();

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
  });
  if (!blob) {
    throw new Error('Não foi possível exportar a imagem.');
  }
  return new File([blob], 'foto-3x4.jpg', { type: 'image/jpeg' });
}

async function comprimirImagemAteLimite(file, maxBytes) {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let qualidade = 0.92;
  let escala = 1;

  const tentar = () => {
    canvas.width = Math.round(width * escala);
    canvas.height = Math.round(height * escala);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', qualidade);
    });
  };

  let blob = await tentar();
  while (blob && blob.size > maxBytes && (qualidade > 0.45 || escala > 0.35)) {
    if (qualidade > 0.45) qualidade -= 0.07;
    else escala *= 0.85;
    blob = await tentar();
  }
  bitmap.close();
  if (!blob || blob.size > maxBytes) {
    throw new Error('Não foi possível reduzir a foto abaixo de 5 MB. Tente outra imagem.');
  }
  return new File([blob], 'foto-3x4.jpg', { type: 'image/jpeg' });
}
