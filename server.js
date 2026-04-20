import crypto from 'crypto';
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
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');

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
      .select(
        'id, nome_completo, cod_membro, cpf, data_nasc, nacionalidade, estado_civil, data_batismo, cargo, sexo',
      )
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
  let congregacaoNome = String(sol.congregacao_nome || membro.congregacao_nome || '').trim();
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

app.post('/api/solicitacao', upload.single('foto'), async (req, res) => {
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

app.post('/api/solicitacao-novo-membro', upload.single('foto'), async (req, res) => {
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
