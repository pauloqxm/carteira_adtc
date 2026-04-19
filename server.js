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

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor em http://localhost:${PORT}`);
});
