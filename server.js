import crypto from 'crypto';
import ws from 'ws';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import {
  TAMANHO_MAX_FOTO_BYTES,
  TIPOS_FOTO_ACEITOS,
  validarCpf,
  apenasDigitosCpf,
} from './validacao.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Carrega .env local (Docker/Railway costumam injetar variáveis sem arquivo). */
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

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const ADMIN_PASSWORD_SHA256 = (process.env.ADMIN_PASSWORD_SHA256 || '').trim().toLowerCase();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_CREDENTIALS = (process.env.ADMIN_CREDENTIALS || '').trim();
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
const ALLOW_IFRAME = /^true$/i.test((process.env.ALLOW_IFRAME || 'false').trim());

function parseAllowedFrameAncestors(raw) {
  const tokens = String(raw || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = [];
  for (const token of tokens) {
    try {
      const u = new URL(token);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      valid.push(u.origin);
    } catch {
      /* ignora entradas inválidas */
    }
  }
  return [...new Set(valid)];
}

const ALLOWED_FRAME_ANCESTORS = parseAllowedFrameAncestors(process.env.ALLOWED_FRAME_ANCESTORS || '');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const HASH_HEX_64_RE = /^[0-9a-f]{64}$/i;

function parseAdminCredentials(raw) {
  const map = new Map();
  const itens = String(raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of itens) {
    const sep = item.indexOf(':');
    if (sep <= 0) continue;
    const username = item.slice(0, sep).trim();
    const hash = item.slice(sep + 1).trim().toLowerCase();
    if (!username || !HASH_HEX_64_RE.test(hash)) continue;
    map.set(username, hash);
  }
  return map;
}

const ADMIN_USERS = parseAdminCredentials(ADMIN_CREDENTIALS);
if (ADMIN_USERS.size === 0 && ADMIN_PASSWORD_SHA256 && HASH_HEX_64_RE.test(ADMIN_PASSWORD_SHA256)) {
  ADMIN_USERS.set(ADMIN_USERNAME, ADMIN_PASSWORD_SHA256);
}
const ADMIN_DEFAULT_USERNAME = ADMIN_USERS.keys().next().value || ADMIN_USERNAME;

function usePasswordLogin() {
  return ADMIN_USERS.size > 0;
}

function timingSafeHashEqualHex(hexA, hexB) {
  try {
    const a = Buffer.from(String(hexA).toLowerCase(), 'hex');
    const b = Buffer.from(String(hexB).toLowerCase(), 'hex');
    if (a.length !== b.length || a.length !== 32) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function timingSafeEqualB64Url(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function signAdminJwt() {
  const payload = { v: 1, sub: 'admin', exp: Date.now() + ADMIN_SESSION_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyAdminJwt(token) {
  if (!token || !ADMIN_SECRET) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', ADMIN_SECRET).update(payloadB64).digest('base64url');
  if (!timingSafeEqualB64Url(sig, expectedSig)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.sub !== 'admin' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Date.now()) return null;
  return payload;
}

function extractAdminToken(req) {
  const headerToken = req.headers['x-admin-token'];
  const auth = req.headers.authorization;
  if (typeof headerToken === 'string' && headerToken) return headerToken.trim();
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

if (!SUPABASE_URL) {
  console.warn('Aviso: SUPABASE_URL não definida.');
}

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: ws },
      })
    : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAX_FOTO_BYTES },
});

const app = express();
app.use(express.json());

/** Headers de segurança HTTP em todas as respostas. */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const frameAncestors =
    ALLOW_IFRAME && ALLOWED_FRAME_ANCESTORS.length
      ? ALLOWED_FRAME_ANCESTORS.join(' ')
      : "'none'";
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  if (ALLOW_IFRAME && ALLOWED_FRAME_ANCESTORS.length) {
    res.removeHeader('X-Frame-Options');
  } else {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  next();
});

/** Bloqueia acesso a arquivos sensíveis servidos pelo express.static. */
const ARQUIVOS_BLOQUEADOS =
  /^\/?(?:dados_membros\.csv|import\.js|\.env[^/]*|index_modelo\.html|template_cadastro\.csv[^/]*|[^/]*\.tmp)$/i;
app.use((req, res, next) => {
  if (ARQUIVOS_BLOQUEADOS.test(req.path)) return res.status(404).end();
  next();
});

/**
 * Rate limiter simples em memória: máximo de MAX_REQ por janela de JANELA_MS por IP.
 * Reinicia a contagem automaticamente ao expirar a janela.
 */
const JANELA_MS = 15 * 60 * 1000; // 15 minutos
const MAX_REQ = 12;
const _contadores = new Map();
function rateLimitSolicitacao(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const agora = Date.now();
  const entrada = _contadores.get(ip);
  if (!entrada || agora - entrada.inicio > JANELA_MS) {
    _contadores.set(ip, { inicio: agora, count: 1 });
    return next();
  }
  if (entrada.count >= MAX_REQ) {
    return res.status(429).json({
      mensagem: `Muitas requisições. Tente novamente em ${Math.ceil((JANELA_MS - (agora - entrada.inicio)) / 60000)} minuto(s).`,
    });
  }
  entrada.count += 1;
  return next();
}

/** Injeta chaves públicas para o cliente Supabase */
app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.__SUPABASE_URL__ = ${JSON.stringify(SUPABASE_URL)};
window.__SUPABASE_ANON_KEY__ = ${JSON.stringify(SUPABASE_ANON_KEY)};`);
});

function gerarProtocolo(prefixo = 'ECL') {
  const suffix = String(Date.now()).slice(-6);
  return `${prefixo}-${suffix}`;
}

/** Nome sugerido para o PDF da carteira (UTF-8 + fallback ASCII para o cabeçalho HTTP). */
function nomeFicheiroPdfCarteira(nomeCompleto, congregacaoNome) {
  const nome = String(nomeCompleto || '')
    .trim()
    .replace(/["\r\n]/g, ' ')
    .replace(/[/\\:*?|]/g, '-')
    .slice(0, 90);
  const congregacao = String(congregacaoNome || '')
    .trim()
    .replace(/["\r\n]/g, ' ')
    .replace(/[/\\:*?|]/g, '-')
    .slice(0, 60);
  const base =
    congregacao && nome ? `${congregacao} - ${nome}` : congregacao || nome || 'Membro';
  const utf8 = `${base}.pdf`;
  const ascii =
    `${base
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\w\s.-]+/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 100) || 'Membro'}.pdf`.replace(/[^\w.\-]+/g, '_');
  return { utf8, ascii };
}

function requireAdmin(req, res, next) {
  const token = extractAdminToken(req);
  if (!token) {
    return res.status(401).json({ mensagem: 'Não autorizado.' });
  }

  if (usePasswordLogin()) {
    if (!ADMIN_SECRET) {
      return res.status(503).json({
        mensagem: 'Defina ADMIN_SECRET no servidor para assinar a sessão do painel.',
      });
    }
    if (!verifyAdminJwt(token)) {
      return res.status(401).json({ mensagem: 'Não autorizado.' });
    }
    return next();
  }

  if (!ADMIN_SECRET) {
    return res.status(503).json({
      mensagem: 'Painel admin desativado: defina ADMIN_SECRET no servidor (Railway / .env).',
    });
  }
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ mensagem: 'Não autorizado.' });
  }
  next();
}

app.get('/api/admin/config', (_req, res) => {
  res.json({
    loginMode: usePasswordLogin() ? 'password' : 'token',
    defaultUsername: ADMIN_DEFAULT_USERNAME,
  });
});

app.post('/api/admin/login', (req, res) => {
  if (!usePasswordLogin()) {
    return res
      .status(400)
      .json({ mensagem: 'Login por senha não está ativo (defina ADMIN_CREDENTIALS ou ADMIN_PASSWORD_SHA256).' });
  }
  if (!ADMIN_SECRET) {
    return res.status(503).json({ mensagem: 'ADMIN_SECRET é obrigatório para criar a sessão.' });
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  const hash = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
  const hashEsperado = ADMIN_USERS.get(username);
  if (!hashEsperado || !timingSafeHashEqualHex(hash, hashEsperado)) {
    return res.status(401).json({ mensagem: 'Utilizador ou senha incorretos.' });
  }
  res.json({ token: signAdminJwt() });
});

app.get('/api/admin/solicitacoes', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const statusFilter = req.query.status;
  const contarStatus = (st) =>
    supabaseAdmin
      .from('solicitacoes')
      .select('id', { count: 'exact', head: true })
      .eq('status_solicitacao', st);
  const contarEmitidas = () =>
    supabaseAdmin
      .from('solicitacoes')
      .select('id', { count: 'exact', head: true })
      .not('emitida_em', 'is', null);
  let q = supabaseAdmin
    .from('solicitacoes')
    .select('id, protocolo, status_solicitacao, foto_url, created_at, membro_id, emitida_em')
    .order('created_at', { ascending: false });
  if (statusFilter && ['pendente', 'aprovada', 'rejeitada'].includes(String(statusFilter))) {
    q = q.eq('status_solicitacao', statusFilter);
  }
  const [listResult, pendenteRes, aprovadaRes, rejeitadaRes, emitidaRes] = await Promise.all([
    q,
    contarStatus('pendente'),
    contarStatus('aprovada'),
    contarStatus('rejeitada'),
    contarEmitidas(),
  ]);
  const { data: sols, error } = listResult;
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao listar solicitações.' });
  }
  const totais = {
    pendente: pendenteRes.error ? 0 : pendenteRes.count ?? 0,
    aprovada: aprovadaRes.error ? 0 : aprovadaRes.count ?? 0,
    rejeitada: rejeitadaRes.error ? 0 : rejeitadaRes.count ?? 0,
    emitida: emitidaRes.error ? 0 : emitidaRes.count ?? 0,
  };
  const lista = sols || [];
  try {
    const map = await carregarMembrosPorIds([...new Set(lista.map((s) => s.membro_id).filter(Boolean))]);
    const itens = lista.map((s) => ({
      ...s,
      membros: map[s.membro_id] || null,
    }));
    res.json({ itens, totais });
  } catch (e2) {
    console.error(e2);
    return res.status(500).json({ mensagem: 'Erro ao carregar dados dos membros.' });
  }
});

async function carregarMembrosPorIds(ids) {
  if (!ids.length) return {};
  const { data: mems, error } = await supabaseAdmin
    .from('membros')
    .select(
      'id, nome_completo, cod_membro, cpf, data_nasc, nacionalidade, estado_civil, data_batismo, cargo, sexo, congregacao, situacao_membro, whatsapp_telefone',
    )
    .in('id', ids);
  if (error) throw error;
  return Object.fromEntries((mems || []).map((m) => [m.id, m]));
}

function incrementarContagem(map, chave) {
  const k = chave || '—';
  map.set(k, (map.get(k) || 0) + 1);
}

function contagensOrdenadas(map, { top = null, labelVazio = 'Sem valor' } = {}) {
  const itens = [...map.entries()].map(([chave, total]) => ({
    chave: chave === '—' ? labelVazio : chave,
    total,
  }));
  itens.sort((a, b) => b.total - a.total || String(a.chave).localeCompare(String(b.chave), 'pt'));
  if (top == null || itens.length <= top) return itens;
  const principais = itens.slice(0, top);
  const resto = itens.slice(top).reduce((acc, x) => acc + x.total, 0);
  if (resto > 0) principais.push({ chave: 'Outros', total: resto });
  return principais;
}

function idadeEmAnos(dataNascIso, ref = new Date()) {
  if (!dataNascIso) return null;
  const d = new Date(`${String(dataNascIso).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  let idade = ref.getFullYear() - d.getFullYear();
  const m = ref.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < d.getDate())) idade -= 1;
  return idade >= 0 && idade < 130 ? idade : null;
}

function faixaEtaria(idade) {
  if (idade == null) return 'Sem data';
  if (idade <= 12) return 'Crianças (0-12)';
  if (idade <= 17) return 'Adolescentes (13-17)';
  if (idade <= 29) return 'Jovens (18-29)';
  if (idade <= 59) return 'Adultos (30-59)';
  return 'Idosos (60+)';
}

async function contarCarteirasTotais() {
  const contarStatus = (st) =>
    supabaseAdmin
      .from('solicitacoes')
      .select('id', { count: 'exact', head: true })
      .eq('status_solicitacao', st);
  const [pendenteRes, aprovadaRes, rejeitadaRes, emitidaRes] = await Promise.all([
    contarStatus('pendente'),
    contarStatus('aprovada'),
    contarStatus('rejeitada'),
    supabaseAdmin
      .from('solicitacoes')
      .select('id', { count: 'exact', head: true })
      .not('emitida_em', 'is', null),
  ]);
  return {
    pendente: pendenteRes.error ? 0 : pendenteRes.count ?? 0,
    aprovada: aprovadaRes.error ? 0 : aprovadaRes.count ?? 0,
    rejeitada: rejeitadaRes.error ? 0 : rejeitadaRes.count ?? 0,
    emitida: emitidaRes.error ? 0 : emitidaRes.count ?? 0,
  };
}

/** Espelha congregação da solicitação no cadastro do membro e marca como atualizado. */
async function sincronizarMembroComCongregacao(membroId, congregacaoNome) {
  if (!membroId || !supabaseAdmin) return;
  const cong = String(congregacaoNome || '').trim();
  const patch = { situacao_membro: 'ATUALIZADO' };
  if (cong.length >= 2) patch.congregacao = cong;
  const { error } = await supabaseAdmin.from('membros').update(patch).eq('id', membroId);
  if (error) console.error('sincronizarMembroComCongregacao', error);
}

app.get('/api/admin/carteiras-emitidas', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const { data: sols, error } = await supabaseAdmin
    .from('solicitacoes')
    .select('id, protocolo, status_solicitacao, foto_url, created_at, membro_id, emitida_em, congregacao_nome')
    .not('emitida_em', 'is', null)
    .order('emitida_em', { ascending: false });
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao listar carteiras emitidas.' });
  }
  const lista = sols || [];
  try {
    const map = await carregarMembrosPorIds([...new Set(lista.map((s) => s.membro_id).filter(Boolean))]);
    const itens = lista.map((s) => ({
      ...s,
      membros: map[s.membro_id] || null,
    }));
    res.json({ itens, total: itens.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ mensagem: 'Erro ao carregar dados dos membros.' });
  }
});

app.post('/api/admin/carteiras-emitidas', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = [...new Set(idsRaw.map((id) => String(id || '').trim()).filter((id) => UUID_RE.test(id)))];
  if (!ids.length) {
    return res.status(400).json({ mensagem: 'Selecione pelo menos uma solicitação válida.' });
  }
  if (ids.length > 80) {
    return res.status(400).json({ mensagem: 'Registe no máximo 80 emissões de cada vez.' });
  }

  const { data: sols, error } = await supabaseAdmin
    .from('solicitacoes')
    .select('id, protocolo, status_solicitacao, emitida_em, membro_id, congregacao_nome')
    .in('id', ids);
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao validar solicitações.' });
  }

  const porId = new Map((sols || []).map((s) => [s.id, s]));
  const elegiveis = [];
  const ignoradas = [];
  for (const id of ids) {
    const s = porId.get(id);
    if (!s) {
      ignoradas.push({ id, motivo: 'não encontrada' });
      continue;
    }
    if (s.status_solicitacao !== 'aprovada') {
      ignoradas.push({ id, protocolo: s.protocolo, motivo: 'não está aprovada' });
      continue;
    }
    if (s.emitida_em) {
      ignoradas.push({ id, protocolo: s.protocolo, motivo: 'já emitida' });
      continue;
    }
    elegiveis.push(s.id);
  }

  if (!elegiveis.length) {
    return res.status(400).json({
      mensagem: 'Nenhuma solicitação aprovada pendente de emissão nas selecionadas.',
      registadas: 0,
      ignoradas,
    });
  }

  const agora = new Date().toISOString();
  const { data: atualizados, error: eUp } = await supabaseAdmin
    .from('solicitacoes')
    .update({ emitida_em: agora })
    .in('id', elegiveis)
    .is('emitida_em', null)
    .eq('status_solicitacao', 'aprovada')
    .select('id, protocolo, emitida_em, membro_id, congregacao_nome');
  if (eUp) {
    console.error(eUp);
    return res.status(500).json({ mensagem: 'Erro ao registar emissões.' });
  }

  await Promise.all(
    (atualizados || []).map((s) => sincronizarMembroComCongregacao(s.membro_id, s.congregacao_nome)),
  );

  res.json({
    ok: true,
    registadas: (atualizados || []).length,
    itens: atualizados || [],
    ignoradas,
  });
});

app.delete('/api/admin/carteiras-emitidas/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ mensagem: 'ID inválido.' });
  }
  const { data, error } = await supabaseAdmin
    .from('solicitacoes')
    .update({ emitida_em: null })
    .eq('id', id)
    .not('emitida_em', 'is', null)
    .select('id, protocolo')
    .maybeSingle();
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao remover registo de emissão.' });
  }
  if (!data) {
    return res.status(404).json({ mensagem: 'Emissão não encontrada.' });
  }
  res.json({ ok: true, solicitacao: data });
});

app.patch('/api/admin/solicitacoes/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ mensagem: 'ID inválido.' });
  }
  const st = req.body?.status_solicitacao;
  if (!['pendente', 'aprovada', 'rejeitada'].includes(st)) {
    return res.status(400).json({ mensagem: 'status_solicitacao inválido.' });
  }
  const { data, error } = await supabaseAdmin
    .from('solicitacoes')
    .update({ status_solicitacao: st })
    .eq('id', id)
    .select('id, protocolo, status_solicitacao, membro_id, congregacao_nome')
    .maybeSingle();
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao atualizar.' });
  }
  if (!data) {
    return res.status(404).json({ mensagem: 'Solicitação não encontrada.' });
  }
  if (st === 'aprovada') {
    await sincronizarMembroComCongregacao(data.membro_id, data.congregacao_nome);
  }
  res.json({ ok: true, solicitacao: data });
});

app.delete('/api/admin/solicitacoes/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ mensagem: 'ID inválido.' });
  }
  const { data: removidos, error } = await supabaseAdmin.from('solicitacoes').delete().eq('id', id).select('id');
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao excluir.' });
  }
  if (!removidos?.length) {
    return res.status(404).json({ mensagem: 'Solicitação não encontrada.' });
  }
  res.json({ ok: true });
});

/** Data YYYY-MM-DD ou null; string vazia → null. */
function parseOptionalDateIso(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return undefined;
}

/** Data obrigatória AAAA-MM-DD; vazio ou inválida → { erro }; válida → { data }. */
function parseRequiredDateIso(val, nomeCampo) {
  if (val === null || val === undefined || String(val).trim() === '') {
    return { erro: `${nomeCampo} é obrigatória.` };
  }
  const s = String(val).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { erro: `${nomeCampo} inválida (use AAAA-MM-DD).` };
  }
  return { data: s };
}

function textoObrigatorio(val, nomeCampo, minLen = 2) {
  const s = String(val ?? '').trim();
  if (s.length < minLen) {
    return { erro: `${nomeCampo} deve ter pelo menos ${minLen} caracteres.` };
  }
  return { texto: s };
}

async function obterProximoCodMembro() {
  const { data, error } = await supabaseAdmin
    .from('membros')
    .select('cod_membro')
    .order('cod_membro', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw error;
  }
  const atual = Number(data?.cod_membro);
  if (!Number.isInteger(atual) || atual < 1) return 1;
  return atual + 1;
}

/** Texto opcional: vazio → null. */
function parseOptionalText(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length ? s : null;
}

const MEMBROS_LIST_SELECT =
  'id, cod_membro, nome_completo, cpf, data_nasc, nacionalidade, estado_civil, data_batismo, cargo, sexo, congregacao, situacao_membro, whatsapp_telefone, created_at';

app.get('/api/admin/membros/dashboard', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  try {
    const [{ data: rows, error }, carteiras] = await Promise.all([
      supabaseAdmin
        .from('membros')
        .select('sexo, situacao_membro, congregacao, cargo, data_nasc, data_batismo'),
      contarCarteirasTotais(),
    ]);
    if (error) {
      console.error(error);
      return res.status(500).json({ mensagem: 'Erro ao carregar dashboard de membros.' });
    }
    const lista = rows || [];
    const porSexo = new Map();
    const porSituacao = new Map();
    const porCongregacao = new Map();
    const porCargo = new Map();
    const porFaixa = new Map([
      ['Crianças (0-12)', 0],
      ['Adolescentes (13-17)', 0],
      ['Jovens (18-29)', 0],
      ['Adultos (30-59)', 0],
      ['Idosos (60+)', 0],
      ['Sem data', 0],
    ]);
    const batismosPorAno = new Map();
    const agora = new Date();

    for (const m of lista) {
      incrementarContagem(porSexo, String(m.sexo || '').trim() || '—');
      incrementarContagem(porSituacao, String(m.situacao_membro || '').trim() || '—');
      incrementarContagem(porCongregacao, String(m.congregacao || '').trim() || '—');
      incrementarContagem(porCargo, String(m.cargo || '').trim() || '—');
      const faixa = faixaEtaria(idadeEmAnos(m.data_nasc, agora));
      porFaixa.set(faixa, (porFaixa.get(faixa) || 0) + 1);
      const anoBat = m.data_batismo ? String(m.data_batismo).slice(0, 4) : '';
      if (/^\d{4}$/.test(anoBat)) {
        batismosPorAno.set(anoBat, (batismosPorAno.get(anoBat) || 0) + 1);
      }
    }

    const faixasOrdem = [
      'Crianças (0-12)',
      'Adolescentes (13-17)',
      'Jovens (18-29)',
      'Adultos (30-59)',
      'Idosos (60+)',
      'Sem data',
    ];
    const batismos = [...batismosPorAno.entries()]
      .map(([ano, total]) => ({ ano, total }))
      .sort((a, b) => Number(a.ano) - Number(b.ano));

    res.json({
      total: lista.length,
      por_sexo: contagensOrdenadas(porSexo, { labelVazio: 'Não informado' }),
      por_situacao: contagensOrdenadas(porSituacao, { labelVazio: 'Sem situação' }),
      por_congregacao: contagensOrdenadas(porCongregacao, { top: 12, labelVazio: 'Sem congregação' }),
      por_cargo: contagensOrdenadas(porCargo, { top: 10, labelVazio: 'Sem cargo' }),
      faixas_etarias: faixasOrdem.map((chave) => ({ chave, total: porFaixa.get(chave) || 0 })),
      batismos_por_ano: batismos,
      carteiras,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ mensagem: 'Erro ao montar dashboard de membros.' });
  }
});

app.get('/api/admin/membros', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limitRaw = parseInt(String(req.query.limit || '50'), 10) || 50;
  const limit = Math.min(100, Math.max(10, limitRaw));
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const q = String(req.query.q || '').trim();
  const congregacao = String(req.query.congregacao || '').trim();
  const situacao = String(req.query.situacao || '').trim();

  let query = supabaseAdmin
    .from('membros')
    .select(MEMBROS_LIST_SELECT, { count: 'exact' })
    .order('nome_completo', { ascending: true })
    .range(from, to);

  if (congregacao === '__vazio__') {
    query = query.or('congregacao.is.null,congregacao.eq.');
  } else if (congregacao) {
    query = query.eq('congregacao', congregacao);
  }
  if (situacao === '__vazio__') {
    query = query.or('situacao_membro.is.null,situacao_membro.eq.');
  } else if (situacao) {
    query = query.eq('situacao_membro', situacao);
  }

  if (q) {
    const digits = apenasDigitosCpf(q);
    const cod = parseInt(q, 10);
    const filtros = [`nome_completo.ilike.%${q.replace(/[%_,]/g, '')}%`];
    if (digits.length >= 3) filtros.push(`cpf.ilike.%${digits}%`);
    if (Number.isInteger(cod) && String(cod) === q.replace(/\s/g, '')) {
      filtros.push(`cod_membro.eq.${cod}`);
    }
    query = query.or(filtros.join(','));
  }

  const { data, error, count } = await query;
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao listar membros.' });
  }
  const total = count ?? 0;
  res.json({
    itens: data || [],
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

app.get('/api/admin/membros/filtros', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const { data, error } = await supabaseAdmin.from('membros').select('congregacao, situacao_membro');
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao carregar filtros.' });
  }
  const cong = new Set();
  const sit = new Set();
  for (const row of data || []) {
    const c = String(row.congregacao || '').trim();
    const s = String(row.situacao_membro || '').trim();
    if (c) cong.add(c);
    if (s) sit.add(s);
  }
  res.json({
    congregacoes: [...cong].sort((a, b) => a.localeCompare(b, 'pt')),
    situacoes: [...sit].sort((a, b) => a.localeCompare(b, 'pt')),
  });
});

app.get('/api/admin/membros/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ mensagem: 'ID de membro inválido.' });
  }
  const { data: membro, error } = await supabaseAdmin
    .from('membros')
    .select(MEMBROS_LIST_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao carregar membro.' });
  }
  if (!membro) {
    return res.status(404).json({ mensagem: 'Membro não encontrado.' });
  }
  const { data: sols, error: eSol } = await supabaseAdmin
    .from('solicitacoes')
    .select('id, protocolo, status_solicitacao, foto_url, created_at, emitida_em, congregacao_nome')
    .eq('membro_id', id)
    .order('created_at', { ascending: false });
  if (eSol) {
    console.error(eSol);
    return res.status(500).json({ mensagem: 'Erro ao carregar solicitações do membro.' });
  }
  res.json({ membro, solicitacoes: sols || [] });
});

app.patch('/api/admin/membros/:id', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ mensagem: 'ID de membro inválido.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, 'nome_completo')) {
    const n = String(body.nome_completo ?? '').trim();
    if (n.length < 2) {
      return res.status(400).json({ mensagem: 'Nome completo deve ter pelo menos 2 caracteres.' });
    }
    patch.nome_completo = n;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cpf')) {
    const d = apenasDigitosCpf(body.cpf);
    if (!d) {
      patch.cpf = null;
    } else {
      const v = validarCpf(d);
      if (!v.valido) {
        return res.status(400).json({ mensagem: v.motivo || 'CPF inválido.' });
      }
      patch.cpf = d;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'data_nasc')) {
    const d = parseOptionalDateIso(body.data_nasc);
    if (d === undefined) {
      return res.status(400).json({ mensagem: 'Data de nascimento inválida (use AAAA-MM-DD).' });
    }
    patch.data_nasc = d;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'data_batismo')) {
    const d = parseOptionalDateIso(body.data_batismo);
    if (d === undefined) {
      return res.status(400).json({ mensagem: 'Data de batismo inválida (use AAAA-MM-DD).' });
    }
    patch.data_batismo = d;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'nacionalidade')) {
    patch.nacionalidade = parseOptionalText(body.nacionalidade);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'estado_civil')) {
    patch.estado_civil = parseOptionalText(body.estado_civil);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cargo')) {
    patch.cargo = parseOptionalText(body.cargo);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sexo')) {
    patch.sexo = parseOptionalText(body.sexo);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'congregacao')) {
    patch.congregacao = parseOptionalText(body.congregacao);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'situacao_membro')) {
    patch.situacao_membro = parseOptionalText(body.situacao_membro);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'whatsapp_telefone')) {
    const tel = String(body.whatsapp_telefone ?? '').replace(/\D/g, '');
    patch.whatsapp_telefone = tel.length >= 8 ? tel : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'cod_membro')) {
    const c = Number(body.cod_membro);
    if (!Number.isInteger(c) || c < 1) {
      return res.status(400).json({ mensagem: 'Código de membro inválido.' });
    }
    const { data: dupe, error: eDupe } = await supabaseAdmin
      .from('membros')
      .select('id')
      .eq('cod_membro', c)
      .neq('id', id)
      .maybeSingle();
    if (eDupe) {
      console.error(eDupe);
      return res.status(500).json({ mensagem: 'Erro ao validar código de membro.' });
    }
    if (dupe) {
      return res.status(409).json({ mensagem: 'Já existe outro membro com este código.' });
    }
    patch.cod_membro = c;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ mensagem: 'Nenhum campo para atualizar.' });
  }

  const { data, error } = await supabaseAdmin.from('membros').update(patch).eq('id', id).select().maybeSingle();
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao atualizar o membro.' });
  }
  if (!data) {
    return res.status(404).json({ mensagem: 'Membro não encontrado.' });
  }
  res.json({ ok: true, membro: data });
});

function dataHojeBR() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function runPythonCarteira(jsonPath) {
  const script = path.join(__dirname, 'card_engine', 'engine.py');
  const runners = ['python3', 'python'];
  for (const cmd of runners) {
    const r = spawnSync(cmd, [script, jsonPath], {
      encoding: 'utf-8',
      maxBuffer: 80 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    if (r.error?.code === 'ENOENT') continue;
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim() || `Motor saiu com código ${r.status}`;
      const err = new Error(msg);
      err.code = 'ENGINE_FAILED';
      throw err;
    }
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const line = lines[lines.length - 1];
    return JSON.parse(line);
  }
  const err = new Error(
    'Python 3 não encontrado. No deploy use o Dockerfile (inclui Python + Pillow + qrcode) ou instale Python no servidor.',
  );
  err.code = 'PYTHON_MISSING';
  throw err;
}

app.post('/api/admin/gerar-carteira', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const protocolo = typeof req.body?.protocolo === 'string' ? req.body.protocolo.trim() : '';
  const solicitacaoId =
    typeof req.body?.solicitacao_id === 'string' ? req.body.solicitacao_id.trim() : '';
  if (!protocolo && !solicitacaoId) {
    return res.status(400).json({ mensagem: 'Indique protocolo ou solicitacao_id.' });
  }

  let solQuery;
  if (solicitacaoId && UUID_RE.test(solicitacaoId)) {
    solQuery = supabaseAdmin
      .from('solicitacoes')
      .select('id, protocolo, foto_url, status_solicitacao, membro_id, congregacao_nome, membros(*)')
      .eq('id', solicitacaoId)
      .maybeSingle();
  } else if (protocolo) {
    solQuery = supabaseAdmin
      .from('solicitacoes')
      .select('id, protocolo, foto_url, status_solicitacao, membro_id, congregacao_nome, membros(*)')
      .eq('protocolo', protocolo)
      .maybeSingle();
  } else {
    return res.status(400).json({ mensagem: 'solicitacao_id inválido.' });
  }

  const { data: sol, error: e1 } = await solQuery;
  if (e1) {
    console.error(e1);
    return res.status(500).json({ mensagem: 'Erro ao buscar solicitação.' });
  }
  if (!sol) {
    return res.status(404).json({ mensagem: 'Solicitação não encontrada.' });
  }

  const membro = sol.membros;
  if (!membro || typeof membro !== 'object' || Array.isArray(membro)) {
    return res.status(500).json({ mensagem: 'Dados do membro em falta.' });
  }
  let congregacaoNome = String(sol.congregacao_nome || '').trim();
  if (!congregacaoNome) {
    const { data: novoCad, error: eNovoCad } = await supabaseAdmin
      .from('novo_membro')
      .select('congregacao')
      .eq('membro_id', membro.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eNovoCad) {
      console.error(eNovoCad);
      return res.status(500).json({ mensagem: 'Erro ao consultar congregação do cadastro.' });
    }
    congregacaoNome = String(novoCad?.congregacao || '').trim();
  }

  const tmp = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  let jsonPath = '';
  let outF = '';
  let outB = '';
  let outPdf = '';
  let fotoPath = '';

  try {
    jsonPath = path.join(tmp, `carteira_${id}.json`);
    outF = path.join(tmp, `carteira_${id}_f.png`);
    outB = path.join(tmp, `carteira_${id}_c.png`);
    outPdf = path.join(tmp, `carteira_${id}.pdf`);
    if (sol.foto_url && typeof sol.foto_url === 'string') {
      const fr = await fetch(sol.foto_url);
      if (!fr.ok) {
        return res.status(502).json({ mensagem: 'Não foi possível descarregar a foto desta solicitação.' });
      }
      const buf = Buffer.from(await fr.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) {
        return res.status(400).json({ mensagem: 'Ficheiro da foto demasiado grande.' });
      }
      fotoPath = path.join(tmp, `carteira_${id}_foto.jpg`);
      fs.writeFileSync(fotoPath, buf);
    }

    const payload = {
      paths: {
        membro_frente: path.join(__dirname, 'membro_frente.png'),
        membro_costa: path.join(__dirname, 'membro_costa.png'),
      },
      out_frente_png: outF,
      out_costa_png: outB,
      out_pdf: outPdf,
      foto_path: fotoPath || undefined,
      protocolo: sol.protocolo || '',
      public_base_url: PUBLIC_SITE_URL,
      membro: {
        nome_completo: membro.nome_completo,
        cargo: membro.cargo,
        data_nasc: membro.data_nasc,
        data_batismo: membro.data_batismo,
        estado_civil: membro.estado_civil,
        cpf: membro.cpf,
        nacionalidade: membro.nacionalidade,
        congregacao_nome: congregacaoNome || '—',
        cod_membro: membro.cod_membro,
        data_expedicao: dataHojeBR(),
      },
    };

    fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
    runPythonCarteira(jsonPath);
    const pdfBuf = fs.readFileSync(outPdf);
    const { utf8: nomePdfUtf8, ascii: nomePdfAscii } = nomeFicheiroPdfCarteira(
      membro.nome_completo,
      congregacaoNome,
    );
    const dispAscii = nomePdfAscii.replace(/"/g, "'");
    const dispStar = encodeURIComponent(nomePdfUtf8);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${dispAscii}"; filename*=UTF-8''${dispStar}`,
    );
    res.send(pdfBuf);
  } catch (err) {
    console.error(err);
    if (err.code === 'PYTHON_MISSING') {
      return res.status(503).json({ mensagem: err.message });
    }
    return res.status(500).json({
      mensagem: err.message?.slice(0, 500) || 'Falha ao gerar carteira.',
    });
  } finally {
    for (const p of [jsonPath, outF, outB, outPdf, fotoPath]) {
      try {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
});


app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/** Texto exibido ao ler o QR da carteira (solicitação aprovada). */
const MENSAGEM_MEMBRO_ATIVO =
  'é membro ativo da Igreja Evangêlica Assembleia de Deus Templo Central em Quixeramobim.';

app.get('/api/carteira-verificacao', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ ok: false, mensagem: 'Serviço indisponível.' });
  }
  const protocolo = String(req.query.protocolo || '').trim();
  if (!protocolo) {
    return res.status(400).json({ ok: false, mensagem: 'Protocolo em falta.' });
  }
  const { data: sol, error } = await supabaseAdmin
    .from('solicitacoes')
    .select('status_solicitacao, membros(nome_completo)')
    .eq('protocolo', protocolo)
    .maybeSingle();
  if (error) {
    console.error(error);
    return res.status(500).json({ ok: false, mensagem: 'Erro ao consultar o protocolo.' });
  }
  if (!sol) {
    return res.status(404).json({
      ok: false,
      mensagem: 'Protocolo não encontrado.',
    });
  }
  const m = sol.membros;
  let nome = '';
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    nome = String(m.nome_completo || '').trim();
  } else if (Array.isArray(m) && m.length && m[0]) {
    nome = String(m[0].nome_completo || '').trim();
  }
  if (!nome) {
    return res.status(500).json({ ok: false, mensagem: 'Dados do membro indisponíveis.' });
  }
  if (sol.status_solicitacao !== 'aprovada') {
    return res.json({
      ok: false,
      mensagem:
        'Este protocolo existe, mas a solicitação ainda não foi aprovada. A mensagem de membro ativo só é exibida após aprovação pela secretaria.',
    });
  }
  const mensagem = `${nome} ${MENSAGEM_MEMBRO_ATIVO}`;
  return res.json({ ok: true, nome_completo: nome, mensagem });
});

app.get('/membro-qr', (_req, res) => {
  res.sendFile(path.join(__dirname, 'membro-qr.html'));
});

app.post('/api/solicitacao', rateLimitSolicitacao, upload.single('foto'), async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase (service role).' });
  }

  const membroId = req.body?.membro_id;
  if (!membroId || typeof membroId !== 'string') {
    return res.status(400).json({ mensagem: 'membro_id obrigatório.' });
  }
  const congregacaoNome = String(req.body?.congregacao_nome || '').trim();
  if (congregacaoNome.length < 2) {
    return res.status(400).json({ mensagem: 'congregacao_nome obrigatório.' });
  }

  const file = req.file;
  if (!file || !file.buffer) {
    return res.status(400).json({ mensagem: 'Envie a foto (campo foto).' });
  }
  if (!TIPOS_FOTO_ACEITOS.includes(file.mimetype)) {
    return res.status(400).json({ mensagem: 'Formato de imagem não aceito.' });
  }

  const { data: membro, error: errMembro } = await supabaseAdmin
    .from('membros')
    .select('id, cod_membro')
    .eq('id', membroId)
    .maybeSingle();

  if (errMembro || !membro) {
    return res.status(404).json({ mensagem: 'Membro não encontrado.' });
  }

  const { data: pendente, error: errPend } = await supabaseAdmin
    .from('solicitacoes')
    .select('id')
    .eq('membro_id', membroId)
    .eq('status_solicitacao', 'pendente')
    .maybeSingle();

  if (errPend) {
    console.error(errPend);
    return res.status(500).json({ mensagem: 'Erro ao verificar solicitações pendentes.' });
  }
  if (pendente) {
    return res.status(409).json({
      mensagem: 'Já existe uma solicitação pendente para este membro. Aguarde a análise.',
    });
  }

  const ts = Date.now();
  const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
  const objectPath = `${membro.cod_membro}/${ts}.${ext}`;

  const { error: upErr } = await supabaseAdmin.storage
    .from('fotos-membros')
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (upErr) {
    console.error(upErr);
    return res.status(500).json({ mensagem: 'Falha ao enviar foto ao armazenamento.' });
  }

  const { data: pub } = supabaseAdmin.storage.from('fotos-membros').getPublicUrl(objectPath);
  const fotoUrl = pub?.publicUrl || '';

  let protocolo = gerarProtocolo();
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data: ins, error: insErr } = await supabaseAdmin
      .from('solicitacoes')
      .insert({
        membro_id: membroId,
        foto_url: fotoUrl,
        congregacao_nome: congregacaoNome,
        protocolo,
        status_solicitacao: 'pendente',
      })
      .select('id, protocolo')
      .single();

    if (!insErr && ins) {
      await sincronizarMembroComCongregacao(membroId, congregacaoNome);
      return res.json({ ok: true, protocolo: ins.protocolo, id: ins.id });
    }
    if (insErr?.code === '23505') {
      protocolo = gerarProtocolo();
      continue;
    }
    console.error(insErr);
    return res.status(500).json({ mensagem: 'Falha ao registrar solicitação.' });
  }

  return res.status(500).json({ mensagem: 'Não foi possível gerar protocolo único.' });
});

app.post('/api/solicitacao-novo-membro', rateLimitSolicitacao, upload.single('foto'), async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase (service role).' });
  }

  const file = req.file;
  if (!file || !file.buffer) {
    return res.status(400).json({ mensagem: 'Envie a foto (campo foto).' });
  }
  if (!TIPOS_FOTO_ACEITOS.includes(file.mimetype)) {
    return res.status(400).json({ mensagem: 'Formato de imagem não aceito.' });
  }

  const b = req.body && typeof req.body === 'object' ? req.body : {};

  const nomeRes = textoObrigatorio(b.nome_completo, 'Nome completo', 2);
  if (nomeRes.erro) return res.status(400).json({ mensagem: nomeRes.erro });

  const cpfDigits = apenasDigitosCpf(b.cpf);
  const cpfVal = validarCpf(cpfDigits);
  if (!cpfVal.valido) {
    return res.status(400).json({ mensagem: cpfVal.motivo || 'CPF inválido.' });
  }

  const dn = parseRequiredDateIso(b.data_nasc, 'Data de nascimento');
  if (dn.erro) return res.status(400).json({ mensagem: dn.erro });
  const db = parseRequiredDateIso(b.data_batismo, 'Data de batismo');
  if (db.erro) return res.status(400).json({ mensagem: db.erro });

  const estRes = textoObrigatorio(b.estado_civil, 'Estado civil', 2);
  if (estRes.erro) return res.status(400).json({ mensagem: estRes.erro });
  const natRes = textoObrigatorio(b.nacionalidade, 'Nacionalidade', 2);
  if (natRes.erro) return res.status(400).json({ mensagem: natRes.erro });
  const cargoRes = textoObrigatorio(b.cargo, 'Cargo', 2);
  if (cargoRes.erro) return res.status(400).json({ mensagem: cargoRes.erro });
  const sexoRes = textoObrigatorio(b.sexo, 'Sexo', 1);
  if (sexoRes.erro) return res.status(400).json({ mensagem: sexoRes.erro });
  const congregacaoRes = textoObrigatorio(b.congregacao, 'Congregação', 2);
  if (congregacaoRes.erro) return res.status(400).json({ mensagem: congregacaoRes.erro });
  const whatsappRes = textoObrigatorio(b.whatsapp_telefone, 'WhatsApp / telefone', 8);
  if (whatsappRes.erro) return res.status(400).json({ mensagem: whatsappRes.erro });

  const dca = parseOptionalDateIso(b.data_consag_auxiliar);
  const dcd = parseOptionalDateIso(b.data_consag_diacono);
  const dcp = parseOptionalDateIso(b.data_consag_presbitero);
  if (dca === undefined || dcd === undefined || dcp === undefined) {
    return res.status(400).json({ mensagem: 'Datas de consagração inválidas (use AAAA-MM-DD ou deixe em branco).' });
  }

  const { data: existeCpf, error: errCpf } = await supabaseAdmin
    .from('membros')
    .select('id')
    .eq('cpf', cpfDigits)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (errCpf) {
    console.error(errCpf);
    return res.status(500).json({ mensagem: 'Erro ao validar CPF.' });
  }
  if (existeCpf) {
    return res.status(409).json({
      mensagem: 'Este CPF já possui cadastro. Volte e use a busca por CPF.',
    });
  }

  let membroNovo = null;
  for (let tentativa = 0; tentativa < 8; tentativa++) {
    let proximoCod = 0;
    try {
      proximoCod = await obterProximoCodMembro();
    } catch (errCod) {
      console.error(errCod);
      return res.status(500).json({ mensagem: 'Erro ao obter próximo código de membro.' });
    }
    const { data: insM, error: errInsM } = await supabaseAdmin
      .from('membros')
      .insert({
        cod_membro: proximoCod,
        nome_completo: nomeRes.texto,
        cpf: cpfDigits,
        data_nasc: dn.data,
        nacionalidade: natRes.texto,
        estado_civil: estRes.texto,
        data_batismo: db.data,
        cargo: cargoRes.texto,
        sexo: sexoRes.texto,
        congregacao: congregacaoRes.texto,
        situacao_membro: 'ATUALIZADO',
      })
      .select('id, cod_membro')
      .single();
    if (!errInsM && insM) {
      membroNovo = insM;
      break;
    }
    if (errInsM?.code === '23505') {
      continue;
    }
    console.error(errInsM);
    return res.status(500).json({ mensagem: 'Falha ao criar cadastro do membro.' });
  }
  if (!membroNovo) {
    return res.status(500).json({ mensagem: 'Não foi possível gerar código de membro automático.' });
  }

  const membroId = membroNovo.id;
  const ts = Date.now();
  const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
  const objectPath = `${membroNovo.cod_membro}/${ts}.${ext}`;

  const { error: upErr } = await supabaseAdmin.storage
    .from('fotos-membros')
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (upErr) {
    console.error(upErr);
    await supabaseAdmin.from('membros').delete().eq('id', membroId);
    return res.status(500).json({ mensagem: 'Falha ao enviar foto ao armazenamento.' });
  }

  const { data: pub } = supabaseAdmin.storage.from('fotos-membros').getPublicUrl(objectPath);
  const fotoUrl = pub?.publicUrl || '';

  let protocolo = gerarProtocolo('NOV');
  let solicitacaoId = '';
  let insSol = null;

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data: ins, error: insErr } = await supabaseAdmin
      .from('solicitacoes')
      .insert({
        membro_id: membroId,
        foto_url: fotoUrl,
        protocolo,
        congregacao_nome: congregacaoRes.texto,
        status_solicitacao: 'pendente',
      })
      .select('id, protocolo')
      .single();

    if (!insErr && ins) {
      insSol = ins;
      solicitacaoId = ins.id;
      protocolo = ins.protocolo;
      break;
    }
    if (insErr?.code === '23505') {
      protocolo = gerarProtocolo('NOV');
      continue;
    }
    console.error(insErr);
    await supabaseAdmin.storage.from('fotos-membros').remove([objectPath]);
    await supabaseAdmin.from('membros').delete().eq('id', membroId);
    return res.status(500).json({ mensagem: 'Falha ao registrar solicitação.' });
  }

  if (!insSol) {
    await supabaseAdmin.storage.from('fotos-membros').remove([objectPath]);
    await supabaseAdmin.from('membros').delete().eq('id', membroId);
    return res.status(500).json({ mensagem: 'Não foi possível gerar protocolo único.' });
  }

  const rowNovo = {
    membro_id: membroId,
    protocolo: insSol.protocolo,
    foto_url: fotoUrl,
    cod_membro: membroNovo.cod_membro,
    nome_completo: nomeRes.texto,
    cpf: cpfDigits,
    data_nasc: dn.data,
    data_batismo: db.data,
    estado_civil: estRes.texto,
    nacionalidade: natRes.texto,
    cargo: cargoRes.texto,
    sexo: sexoRes.texto,
    whatsapp_telefone: whatsappRes.texto,
    bairro_distrito: parseOptionalText(b.bairro_distrito),
    endereco: parseOptionalText(b.endereco),
    nome_pai: parseOptionalText(b.nome_pai),
    nome_mae: parseOptionalText(b.nome_mae),
    naturalidade: parseOptionalText(b.naturalidade),
    congregacao: congregacaoRes.texto,
    data_consag_auxiliar: dca,
    data_consag_diacono: dcd,
    data_consag_presbitero: dcp,
    situacao_membro: parseOptionalText(b.situacao_membro),
  };

  const { error: errNovo } = await supabaseAdmin.from('novo_membro').insert(rowNovo);
  if (errNovo) {
    console.error(errNovo);
    await supabaseAdmin.from('solicitacoes').delete().eq('id', solicitacaoId);
    await supabaseAdmin.storage.from('fotos-membros').remove([objectPath]);
    await supabaseAdmin.from('membros').delete().eq('id', membroId);
    if (errNovo.code === '42P01') {
      return res.status(500).json({
        mensagem:
          'Falha ao registrar dados do novo cadastro: tabela novo_membro não encontrada. Aplique a migração no Supabase e tente novamente.',
      });
    }
    if (errNovo.code === '42501') {
      return res.status(500).json({
        mensagem:
          'Falha ao registrar dados do novo cadastro: sem permissão para inserir em novo_membro. Verifique políticas/RLS da tabela.',
      });
    }
    if (errNovo.code === '23502') {
      return res.status(500).json({
        mensagem:
          'Falha ao registrar dados do novo cadastro: campos obrigatórios ausentes na tabela novo_membro. Verifique se a estrutura está atualizada.',
      });
    }
    return res.status(500).json({
      mensagem:
        'Falha ao registrar dados do novo cadastro. Verifique a migração/estrutura da tabela novo_membro e tente novamente.',
    });
  }

  return res.json({ ok: true, protocolo: insSol.protocolo, id: insSol.id });
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ mensagem: 'Não encontrado.' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor em http://localhost:${PORT}`);
});
