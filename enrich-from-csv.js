/**
 * Enriquece membros existentes no Supabase a partir do CSV da igreja.
 * Cruza por cod_membro (não cria membros novos).
 *
 * Atualiza: congregacao, situacao_membro, whatsapp_telefone
 * (e opcionalmente campos já existentes se vierem preenchidos no CSV).
 *
 * Uso:
 *   node enrich-from-csv.js
 *   node enrich-from-csv.js "BD_ADTC - Dados_membros.csv"
 *
 * Requer .env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
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
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env');
  process.exit(1);
}

const REST_BASE = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;

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
        } else inQuotes = false;
      } else field += c;
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
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function textoOuNull(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : null;
}

function telefoneOuNull(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits;
}

function linhaParaPatch(row) {
  const cod = parseInt(row.cod_membro ?? row.COD_MEMBRO, 10);
  if (!Number.isInteger(cod) || cod < 1) return null;

  const patch = {};
  const cong = textoOuNull(row.congregacao);
  const sit = textoOuNull(row.situacao_membro);
  const tel = telefoneOuNull(row.whatsapp_telefone);
  if (cong) patch.congregacao = cong;
  if (sit) patch.situacao_membro = sit;
  if (tel) patch.whatsapp_telefone = tel;

  const cpfDigits = apenasDigitosCpf(row.cpf ?? '');
  if (cpfDigits.length === 11) patch.cpf = cpfDigits;

  const dn = parseDataBR(row.data_nasc);
  if (dn) patch.data_nasc = dn;
  const db = parseDataBR(row.data_batismo);
  if (db) patch.data_batismo = db;

  const nat = textoOuNull(row.nacionalidade);
  if (nat) patch.nacionalidade = nat;
  const est = textoOuNull(row.estado_civil);
  if (est) patch.estado_civil = est;
  const cargo = textoOuNull(row.cargo);
  if (cargo) patch.cargo = cargo;
  const sexo = textoOuNull(row.Sexo ?? row.sexo);
  if (sexo) patch.sexo = sexo;
  const nome = textoOuNull(row.nome_completo);
  if (nome) patch.nome_completo = nome;

  if (!Object.keys(patch).length) return null;
  return { cod_membro: cod, patch };
}

async function patchMembroPorCodigo(cod, patch) {
  const url = `${REST_BASE}/membros?cod_membro=eq.${cod}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`cod ${cod}: REST ${res.status}: ${body}`);
  }
}

async function main() {
  const argPath = process.argv[2];
  const csvPath = path.resolve(
    __dirname,
    argPath || 'BD_ADTC - Dados_membros.csv',
  );
  if (!fs.existsSync(csvPath)) {
    console.error('Arquivo não encontrado:', csvPath);
    process.exit(1);
  }

  const rows = matrixToObjects(parseCsvMatrix(fs.readFileSync(csvPath, 'utf8')));
  const itens = [];
  for (const row of rows) {
    const item = linhaParaPatch(row);
    if (item) itens.push(item);
  }

  console.log('Linhas CSV:', rows.length);
  console.log('Patches a aplicar:', itens.length);
  console.log(
    'Com telefone:',
    itens.filter((x) => x.patch.whatsapp_telefone).length,
  );
  console.log(
    'Com congregação:',
    itens.filter((x) => x.patch.congregacao).length,
  );

  let ok = 0;
  let falhas = 0;
  const concurrency = 8;
  for (let i = 0; i < itens.length; i += concurrency) {
    const slice = itens.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      slice.map((item) => patchMembroPorCodigo(item.cod_membro, item.patch)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok += 1;
      else {
        falhas += 1;
        console.error(r.reason?.message || r.reason);
      }
    }
    console.log('Progresso', Math.min(i + concurrency, itens.length), '/', itens.length);
  }

  console.log('Concluído. OK:', ok, 'Falhas:', falhas);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
