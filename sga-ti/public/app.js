'use strict';

// ---------------------------------------------------------------------------
// Estado e utilitários
// ---------------------------------------------------------------------------
const estado = {
  token: null,
  usuario: null,
};

try {
  estado.token = localStorage.getItem('sga_ti_token');
} catch { /* armazenamento indisponível */ }

const $ = (seletor) => document.querySelector(seletor);

function escapar(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function formatarData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapar(iso);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

async function api(caminho, opcoes = {}) {
  const cabecalhos = { 'Content-Type': 'application/json' };
  if (estado.token) cabecalhos['Authorization'] = `Bearer ${estado.token}`;
  const resposta = await fetch(caminho, {
    method: opcoes.metodo || 'GET',
    headers: cabecalhos,
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  const corpo = await resposta.json().catch(() => ({}));
  if (resposta.status === 401 && caminho !== '/api/auth/login') {
    sair();
    throw new Error('sessão expirada');
  }
  if (!resposta.ok) {
    // A mensagem fica curta; os campos que faltam vão em `detalhes` e são
    // renderizados como lista pelo componente de aviso.
    const erro = new Error(corpo.erro || 'não foi possível concluir a ação');
    erro.detalhes = corpo.detalhes;
    throw erro;
  }
  return corpo;
}

// ---------------------------------------------------------------------------
// Tema (escuro por padrão; "sistema" acompanha o dispositivo)
// ---------------------------------------------------------------------------
const CHAVE_TEMA = 'sga_ti_tema';
const consultaTemaClaro = window.matchMedia('(prefers-color-scheme: light)');

function preferenciaTema() {
  try {
    const salvo = localStorage.getItem(CHAVE_TEMA);
    return ['escuro', 'claro', 'sistema'].includes(salvo) ? salvo : 'escuro';
  } catch {
    return 'escuro';
  }
}

function aplicarTema(preferencia) {
  const claro = preferencia === 'claro' || (preferencia === 'sistema' && consultaTemaClaro.matches);
  document.documentElement.dataset.tema = claro ? 'claro' : 'escuro';
}

function definirTema(preferencia) {
  try { localStorage.setItem(CHAVE_TEMA, preferencia); } catch { /* ok */ }
  aplicarTema(preferencia);
  document.querySelectorAll('[data-seletor-tema]').forEach((s) => { s.value = preferencia; });
}

function iniciarTema() {
  const preferencia = preferenciaTema();
  aplicarTema(preferencia);
  document.querySelectorAll('[data-seletor-tema]').forEach((seletor) => {
    seletor.value = preferencia;
    seletor.addEventListener('change', (evento) => definirTema(evento.target.value));
  });
  // Enquanto a preferência for "sistema", acompanha a troca no dispositivo.
  consultaTemaClaro.addEventListener('change', () => {
    if (preferenciaTema() === 'sistema') aplicarTema('sistema');
  });
}

// ---------------------------------------------------------------------------
// Componentes de interface
// ---------------------------------------------------------------------------
const ICONE_AVISO = { sucesso: '✓', erro: '!', alerta: '!', info: 'i' };

// A API responde com o nome cru do campo ("numero_serie_confirmado"). Quem
// opera o estoque lê o rótulo do formulário, não o nome da coluna.
const NOME_CAMPO = {
  patrimonio_confirmado: 'confirmação do patrimônio',
  numero_serie_confirmado: 'confirmação do S/N',
  justificativa_dispensa: 'justificativa da dispensa',
  confirmacao_backup: 'confirmação de backup/limpeza',
  fornecedor_origem: 'fornecedor / origem',
  problema_relatado: 'problema relatado',
  solucao_aplicada: 'solução aplicada',
  tipo_equipamento: 'tipo de equipamento',
  numero_serie: 'número de série (S/N)',
  limpeza_dados: 'limpeza segura de dados',
  quem_recebeu: 'quem recebeu',
  quem_entrega: 'quem entrega',
  quem_recebe: 'quem recebe',
  tipo_destino: 'tipo de destino',
  evento_ref: 'evento de referência',
  patrimonio: 'patrimônio',
  evidencia: 'evidência',
  tecnico: 'técnico',
};
// Do nome mais longo para o mais curto, senão "numero_serie" casaria dentro
// de "numero_serie_confirmado".
const CAMPOS_ORDENADOS = Object.keys(NOME_CAMPO).sort((a, b) => b.length - a.length);

function humanizarDetalhe(texto) {
  let saida = String(texto);
  for (const campo of CAMPOS_ORDENADOS) {
    saida = saida.split(campo).join(NOME_CAMPO[campo]);
  }
  return saida;
}

function htmlAviso(tipo, mensagem, detalhes, acao) {
  const temDetalhes = Array.isArray(detalhes) && detalhes.length > 0;
  const lista = temDetalhes
    ? `<ul class="aviso-lista">${detalhes.map((d) => `<li>${escapar(humanizarDetalhe(d))}</li>`).join('')}</ul>`
    : '';
  // "validação falhou" é vocabulário de API; na tela vira uma instrução.
  const cabecalho = temDetalhes && /valida/i.test(mensagem)
    ? 'Não foi possível registrar. Corrija os pontos abaixo:'
    : mensagem;
  return `<div class="aviso ${tipo}" role="${tipo === 'erro' ? 'alert' : 'status'}">
      <span class="aviso-icone" aria-hidden="true">${ICONE_AVISO[tipo] || 'i'}</span>
      <div class="aviso-conteudo"><p>${escapar(cabecalho)}</p>${lista}</div>
      ${acao ? `<div class="aviso-acao">${acao}</div>` : ''}
    </div>`;
}

function mostrarAviso(alvo, tipo, mensagem, detalhes) {
  const el = typeof alvo === 'string' ? $(alvo) : alvo;
  if (!el) return;
  el.innerHTML = htmlAviso(tipo, mensagem, detalhes);
  el.hidden = false;
}

function limparAviso(alvo) {
  const el = typeof alvo === 'string' ? $(alvo) : alvo;
  if (!el) return;
  el.innerHTML = '';
  el.hidden = true;
}

function blocoVazio(titulo, texto, acao) {
  return `<div class="vazio">
      <p class="vazio-titulo">${escapar(titulo)}</p>
      <p>${escapar(texto)}</p>
      ${acao || ''}
    </div>`;
}

const ESQUELETO = `<div class="esqueleto titulo"></div>
  <div class="cartao">
    <div class="esqueleto alto"></div>
    <div class="esqueleto media"></div>
    <div class="esqueleto curta"></div>
  </div>`;

function selo(status) {
  return `<span class="selo" data-status="${escapar(status)}">${escapar(status)}</span>`;
}

// Os tipos de evento são gravados sem acento (enum do banco); na tela eles
// aparecem escritos por extenso, em português correto.
const ROTULO_EVENTO = {
  Recebimento: 'Recebimento',
  Formatacao: 'Formatação',
  Movimentacao: 'Movimentação',
  Manutencao: 'Manutenção',
  Descarte: 'Descarte',
  Retificacao: 'Retificação',
};
const rotuloEvento = (tipo) => ROTULO_EVENTO[tipo] || tipo;

function transicao(anterior, novo) {
  // Evento que não muda o status (manutenção, retificação) mostra um selo só,
  // em vez de repetir "Em uso → Em uso".
  if (!anterior || anterior === novo) return selo(novo);
  return `${selo(anterior)}<span class="seta-status">→</span>${selo(novo)}`;
}

// Diálogo próprio no lugar do prompt() do navegador: dá contenção de foco,
// fechamento por Esc e validação visível do campo obrigatório.
function confirmarDialogo({ titulo, texto, rotuloOk = 'Confirmar', perigo = false, campo = null }) {
  return new Promise((resolver) => {
    const dialogo = $('#dialogo');
    dialogo.innerHTML = `
      <form class="dialogo-corpo" novalidate>
        <h3>${escapar(titulo)}</h3>
        ${texto ? `<p class="dialogo-texto">${escapar(texto)}</p>` : ''}
        ${campo ? `<label>${escapar(campo.rotulo)}
            <textarea name="valor" rows="3" placeholder="${escapar(campo.placeholder || '')}"></textarea>
          </label>
          <div id="dialogo-erro" hidden></div>` : ''}
        <div class="dialogo-acoes">
          <button type="button" class="botao" data-acao="cancelar">Cancelar</button>
          <button type="submit" class="botao ${perigo ? 'perigo' : 'primario'}">${escapar(rotuloOk)}</button>
        </div>
      </form>`;

    const formulario = dialogo.querySelector('form');
    const concluir = (resultado) => {
      dialogo.close();
      resolver(resultado);
    };

    formulario.querySelector('[data-acao="cancelar"]').addEventListener('click', () => concluir(null));
    formulario.addEventListener('submit', (evento) => {
      evento.preventDefault();
      if (!campo) return concluir({ valor: '' });
      const valor = formulario.elements.valor.value.trim();
      if (campo.obrigatorio && !valor) {
        mostrarAviso('#dialogo-erro', 'erro', campo.mensagemObrigatoria || 'Este campo é obrigatório.');
        formulario.elements.valor.focus();
        return;
      }
      concluir({ valor });
    });
    dialogo.addEventListener('cancel', (evento) => {
      evento.preventDefault();
      concluir(null);
    }, { once: true });

    dialogo.showModal();
    const primeiro = dialogo.querySelector('textarea, input, button');
    if (primeiro) primeiro.focus();
  });
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
function sair() {
  if (estado.token) api('/api/auth/logout', { metodo: 'POST' }).catch(() => {});
  estado.token = null;
  estado.usuario = null;
  try { localStorage.removeItem('sga_ti_token'); } catch { /* ok */ }
  limparAviso('#erro-login');
  $('#app').hidden = true;
  $('#tela-login').hidden = false;
}

async function iniciar() {
  iniciarTema();
  if (estado.token) {
    try {
      const { usuario } = await api('/api/me');
      estado.usuario = usuario;
      entrarNoApp();
      return;
    } catch { /* token inválido: cai para o login */ }
  }
  $('#tela-login').hidden = false;
}

function entrarNoApp() {
  $('#tela-login').hidden = true;
  $('#app').hidden = false;
  $('#usuario-logado').innerHTML =
    `<strong>${escapar(estado.usuario.nome)}</strong>${escapar(estado.usuario.papel)}`;
  $('#menu-usuarios').hidden = estado.usuario.papel !== 'admin';
  navegar('dashboard');
}

$('#form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const formulario = new FormData(evento.target);
  limparAviso('#erro-login');
  try {
    const sessao = await api('/api/auth/login', {
      metodo: 'POST',
      corpo: { email: formulario.get('email'), senha: formulario.get('senha') },
    });
    estado.token = sessao.token;
    estado.usuario = sessao.usuario;
    try { localStorage.setItem('sga_ti_token', sessao.token); } catch { /* ok */ }
    entrarNoApp();
  } catch (erro) {
    mostrarAviso('#erro-login', 'erro', erro.message, erro.detalhes);
  }
});

$('#botao-sair').addEventListener('click', sair);

// ---------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------
const TELAS = {
  dashboard: telaDashboard,
  ativos: telaAtivos,
  registrar: telaRegistrar,
  aprovacoes: telaAprovacoes,
  auditoria: telaAuditoria,
  usuarios: telaUsuarios,
};

function navegar(nome, argumento) {
  document.querySelectorAll('#menu button').forEach((b) => b.classList.toggle('ativo', b.dataset.tela === nome));
  $('#conteudo').innerHTML = ESQUELETO;
  window.scrollTo({ top: 0 });
  TELAS[nome](argumento).catch((erro) => {
    $('#conteudo').innerHTML = `<div class="cartao">${htmlAviso('erro', erro.message, erro.detalhes)}</div>`;
  });
}

$('#menu').addEventListener('click', (evento) => {
  const botao = evento.target.closest('button[data-tela]');
  if (botao) navegar(botao.dataset.tela);
});

// ---------------------------------------------------------------------------
// Telas
// ---------------------------------------------------------------------------
async function telaDashboard() {
  const dados = await api('/api/dashboard');
  const badge = $('#badge-aprovacoes');
  badge.hidden = dados.aprovacoes_pendentes === 0;
  badge.textContent = dados.aprovacoes_pendentes;

  const indicadores = Object.entries(dados.por_status)
    .map(([status, total]) => `
      <div class="indicador" data-status="${escapar(status)}">
        <div class="valor">${total}</div>
        <div class="rotulo">${escapar(status)}</div>
      </div>`)
    .join('');

  // Pendência de aprovação é ação, não número: vira um aviso com atalho.
  const pendencias = dados.aprovacoes_pendentes > 0
    ? htmlAviso(
      'alerta',
      `${dados.aprovacoes_pendentes} descarte(s) aguardando aprovação de um responsável.`,
      null,
      '<button class="botao pequeno" id="ir-aprovacoes">Revisar</button>'
    )
    : '';

  const linhas = dados.ultimos_eventos.map((e) => `
    <tr>
      <td>${formatarData(e.data_hora)}</td>
      <td>${escapar(rotuloEvento(e.tipo))}</td>
      <td><strong>${escapar(e.patrimonio)}</strong><br><small>${escapar(e.modelo)}</small></td>
      <td>${escapar(e.autor_nome)}</td>
      <td>${transicao(e.status_anterior, e.status_novo)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Visão geral</h2>
    ${pendencias}
    <div class="grade-indicadores afastada">${indicadores}</div>
    <div class="cartao">
      <h3>Últimos eventos</h3>
      ${linhas ? `<div class="rolagem-tabela">
        <table>
          <thead><tr><th>Data</th><th>Evento</th><th>Ativo</th><th>Autor</th><th>Status</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>` : blocoVazio('Nenhum evento ainda',
        'Assim que o primeiro equipamento for registrado, o histórico aparece aqui.',
        '<button class="botao primario" id="ir-registrar">Registrar evento</button>')}
    </div>`;

  const irAprovacoes = $('#ir-aprovacoes');
  if (irAprovacoes) irAprovacoes.addEventListener('click', () => navegar('aprovacoes'));
  const irRegistrar = $('#ir-registrar');
  if (irRegistrar) irRegistrar.addEventListener('click', () => navegar('registrar'));
}

async function telaAtivos(filtros = {}) {
  const parametros = new URLSearchParams();
  if (filtros.status) parametros.set('status', filtros.status);
  if (filtros.q) parametros.set('q', filtros.q);
  const { ativos } = await api(`/api/ativos?${parametros}`);

  const STATUS_TODOS = ['Em estoque', 'Em formatação', 'Em uso', 'Em manutenção', 'Reservado para descarte', 'Descartado'];
  const opcoes = STATUS_TODOS.map((s) => `<option value="${s}" ${filtros.status === s ? 'selected' : ''}>${s}</option>`).join('');
  const comFiltro = Boolean(filtros.status || filtros.q);

  const linhas = ativos.map((a) => `
    <tr class="clicavel" data-id="${a.id}">
      <td><strong>${escapar(a.patrimonio)}</strong></td>
      <td>${escapar(a.numero_serie)}</td>
      <td>${escapar(a.fabricante)} ${escapar(a.modelo)}<br><small>${escapar(a.tipo_equipamento)}</small></td>
      <td>${selo(a.status_atual)}</td>
      <td>${escapar(a.responsavel_atual || '—')}</td>
      <td>${escapar(a.localizacao_atual)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Ativos</h2>
    <div class="barra-acoes">
      <input id="busca-ativos" class="busca" placeholder="Buscar por patrimônio, S/N, modelo, responsável…" value="${escapar(filtros.q || '')}">
      <select id="filtro-status">
        <option value="">Todos os status</option>${opcoes}
      </select>
      <button class="botao" id="botao-filtrar">Filtrar</button>
    </div>
    <div class="cartao">
      ${linhas ? `<div class="rolagem-tabela">
        <table>
          <thead><tr><th>Patrimônio</th><th>S/N</th><th>Equipamento</th><th>Status</th><th>Responsável</th><th>Localização</th></tr></thead>
          <tbody id="corpo-ativos">${linhas}</tbody>
        </table>
      </div>` : blocoVazio(
        comFiltro ? 'Nenhum ativo para esse filtro' : 'Nenhum ativo cadastrado',
        comFiltro
          ? 'Tente outro termo de busca ou limpe o filtro de status.'
          : 'Registre um Recebimento para o primeiro equipamento entrar no controle.',
        comFiltro ? '' : '<button class="botao primario" id="ir-registrar">Registrar recebimento</button>'
      )}
    </div>`;

  const filtrar = () => telaAtivos({ q: $('#busca-ativos').value.trim(), status: $('#filtro-status').value });
  $('#botao-filtrar').addEventListener('click', filtrar);
  $('#busca-ativos').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') filtrar();
  });
  const corpo = $('#corpo-ativos');
  if (corpo) {
    corpo.addEventListener('click', (e) => {
      const linha = e.target.closest('tr[data-id]');
      if (linha) telaDetalheAtivo(Number(linha.dataset.id));
    });
  }
  const irRegistrar = $('#ir-registrar');
  if (irRegistrar) irRegistrar.addEventListener('click', () => navegar('registrar'));
}

async function telaDetalheAtivo(id) {
  $('#conteudo').innerHTML = ESQUELETO;
  window.scrollTo({ top: 0 });
  const { ativo, eventos } = await api(`/api/ativos/${id}`);

  const itens = eventos.map((e) => `
    <li>
      <div class="cabeca">${escapar(rotuloEvento(e.tipo))} — evento nº ${e.id}${e.evento_ref ? ` (retifica o evento nº ${e.evento_ref})` : ''}</div>
      <div class="meta">${formatarData(e.data_hora)} · por ${escapar(e.autor_nome)} ·
        ${e.status_anterior ? `${escapar(e.status_anterior)} → ` : ''}${escapar(e.status_novo)}
        ${e.anonimizado ? ' · dados pessoais anonimizados (LGPD)' : ''}</div>
      <pre>${escapar(JSON.stringify(e.dados, null, 2))}</pre>
    </li>`).join('');

  $('#conteudo').innerHTML = `
    <div class="barra-acoes">
      <button class="botao" id="voltar-ativos">← Voltar para ativos</button>
      <button class="botao" id="verificar-integridade">Verificar integridade da trilha</button>
    </div>
    <div class="cartao">
      <h2>${escapar(ativo.patrimonio)} — ${escapar(ativo.fabricante)} ${escapar(ativo.modelo)}</h2>
      <p class="sub">
        S/N <strong>${escapar(ativo.numero_serie)}</strong> · ${escapar(ativo.tipo_equipamento)}
        &nbsp;${selo(ativo.status_atual)}
      </p>
      <p class="sub">
        Localização: ${escapar(ativo.localizacao_atual)} ·
        Responsável: ${escapar(ativo.responsavel_atual || '—')} ·
        Entrada: ${escapar(ativo.data_entrada)}
      </p>
      <div id="resultado-integridade" hidden></div>
    </div>
    <div class="cartao">
      <h3>Histórico (trilha de auditoria imutável)</h3>
      ${itens ? `<ul class="linha-tempo">${itens}</ul>` : blocoVazio('Sem eventos', 'Este ativo ainda não tem movimentações registradas.')}
    </div>`;

  $('#voltar-ativos').addEventListener('click', () => navegar('ativos'));
  $('#verificar-integridade').addEventListener('click', async () => {
    mostrarAviso('#resultado-integridade', 'info', 'Verificando a cadeia de registros…');
    try {
      const r = await api(`/api/ativos/${id}/integridade`);
      if (r.valida) {
        mostrarAviso('#resultado-integridade', 'sucesso',
          `Cadeia íntegra: ${r.eventos_verificados} evento(s) verificados, nenhum sinal de alteração.`);
      } else {
        mostrarAviso('#resultado-integridade', 'erro', 'Cadeia comprometida — registros não conferem:', r.falhas);
      }
    } catch (erro) {
      mostrarAviso('#resultado-integridade', 'erro', erro.message, erro.detalhes);
    }
  });
}

// Definições de formulário por tipo de evento (espelham a seção 5 do prompt).
const FORMULARIOS = {
  Recebimento: [
    { nome: 'patrimonio', rotulo: 'Nº de patrimônio' },
    { nome: 'numero_serie', rotulo: 'Número de série (S/N)' },
    { nome: 'fabricante', rotulo: 'Fabricante', tipo: 'select', opcoes: ['Dell', 'Lenovo', 'Outro'] },
    { nome: 'modelo', rotulo: 'Modelo', dica: 'Ex.: Latitude 5420, ThinkPad T14' },
    { nome: 'tipo_equipamento', rotulo: 'Tipo', tipo: 'select', opcoes: ['Notebook', 'Desktop', 'Monitor', 'Periférico'] },
    { nome: 'quem_recebeu', rotulo: 'Quem recebeu' },
    { nome: 'fornecedor_origem', rotulo: 'Fornecedor / origem' },
    { nome: 'data_entrada', rotulo: 'Data de entrada', tipo: 'date' },
    { nome: 'localizacao', rotulo: 'Localização inicial', opcional: true },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', opcional: true },
  ],
  Formatacao: [
    { nome: 'identificador', rotulo: 'Patrimônio ou S/N do ativo' },
    { nome: 'tecnico', rotulo: 'Técnico responsável' },
    { nome: 'motivo', rotulo: 'Motivo', tipo: 'select', opcoes: ['novo uso', 'reuso', 'pré-descarte'] },
    { nome: 'confirmacao_backup', rotulo: 'Confirmo o backup/limpeza dos dados anteriores', tipo: 'checkbox' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', opcional: true },
  ],
  Movimentacao: [
    { nome: 'identificador', rotulo: 'Patrimônio ou S/N do ativo' },
    { nome: 'origem', rotulo: 'Origem' },
    { nome: 'destino', rotulo: 'Destino', dica: 'Sala, filial, colaborador ou assistência' },
    { nome: 'tipo_destino', rotulo: 'Tipo de destino', tipo: 'select', opcoes: ['colaborador', 'estoque', 'assistencia', 'fornecedor'] },
    { nome: 'quem_entrega', rotulo: 'Quem entrega' },
    { nome: 'quem_recebe', rotulo: 'Quem recebe', dica: 'As duas pontas são obrigatórias' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', opcional: true },
  ],
  Manutencao: [
    { nome: 'identificador', rotulo: 'Patrimônio ou S/N do ativo' },
    { nome: 'tecnico', rotulo: 'Técnico' },
    { nome: 'problema_relatado', rotulo: 'Problema relatado', tipo: 'textarea' },
    { nome: 'solucao_aplicada', rotulo: 'Solução aplicada', tipo: 'textarea' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', opcional: true },
  ],
  Descarte: [
    { nome: 'identificador', rotulo: 'Patrimônio ou S/N do ativo' },
    { nome: 'patrimonio_confirmado', rotulo: 'Confirme o patrimônio', dica: 'Redigite — conferência obrigatória' },
    { nome: 'numero_serie_confirmado', rotulo: 'Confirme o S/N', dica: 'Redigite — conferência obrigatória' },
    { nome: 'motivo', rotulo: 'Motivo do descarte' },
    { nome: 'limpeza_dados', rotulo: 'Limpeza segura de dados', tipo: 'select', opcoes: ['confirmada', 'dispensada'] },
    { nome: 'justificativa_dispensa', rotulo: 'Justificativa da dispensa', dica: 'Obrigatória se a limpeza foi dispensada', opcional: true },
    { nome: 'aprovador', rotulo: 'Aprovador' },
    { nome: 'evidencia', rotulo: 'Evidência', dica: 'Nº do termo assinado ou link da foto' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', opcional: true },
  ],
  Retificacao: [
    { nome: 'identificador', rotulo: 'Patrimônio ou S/N do ativo' },
    { nome: 'evento_ref', rotulo: 'Nº do evento original', tipo: 'number' },
    { nome: 'descricao', rotulo: 'Descrição da correção', tipo: 'textarea' },
  ],
};

const RESUMO_EVENTO = {
  Recebimento: 'Cadastra um equipamento novo no controle, em estoque.',
  Formatacao: 'Registra a reimagem de um equipamento já cadastrado.',
  Movimentacao: 'Troca de responsável, setor, localização ou envio para assistência.',
  Manutencao: 'Intervenção técnica concluída, sem trocar o responsável.',
  Descarte: 'Baixa definitiva. Exige conferência de patrimônio e S/N.',
  Retificacao: 'Corrige um evento anterior sem apagar o registro original.',
};

async function telaRegistrar() {
  const tipos = Object.keys(FORMULARIOS);
  $('#conteudo').innerHTML = `
    <h2>Registrar evento</h2>
    <div class="cartao">
      <label>Tipo de evento
        <select id="tipo-evento">${tipos.map((t) => `<option value="${t}">${escapar(rotuloEvento(t))}</option>`).join('')}</select>
        <span class="dica" id="resumo-evento"></span>
      </label>
      <form id="form-evento"></form>
      <div id="retorno-evento" hidden></div>
    </div>`;

  const desenharCampos = () => {
    const tipo = $('#tipo-evento').value;
    $('#resumo-evento').textContent = RESUMO_EVENTO[tipo] || '';
    const campos = FORMULARIOS[tipo].map((campo) => {
      const obrigatorio = campo.opcional ? '' : 'required';
      const dica = campo.dica ? `<span class="dica">${escapar(campo.dica)}</span>` : '';
      if (campo.tipo === 'select') {
        return `<label>${campo.rotulo}
          <select name="${campo.nome}" ${obrigatorio}>${campo.opcoes.map((o) => `<option>${o}</option>`).join('')}</select>${dica}
        </label>`;
      }
      if (campo.tipo === 'textarea') {
        return `<label>${campo.rotulo}<textarea name="${campo.nome}" rows="2" ${obrigatorio}></textarea>${dica}</label>`;
      }
      if (campo.tipo === 'checkbox') {
        return `<label class="campo-checkbox"><input type="checkbox" name="${campo.nome}" ${obrigatorio}> ${campo.rotulo}</label>`;
      }
      return `<label>${campo.rotulo}<input name="${campo.nome}" type="${campo.tipo || 'text'}" ${obrigatorio}>${dica}</label>`;
    }).join('');
    $('#form-evento').innerHTML = `
      <div class="linha-campos">${campos}</div>
      <button type="submit" class="botao primario">Registrar ${escapar(rotuloEvento(tipo))}</button>`;
    limparAviso('#retorno-evento');
  };

  desenharCampos();
  $('#tipo-evento').addEventListener('change', desenharCampos);

  $('#form-evento').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const tipo = $('#tipo-evento').value;
    const formulario = new FormData(evento.target);
    const dados = {};
    for (const campo of FORMULARIOS[tipo]) {
      if (campo.tipo === 'checkbox') {
        dados[campo.nome] = formulario.get(campo.nome) === 'on';
      } else {
        const valor = String(formulario.get(campo.nome) || '').trim();
        if (valor) dados[campo.nome] = valor;
      }
    }
    mostrarAviso('#retorno-evento', 'info', 'Registrando…');
    try {
      const resultado = await api('/api/eventos', { metodo: 'POST', corpo: { tipo, dados } });
      if (resultado.aprovacao_pendente) {
        mostrarAviso('#retorno-evento', 'alerta', resultado.mensagem);
      } else {
        mostrarAviso('#retorno-evento', 'sucesso',
          `Evento nº ${resultado.evento_id} registrado. Status do ativo: ${resultado.status_novo}.`);
        evento.target.reset();
      }
    } catch (erro) {
      mostrarAviso('#retorno-evento', 'erro', erro.message, erro.detalhes);
    }
  });
}

async function telaAprovacoes() {
  const { aprovacoes } = await api('/api/aprovacoes?status=pendente');
  const podeDecidir = ['aprovador', 'admin'].includes(estado.usuario.papel);

  const linhas = aprovacoes.map((ap) => `
    <tr>
      <td>${ap.id}</td>
      <td><strong>${escapar(ap.patrimonio)}</strong> · ${escapar(ap.modelo)}<br><small>S/N ${escapar(ap.numero_serie)}</small></td>
      <td>${escapar(ap.payload.motivo || '—')}</td>
      <td>${escapar(ap.solicitante_nome)}<br><small>${formatarData(ap.criado_em)}</small></td>
      <td>${podeDecidir ? `
        <div class="barra-acoes justa">
          <button class="botao primario pequeno" data-decisao="aprovado" data-id="${ap.id}" data-patrimonio="${escapar(ap.patrimonio)}">Aprovar</button>
          <button class="botao perigo pequeno" data-decisao="rejeitado" data-id="${ap.id}" data-patrimonio="${escapar(ap.patrimonio)}">Rejeitar</button>
        </div>` : '<small>aguardando aprovador</small>'}
      </td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Descartes aguardando aprovação</h2>
    <p class="sub">Equipamentos que constavam como <strong>Em uso</strong> no momento do pedido de
       descarte exigem aprovação humana antes da baixa.</p>
    <div class="cartao">
      ${linhas ? `<div class="rolagem-tabela">
        <table>
          <thead><tr><th>Nº</th><th>Ativo</th><th>Motivo</th><th>Solicitante</th><th>Decisão</th></tr></thead>
          <tbody id="corpo-aprovacoes">${linhas}</tbody>
        </table>
      </div>` : blocoVazio('Nenhuma pendência', 'Nenhum descarte aguardando decisão no momento.')}
      <div id="retorno-aprovacao" hidden></div>
    </div>`;

  const corpo = $('#corpo-aprovacoes');
  if (!corpo) return;

  corpo.addEventListener('click', async (e) => {
    const botao = e.target.closest('button[data-decisao]');
    if (!botao) return;
    const decisao = botao.dataset.decisao;
    const rejeicao = decisao === 'rejeitado';

    const resposta = await confirmarDialogo({
      titulo: rejeicao ? 'Rejeitar descarte' : 'Aprovar descarte',
      texto: rejeicao
        ? `O ativo ${botao.dataset.patrimonio} continua Em uso e o pedido é recusado.`
        : `O ativo ${botao.dataset.patrimonio} será baixado em definitivo. Esta ação não pode ser desfeita.`,
      rotuloOk: rejeicao ? 'Rejeitar' : 'Aprovar descarte',
      perigo: rejeicao,
      campo: {
        rotulo: rejeicao ? 'Justificativa da rejeição' : 'Observação da aprovação (opcional)',
        placeholder: rejeicao ? 'Ex.: equipamento ainda em condições de uso' : '',
        obrigatorio: rejeicao,
        mensagemObrigatoria: 'Informe a justificativa da rejeição — ela fica registrada na trilha.',
      },
    });
    if (!resposta) return;

    try {
      await api(`/api/aprovacoes/${botao.dataset.id}/decisao`, {
        metodo: 'POST',
        corpo: { decisao, justificativa: resposta.valor },
      });
      telaAprovacoes();
    } catch (erro) {
      mostrarAviso('#retorno-aprovacao', 'erro', erro.message, erro.detalhes);
    }
  });
}

async function telaAuditoria(filtros = {}) {
  const parametros = new URLSearchParams();
  if (filtros.colaborador) parametros.set('colaborador', filtros.colaborador);
  if (filtros.tipo) parametros.set('tipo', filtros.tipo);
  const { eventos, escopo, colaborador } = await api(`/api/auditoria/eventos?${parametros}`);
  const apenasProprio = escopo === 'proprio';

  const tipos = ['', 'Recebimento', 'Formatacao', 'Movimentacao', 'Manutencao', 'Descarte', 'Retificacao'];
  const linhas = eventos.map((e) => `
    <tr>
      <td>${e.id}</td>
      <td>${formatarData(e.data_hora)}</td>
      <td>${escapar(rotuloEvento(e.tipo))}</td>
      <td><strong>${escapar(e.patrimonio)}</strong><br><small>${escapar(e.modelo)}</small></td>
      <td>${escapar(e.autor_nome)}</td>
      <td>${transicao(e.status_anterior, e.status_novo)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Auditoria</h2>
    <p class="sub">Consulta do histórico por colaborador (LGPD, art. 18) ou por tipo de evento.
       Nenhum registro pode ser editado ou apagado — correções aparecem como Retificação.</p>
    ${apenasProprio ? htmlAviso('info',
      `Seu papel dá acesso apenas ao seu próprio histórico (${colaborador}). A consulta ampla, que mostra a atuação de todos os colaboradores, é restrita a aprovador e administrador.`) : ''}
    <div class="barra-acoes">
      <input id="filtro-colaborador" class="busca" placeholder="Nome do colaborador…" value="${escapar(filtros.colaborador || '')}" ${apenasProprio ? 'disabled' : ''}>
      <select id="filtro-tipo">${tipos.map((t) => `<option value="${t}" ${filtros.tipo === t ? 'selected' : ''}>${t ? escapar(rotuloEvento(t)) : 'Todos os eventos'}</option>`).join('')}</select>
      <button class="botao" id="botao-auditar">Consultar</button>
    </div>
    <div class="cartao">
      ${linhas ? `<div class="rolagem-tabela">
        <table>
          <thead><tr><th>Nº</th><th>Data</th><th>Evento</th><th>Ativo</th><th>Autor</th><th>Status</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>` : blocoVazio('Nenhum evento encontrado', 'Ajuste o nome do colaborador ou o tipo de evento e consulte de novo.')}
    </div>`;

  const consultar = () => telaAuditoria({
    colaborador: apenasProprio ? '' : $('#filtro-colaborador').value.trim(),
    tipo: $('#filtro-tipo').value,
  });
  $('#botao-auditar').addEventListener('click', consultar);
  $('#filtro-colaborador').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') consultar();
  });
}

async function telaUsuarios() {
  const { usuarios } = await api('/api/usuarios');
  const linhas = usuarios.map((u) => `
    <tr>
      <td><strong>${escapar(u.nome)}</strong></td><td>${escapar(u.email)}</td>
      <td>${escapar(u.matricula || '—')}</td><td>${escapar(u.papel)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Usuários</h2>
    <div class="cartao rolagem-tabela">
      <table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Matrícula</th><th>Papel</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    <div class="cartao">
      <h3>Novo usuário</h3>
      <form id="form-usuario">
        <div class="linha-campos">
          <label>Nome<input name="nome" required></label>
          <label>E-mail<input name="email" type="email" required></label>
          <label>Matrícula<input name="matricula"></label>
          <label>Papel
            <select name="papel">
              <option>operador</option><option>tecnico</option>
              <option>aprovador</option><option>admin</option>
            </select>
            <span class="dica">Só aprovador e admin decidem descartes</span>
          </label>
          <label>Senha inicial<input name="senha" type="password" minlength="8" required>
            <span class="dica">Mínimo de 8 caracteres</span>
          </label>
        </div>
        <button class="botao primario" type="submit">Criar usuário</button>
        <div id="retorno-usuario" hidden></div>
      </form>
    </div>`;

  $('#form-usuario').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const formulario = new FormData(evento.target);
    try {
      await api('/api/usuarios', { metodo: 'POST', corpo: Object.fromEntries(formulario) });
      telaUsuarios();
    } catch (erro) {
      mostrarAviso('#retorno-usuario', 'erro', erro.message, erro.detalhes);
    }
  });
}

iniciar();
