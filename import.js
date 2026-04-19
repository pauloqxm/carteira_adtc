/**
 * Importação única do CSV para a tabela membros.
 * Requer Node 18+ (fetch nativo). Não depende de node_modules.
 *
 * Uso: no .env (ou ambiente), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY e rode:
 *   node import.js
 *   ou: npm run import:csv
 *
 * CPFs são gravados somente com dígitos (ou null se vazio no CSV).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { apenasDigitosCpf } from './validacao.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFromFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFromFile();

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !KEY) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env (ou no ambiente).');
  process.exit(1);
}

const REST_BASE = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;

/** Upsert via PostgREST — não exige pacote npm (útil se node_modules falhar no Drive). */
async function upsertMembrosChunk(chunk) {
  const url = `${REST_BASE}/membros?on_conflict=cod_membro`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(chunk),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`REST ${res.status}: ${body}`);
  }
}

/** CSV com vírgulas e campos entre aspas (RFC básico), sem dependências. */
function parseCsvMatrix(text) {
  const matrix = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      if (row.some((cell) => String(cell).trim() !== '')) {
        matrix.push(row.map((s) => String(s).trim()));
      }
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => String(cell).trim() !== '')) {
      matrix.push(row.map((s) => String(s).trim()));
    }
  }
  return matrix;
}

function matrixToObjects(matrix) {
  if (matrix.length < 2) return [];
  const headers = matrix[0];
  const out = [];
  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r];
    const o = {};
    for (let c = 0; c < headers.length; c++) {
      o[headers[c]] = line[c] ?? '';
    }
    out.push(o);
  }
  return out;
}

function parseDataBR(s) {
  if (s == null || String(s).trim() === '') return null;
  const t = String(s).trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = m[1].padStart(2, '0');
  const mo = m[2].padStart(2, '0');
  const y = m[3];
  return `${y}-${mo}-${d}`;
}

function linhaParaRegistro(row) {
  const cod = parseInt(row.cod_membro ?? row.COD_MEMBRO, 10);
  if (Number.isNaN(cod)) return null;

  const cpfRaw = row.cpf ?? row.CPF ?? '';
  const cpfDigits = apenasDigitosCpf(cpfRaw);
  const cpf = cpfDigits.length === 11 ? cpfDigits : null;

  const sexo = row.sexo ?? row.Sexo ?? row.SEXO ?? null;

  return {
    cod_membro: cod,
    nome_completo: String(row.nome_completo ?? row.NOME_COMPLETO ?? '').trim() || 'Sem nome',
    cpf,
    data_nasc: parseDataBR(row.data_nasc ?? row.DATA_NASC),
    nacionalidade: row.nacionalidade ?? row.NACIONALIDADE ?? null,
    estado_civil: row.estado_civil ?? row.ESTADO_CIVIL ?? null,
    data_batismo: parseDataBR(row.data_batismo ?? row.DATA_BATISMO),
    cargo: row.cargo ?? row.CARGO ?? null,
    sexo,
  };
}

async function main() {
  const csvPath = path.join(__dirname, 'dados_membros.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('Arquivo não encontrado:', csvPath);
    process.exit(1);
  }
  const texto = fs.readFileSync(csvPath, 'utf8');
  const rows = matrixToObjects(parseCsvMatrix(texto));

  const registros = [];
  for (const row of rows) {
    const r = linhaParaRegistro(row);
    if (r) registros.push(r);
  }

  console.log('Registros válidos:', registros.length);

  const chunkSize = 200;
  for (let i = 0; i < registros.length; i += chunkSize) {
    const chunk = registros.slice(i, i + chunkSize);
    try {
      await upsertMembrosChunk(chunk);
    } catch (err) {
      console.error('Erro no lote', i, err.message || err);
      process.exit(1);
    }
    console.log('Importados', Math.min(i + chunkSize, registros.length), '/', registros.length);
  }

  console.log('Concluído.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
