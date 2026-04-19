import { TAMANHO_MAX_FOTO_BYTES, TIPOS_FOTO_ACEITOS, validarArquivoFoto } from './validacao.js';

const inputId = 'input-foto';
const previewId = 'preview-foto';
const previewWrapId = 'foto-preview-wrap';
const btnCapturarId = 'btn-capturar';
const btnRefazerId = 'btn-refazer-foto';

/** Largura × altura finais 3×4 (retrato), proporcionais ao padrão de carteirinha. */
const SAIDA_3X4_LARGURA = 768;
const SAIDA_3X4_ALTURA = 1024;

let arquivoAtual = null;

export function initCameraUI({ onFotoPronta, onFotoRemovida }) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const wrap = document.getElementById(previewWrapId);
  const btnCapturar = document.getElementById(btnCapturarId);
  const btnRefazer = document.getElementById(btnRefazerId);

  if (!input || !preview || !btnCapturar || !btnRefazer) return;

  input.setAttribute('accept', TIPOS_FOTO_ACEITOS.join(','));
  input.setAttribute('capture', 'user');

  btnCapturar.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    let f = file;
    const v = validarArquivoFoto(f);
    if (!v.valido) {
      alert(v.motivo);
      input.value = '';
      return;
    }
    try {
      f = await recortarParaFormato3x4(f);
    } catch (e) {
      console.error(e);
      alert(e.message || 'Não foi possível ajustar a foto ao formato 3×4.');
      input.value = '';
      return;
    }
    if (f.size > TAMANHO_MAX_FOTO_BYTES) {
      f = await comprimirImagemAteLimite(f, TAMANHO_MAX_FOTO_BYTES);
    }
    arquivoAtual = f;
    mostrarPreview(preview, wrap, f);
    btnRefazer.hidden = false;
    onFotoPronta?.(f);
  });

  btnRefazer.addEventListener('click', () => {
    input.value = '';
    arquivoAtual = null;
    preview.removeAttribute('src');
    preview.hidden = true;
    if (wrap) wrap.hidden = true;
    btnRefazer.hidden = true;
    onFotoRemovida?.();
  });
}

export function getArquivoFotoAtual() {
  return arquivoAtual;
}

export function limparFoto() {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const wrap = document.getElementById(previewWrapId);
  const btnRefazer = document.getElementById(btnRefazerId);
  if (input) input.value = '';
  arquivoAtual = null;
  if (preview) {
    preview.removeAttribute('src');
    preview.hidden = true;
  }
  if (wrap) wrap.hidden = true;
  if (btnRefazer) btnRefazer.hidden = true;
}

function mostrarPreview(imgEl, wrapEl, file) {
  const url = URL.createObjectURL(file);
  if (imgEl.dataset.revokeUrl) URL.revokeObjectURL(imgEl.dataset.revokeUrl);
  imgEl.dataset.revokeUrl = url;
  imgEl.src = url;
  imgEl.hidden = false;
  if (wrapEl) wrapEl.hidden = false;
}

/**
 * Recorte central na proporção 3:4 (largura:altura) e redimensiona para SAIDA_*.
 */
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

/**
 * Redimensiona e comprime para JPEG até ficar abaixo do limite (mantém proporção atual = já 3×4).
 */
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
      canvas.toBlob(
        (blob) => resolve(blob),
        'image/jpeg',
        qualidade,
      );
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
