/**
 * Validação de CPF (formato e dígitos verificadores) e normalização.
 * Uso no navegador e no Node (import.js pode reutilizar se necessário).
 */

/** Remove tudo que não é dígito */
export function apenasDigitosCpf(valor) {
  return String(valor || '').replace(/\D/g, '');
}

/** Máscara visual 000.000.000-00 */
export function formatarCpfMascara(digitos) {
  const d = apenasDigitosCpf(digitos).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function calcularDigito(base, pesos) {
  let soma = 0;
  for (let i = 0; i < base.length; i++) {
    soma += parseInt(base[i], 10) * pesos[i];
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * Valida CPF com 11 dígitos, rejeita sequências inválidas conhecidas.
 * @param {string} cpfComOuSemMascara
 * @returns {{ valido: boolean, motivo?: string }}
 */
export function validarCpf(cpfComOuSemMascara) {
  const cpf = apenasDigitosCpf(cpfComOuSemMascara);
  if (cpf.length !== 11) {
    return { valido: false, motivo: 'CPF deve ter 11 dígitos.' };
  }
  if (/^(\d)\1{10}$/.test(cpf)) {
    return { valido: false, motivo: 'CPF inválido.' };
  }
  const d1 = calcularDigito(cpf.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calcularDigito(cpf.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== parseInt(cpf[9], 10) || d2 !== parseInt(cpf[10], 10)) {
    return { valido: false, motivo: 'CPF inválido (dígitos verificadores).' };
  }
  return { valido: true };
}

/** Tipos MIME aceitos para foto */
export const TIPOS_FOTO_ACEITOS = ['image/jpeg', 'image/png', 'image/webp'];
export const TAMANHO_MAX_FOTO_BYTES = 5 * 1024 * 1024; // 5 MB

export function validarArquivoFoto(file) {
  if (!file || !file.size) {
    return { valido: false, motivo: 'Nenhuma foto selecionada.' };
  }
  if (file.size > TAMANHO_MAX_FOTO_BYTES) {
    return { valido: false, motivo: 'A foto deve ter no máximo 5 MB.' };
  }
  if (!TIPOS_FOTO_ACEITOS.includes(file.type)) {
    return { valido: false, motivo: 'Use JPG, PNG ou WEBP.' };
  }
  return { valido: true };
}
