-- Telefone / WhatsApp no cadastro de membros (enriquecimento a partir do CSV da igreja)
alter table public.membros
  add column if not exists whatsapp_telefone text;
