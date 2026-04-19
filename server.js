import crypto from 'crypto';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import { TAMANHO_MAX_FOTO_BYTES, TIPOS_FOTO_ACEITOS } from './validacao.js';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

function usePasswordLogin() {
  return Boolean(ADMIN_PASSWORD_SHA256);
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
      })
    : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAX_FOTO_BYTES },
});

const app = express();
app.use(express.json());

/** Injeta chaves públicas para o cliente Supabase */
app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.__SUPABASE_URL__ = ${JSON.stringify(SUPABASE_URL)};
window.__SUPABASE_ANON_KEY__ = ${JSON.stringify(SUPABASE_ANON_KEY)};`);
});

function gerarProtocolo() {
  const suffix = String(Date.now()).slice(-6);
  return `ECL-${suffix}`;
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
    defaultUsername: ADMIN_USERNAME,
  });
});

app.post('/api/admin/login', (req, res) => {
  if (!usePasswordLogin()) {
    return res.status(400).json({ mensagem: 'Login por senha não está ativo (defina ADMIN_PASSWORD_SHA256).' });
  }
  if (!ADMIN_SECRET) {
    return res.status(503).json({ mensagem: 'ADMIN_SECRET é obrigatório para criar a sessão.' });
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  const hash = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
  const okUser = username === ADMIN_USERNAME;
  const okPass = timingSafeHashEqualHex(hash, ADMIN_PASSWORD_SHA256);
  if (!okUser || !okPass) {
    return res.status(401).json({ mensagem: 'Utilizador ou senha incorretos.' });
  }
  res.json({ token: signAdminJwt() });
});

app.get('/api/admin/solicitacoes', requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase.' });
  }
  const statusFilter = req.query.status;
  let q = supabaseAdmin
    .from('solicitacoes')
    .select('id, protocolo, status_solicitacao, foto_url, created_at, membro_id')
    .order('created_at', { ascending: false });
  if (statusFilter && ['pendente', 'aprovada', 'rejeitada'].includes(String(statusFilter))) {
    q = q.eq('status_solicitacao', statusFilter);
  }
  const { data: sols, error } = await q;
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao listar solicitações.' });
  }
  const lista = sols || [];
  const ids = [...new Set(lista.map((s) => s.membro_id).filter(Boolean))];
  let map = {};
  if (ids.length) {
    const { data: mems, error: e2 } = await supabaseAdmin
      .from('membros')
      .select('id, nome_completo, cod_membro, cpf')
      .in('id', ids);
    if (e2) {
      console.error(e2);
      return res.status(500).json({ mensagem: 'Erro ao carregar dados dos membros.' });
    }
    map = Object.fromEntries((mems || []).map((m) => [m.id, m]));
  }
  const itens = lista.map((s) => ({
    ...s,
    membros: map[s.membro_id] || null,
  }));
  res.json({ itens });
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
    .select('id, protocolo, status_solicitacao')
    .maybeSingle();
  if (error) {
    console.error(error);
    return res.status(500).json({ mensagem: 'Erro ao atualizar.' });
  }
  if (!data) {
    return res.status(404).json({ mensagem: 'Solicitação não encontrada.' });
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

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/api/solicitacao', upload.single('foto'), async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ mensagem: 'Servidor sem credencial Supabase (service role).' });
  }

  const membroId = req.body?.membro_id;
  if (!membroId || typeof membroId !== 'string') {
    return res.status(400).json({ mensagem: 'membro_id obrigatório.' });
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
        protocolo,
        status_solicitacao: 'pendente',
      })
      .select('id, protocolo')
      .single();

    if (!insErr && ins) {
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
