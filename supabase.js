/**
 * Cliente Supabase no navegador — leitura de membros (anon + RLS).
 * Chaves injetadas pelo servidor em /config.js (gerado em tempo de execução).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

let client;

export function getSupabase() {
  if (typeof window === 'undefined' || !window.__SUPABASE_URL__ || !window.__SUPABASE_ANON_KEY__) {
    throw new Error('Supabase não configurado. Verifique /config.js e variáveis de ambiente.');
  }
  if (!client) {
    client = createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON_KEY__, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Busca membro pelo CPF armazenado apenas com dígitos (igual ao import).
 * @param {string} cpf11digitos
 */
export async function buscarMembroPorCpf(cpf11digitos) {
  const sb = getSupabase();
  // Vários registros com o mesmo CPF: maybeSingle() falha; usa o mais recente (created_at).
  const { data, error } = await sb
    .from('membros')
    .select(
      'id, cod_membro, nome_completo, cpf, data_nasc, data_batismo, cargo, sexo, created_at',
    )
    .eq('cpf', cpf11digitos)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}
