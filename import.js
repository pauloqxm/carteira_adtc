/**
 * Importação única do CSV para a tabela membros.
 * Uso: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env e rode:
 *   npm run import:csv
 *
 * CPFs são gravados somente com dígitos (ou null se vazio no CSV).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
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

const sb = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
  const rows = parse(texto, { columns: true, skip_empty_lines: true, trim: true });

  const registros = [];
  for (const row of rows) {
    const r = linhaParaRegistro(row);
    if (r) registros.push(r);
  }

  console.log('Registros válidos:', registros.length);

  const chunkSize = 200;
  for (let i = 0; i < registros.length; i += chunkSize) {
    const chunk = registros.slice(i, i + chunkSize);
    const { error } = await sb.from('membros').upsert(chunk, { onConflict: 'cod_membro' });
    if (error) {
      console.error('Erro no lote', i, error);
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
