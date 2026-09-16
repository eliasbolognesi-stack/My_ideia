'use strict';

const path = require('node:path');

function booleano(valor, padrao = false) {
  if (valor === undefined || valor === '') return padrao;
  return ['1', 'true', 'sim', 'yes'].includes(String(valor).toLowerCase());
}

// Um valor numérico escrito errado (SGA_TI_LIMITE_LOGIN=vinte) viraria NaN, e
// toda comparação com NaN é falsa: o limite se desligaria SEM avisar ninguém.
// Aqui, entrada inválida cai no padrão e aparece no console.
function numero(valor, padrao, { minimo = 0 } = {}) {
  if (valor === undefined || String(valor).trim() === '') return padrao;
  const convertido = Number(valor);
  if (!Number.isFinite(convertido) || convertido < minimo) {
    console.warn(`AVISO: valor inválido "${valor}" ignorado; usando ${padrao}.`);
    return padrao;
  }
  return convertido;
}

function lista(valor) {
  return String(valor || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// SGA_TI_WEBHOOK_KEYS no formato "chave:email,outra:email". A chave determina
// QUEM é o autor do evento — a requisição não declara mais a própria autoria.
function mapaChavesWebhook(valor) {
  const mapa = new Map();
  for (const par of lista(valor)) {
    const separador = par.indexOf(':');
    if (separador <= 0) continue;
    const chave = par.slice(0, separador).trim();
    const email = par.slice(separador + 1).trim().toLowerCase();
    if (chave && email) mapa.set(chave, email);
  }
  return mapa;
}

const raiz = path.join(__dirname, '..');

// Em produção as checagens de configuração deixam de avisar e passam a
// impedir a subida (ver validarConfiguracao no server.js).
const producao = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

module.exports = {
  // Exportado para quem lê a própria configuração (ex.: scripts/backup.js).
  numero,
  producao,
  // Piso 0 de propósito: PORT=0 quer dizer "escolha uma porta livre",
  // usado por plataforma de hospedagem e pelos testes.
  porta: numero(process.env.PORT, 3000, { minimo: 0 }),
  // Escuta só em localhost por padrão: o acesso externo deve passar por um
  // proxy reverso com TLS (ver README). Use 0.0.0.0 apenas conscientemente.
  host: process.env.SGA_TI_HOST || '127.0.0.1',
  caminhoBanco: process.env.SGA_TI_DB || path.join(raiz, 'data', 'sga-ti.db'),

  // --- Webhook do n8n -------------------------------------------------------
  // Modo recomendado: cada origem tem a própria chave, e a chave define o autor.
  chavesWebhook: mapaChavesWebhook(process.env.SGA_TI_WEBHOOK_KEYS),
  // Modo legado (chave única, autor declarado no corpo). Mantido para não
  // quebrar instalações existentes; o servidor avisa no boot que é inseguro.
  chaveWebhook: process.env.SGA_TI_WEBHOOK_KEY || '',

  empresa: process.env.SGA_TI_EMPRESA || 'Empresa',
  // Após este prazo (contado da baixa do ativo), os dados pessoais dos eventos
  // podem ser anonimizados — ver POST /api/lgpd/anonimizar.
  prazoRetencaoAnos: numero(process.env.SGA_TI_PRAZO_RETENCAO_ANOS, 5, { minimo: 1 }),
  duracaoSessaoHoras: numero(process.env.SGA_TI_SESSAO_HORAS, 12, { minimo: 1 }),
  // Senha inicial do usuário admin criado no primeiro boot. Se não definida,
  // uma senha aleatória é gerada e impressa uma única vez no console.
  senhaAdminInicial: process.env.SGA_TI_ADMIN_SENHA || '',

  // --- Segurança ------------------------------------------------------------
  // Registro de eventos de segurança, separado do banco do sistema.
  arquivoRegistroSeguranca: process.env.SGA_TI_LOG_SEGURANCA || path.join(raiz, 'data', 'seguranca.log'),
  // Rotação: sem isso o arquivo cresce para sempre e, em servidor pequeno,
  // disco cheio derruba o banco junto.
  tamanhoMaximoLogMB: numero(process.env.SGA_TI_LOG_TAMANHO_MB, 5, { minimo: 0.01 }),
  arquivosLogMantidos: numero(process.env.SGA_TI_LOG_ARQUIVOS, 5, { minimo: 1 }),
  // Confia no cabeçalho X-Forwarded-For (ligue APENAS atrás de proxy reverso;
  // caso contrário o cliente forja o próprio endereço e burla o limite de uso).
  atrasDeProxy: booleano(process.env.SGA_TI_ATRAS_PROXY),
  // Envia Strict-Transport-Security (só faz sentido quando servido por HTTPS).
  forcarHttps: booleano(process.env.SGA_TI_FORCAR_HTTPS),
  // Limites de uso por janela de tempo.
  limiteLogin: numero(process.env.SGA_TI_LIMITE_LOGIN, 20, { minimo: 1 }),
  limiteEventosPorMinuto: numero(process.env.SGA_TI_LIMITE_EVENTOS, 60, { minimo: 1 }),
  limiteWebhookPorMinuto: numero(process.env.SGA_TI_LIMITE_WEBHOOK, 120, { minimo: 1 }),
  // Tamanho máximo de cada campo de texto recebido.
  tamanhoMaximoCampo: numero(process.env.SGA_TI_TAMANHO_CAMPO, 2000, { minimo: 1 }),
  // Domínios aceitos quando a evidência de descarte é um endereço da internet.
  // Vazio = sem restrição de domínio (apenas o protocolo é validado).
  dominiosEvidencia: lista(process.env.SGA_TI_DOMINIOS_EVIDENCIA),
  // Exige aprovação humana para TODO descarte, não só o de ativo 'Em uso'.
  aprovacaoTodoDescarte: booleano(process.env.SGA_TI_APROVACAO_TODO_DESCARTE),
  // Modo manutenção: responde 503 a tudo, sem derrubar o processo.
  manutencao: booleano(process.env.SGA_TI_MANUTENCAO),

  // --- Privacidade (LGPD) ---------------------------------------------------
  contatoDpo: process.env.SGA_TI_CONTATO_DPO || '',
};
