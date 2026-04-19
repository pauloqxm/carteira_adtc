import { TAMANHO_MAX_FOTO_BYTES, TIPOS_FOTO_ACEITOS, validarArquivoFoto } from './validacao.js';

const inputId = 'input-foto';
const previewId = 'preview-foto';
const btnCapturarId = 'btn-capturar';
const btnRefazerId = 'btn-refazer-foto';

let arquivoAtual = null;

export function initCameraUI({ onFotoPronta, onFotoRemovida }) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
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
    if (f.size > TAMANHO_MAX_FOTO_BYTES) {
      f = await comprimirImagemAteLimite(f, TAMANHO_MAX_FOTO_BYTES);
    }
    arquivoAtual = f;
    mostrarPreview(preview, f);
    btnRefazer.hidden = false;
    onFotoPronta?.(f);
  });

  btnRefazer.addEventListener('click', () => {
    input.value = '';
    arquivoAtual = null;
    preview.removeAttribute('src');
    preview.hidden = true;
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
  const btnRefazer = document.getElementById(btnRefazerId);
  if (input) input.value = '';
  arquivoAtual = null;
  if (preview) {
    preview.removeAttribute('src');
    preview.hidden = true;
  }
  if (btnRefazer) btnRefazer.hidden = true;
}

function mostrarPreview(imgEl, file) {
  const url = URL.createObjectURL(file);
  if (imgEl.dataset.revokeUrl) URL.revokeObjectURL(imgEl.dataset.revokeUrl);
  imgEl.dataset.revokeUrl = url;
  imgEl.src = url;
  imgEl.hidden = false;
}

/**
 * Redimensiona e comprime para JPEG até ficar abaixo do limite.
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
  return new File([blob], 'foto.jpg', { type: 'image/jpeg' });
}
