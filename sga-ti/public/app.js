'use strict';

// ---------------------------------------------------------------------------
// Estado e utilitários
// ---------------------------------------------------------------------------
const estado = {
  token: null,
  usuario: null,
  // Para onde voltar depois de entrar de novo (sessão expirada ou primeiro acesso).
  rotaPretendida: null,
  // Rascunho do formulário de evento: sobrevive a troca de tela e à expiração
  // da sessão, para ninguém perder o que digitou.
  rascunhoEvento: null,
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

const MSG_SESSAO_EXPIRADA =
  'Sua sessão expirou por segurança. Entre novamente — você volta para a mesma tela.';

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
    // Guarda a tela atual para retomar depois de entrar de novo, e explica o
    // que houve na própria tela de login — antes a pessoa caía lá sem saber.
    sair({ motivo: MSG_SESSAO_EXPIRADA, lembrarRota: true });
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

// Impede envio duplicado: desabilita o botão enquanto a ação está em curso e
// devolve o rótulo original ao terminar.
async function comBotaoOcupado(botao, rotuloOcupado, acao) {
  if (!botao) return acao();
  const rotulo = botao.textContent;
  botao.disabled = true;
  botao.textContent = rotuloOcupado;
  try {
    return await acao();
  } finally {
    botao.disabled = false;
    botao.textContent = rotulo;
  }
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
function sair({ motivo = null, lembrarRota = false } = {}) {
  if (lembrarRota && location.hash && location.hash !== '#/') estado.rotaPretendida = location.hash;
  if (estado.token && !lembrarRota) api('/api/auth/logout', { metodo: 'POST' }).catch(() => {});
  estado.token = null;
  estado.usuario = null;
  try { localStorage.removeItem('sga_ti_token'); } catch { /* ok */ }

  $('#app').hidden = true;
  $('#tela-login').hidden = false;
  document.title = 'SGA-TI — Entrar';
  if (motivo) mostrarAviso('#erro-login', 'alerta', motivo);
  else limparAviso('#erro-login');
  const campoEmail = $('#form-login input[name=email]');
  if (campoEmail) campoEmail.focus();
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
  // Quem abriu um link direto sem estar autenticado volta para ele ao entrar.
  if (location.hash && location.hash !== '#/') estado.rotaPretendida = location.hash;
  $('#tela-login').hidden = false;
}

function entrarNoApp() {
  $('#tela-login').hidden = true;
  $('#app').hidden = false;
  limparAviso('#erro-login');
  $('#usuario-logado').innerHTML =
    `<strong>${escapar(estado.usuario.nome)}</strong>${escapar(estado.usuario.papel)}`;
  $('#menu-usuarios').hidden = estado.usuario.papel !== 'admin';

  const destino = estado.rotaPretendida;
  estado.rotaPretendida = null;
  if (destino && destino !== location.hash) location.hash = destino;
  else aplicarRota();
}

$('#form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const formulario = evento.target;
  limparAviso('#erro-login');
  try {
    const sessao = await comBotaoOcupado(formulario.querySelector('button[type=submit]'), 'Entrando…', () =>
      api('/api/auth/login', {
        metodo: 'POST',
        corpo: { email: formulario.elements.email.value, senha: formulario.elements.senha.value },
      }));
    estado.token = sessao.token;
    estado.usuario = sessao.usuario;
    try { localStorage.setItem('sga_ti_token', sessao.token); } catch { /* ok */ }
    formulario.reset();
    entrarNoApp();
  } catch (erro) {
    mostrarAviso('#erro-login', 'erro', erro.message, erro.detalhes);
    // Senha digitada errada não fica na tela: limpa e devolve o foco.
    formulario.elements.senha.value = '';
    formulario.elements.senha.focus();
  }
});

$('#botao-sair').addEventListener('click', () => sair());

// ---------------------------------------------------------------------------
// Navegação por endereço
//
// Cada tela tem endereço próprio (#/ativos, #/ativos/12, #/registrar?tipo=…).
// É isso que faz o botão Voltar do navegador funcionar, permite favoritar e
// mandar o link de um equipamento para um colega, e mantém a tela e os
// filtros ao recarregar a página.
// ---------------------------------------------------------------------------
const ROTAS = {
  painel: { tela: () => telaDashboard(), titulo: 'Visão geral', menu: 'painel' },
  ativos: { tela: (r) => (r.parametro ? telaDetalheAtivo(r.parametro) : telaAtivos(r)), titulo: 'Ativos', menu: 'ativos' },
  registrar: { tela: (r) => telaRegistrar(r), titulo: 'Registrar evento', menu: 'registrar' },
  aprovacoes: { tela: () => telaAprovacoes(), titulo: 'Aprovações', menu: 'aprovacoes' },
  auditoria: { tela: (r) => telaAuditoria(r), titulo: 'Auditoria', menu: 'auditoria' },
  usuarios: { tela: () => telaUsuarios(), titulo: 'Usuários', menu: 'usuarios' },
};

function lerRota() {
  const bruto = location.hash.replace(/^#\/?/, '');
  const [caminho, consulta] = bruto.split('?');
  const partes = caminho.split('/').filter(Boolean);
  const nome = ROTAS[partes[0]] ? partes[0] : 'painel';
  return { nome, parametro: partes[1] || null, params: new URLSearchParams(consulta || '') };
}

// Monta o endereço de uma tela a partir dos filtros, ignorando os vazios.
function endereco(nome, { parametro = null, filtros = {} } = {}) {
  const params = new URLSearchParams();
  for (const [chave, valor] of Object.entries(filtros)) {
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') params.set(chave, valor);
  }
  const consulta = params.toString();
  return `#/${nome}${parametro ? `/${parametro}` : ''}${consulta ? `?${consulta}` : ''}`;
}

function irPara(hash) {
  if (location.hash === hash) aplicarRota();
  else location.hash = hash;
}

function aplicarRota() {
  if (!estado.usuario) return;
  const rota = lerRota();
  const config = ROTAS[rota.nome];

  document.querySelectorAll('#menu a[data-tela]').forEach((a) => {
    const ativo = a.dataset.tela === config.menu;
    a.classList.toggle('ativo', ativo);
    if (ativo) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `SGA-TI — ${config.titulo}`;

  $('#conteudo').innerHTML = ESQUELETO;
  window.scrollTo({ top: 0 });

  config.tela(rota)
    .then(() => {
      // Leitor de tela e teclado começam do título da tela nova, não do topo.
      const titulo = $('#conteudo h2');
      if (titulo) {
        titulo.setAttribute('tabindex', '-1');
        titulo.focus({ preventScroll: true });
      }
    })
    .catch((erro) => {
      if (erro.message === 'sessão expirada') return;
      $('#conteudo').innerHTML = `<div class="cartao">${htmlAviso('erro', erro.message, erro.detalhes)}</div>`;
    });
}

window.addEventListener('hashchange', aplicarRota);

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
      <a class="indicador" data-status="${escapar(status)}" href="${endereco('ativos', { filtros: { status } })}">
        <div class="valor">${total}</div>
        <div class="rotulo">${escapar(status)}</div>
      </a>`)
    .join('');

  // Pendência de aprovação é ação, não número: vira um aviso com atalho.
  const pendencias = dados.aprovacoes_pendentes > 0
    ? htmlAviso(
      'alerta',
      `${dados.aprovacoes_pendentes} descarte(s) aguardando aprovação de um responsável.`,
      null,
      `<a class="botao pequeno" href="${endereco('aprovacoes')}">Revisar</a>`
    )
    : '';

  const linhas = dados.ultimos_eventos.map((e) => `
    <tr>
      <td>${formatarData(e.data_hora)}</td>
      <td>${escapar(rotuloEvento(e.tipo))}</td>
      <td><a href="${endereco('auditoria', { filtros: { tipo: e.tipo } })}" hidden></a>
        <strong>${escapar(e.patrimonio)}</strong><br><small>${escapar(e.modelo)}</small></td>
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
      </div>
      <p class="rodape-tabela">
        Mostrando os ${dados.ultimos_eventos.length} eventos mais recentes.
        <a href="${endereco('auditoria')}">Ver a auditoria completa</a>
      </p>` : blocoVazio('Nenhum evento ainda',
        'Assim que o primeiro equipamento for registrado, o histórico aparece aqui.',
        `<a class="botao primario" href="${endereco('registrar')}">Registrar evento</a>`)}
    </div>`;
}

async function telaAtivos(rota) {
  const filtros = {
    q: rota.params.get('q') || '',
    status: rota.params.get('status') || '',
  };
  const parametros = new URLSearchParams();
  if (filtros.status) parametros.set('status', filtros.status);
  if (filtros.q) parametros.set('q', filtros.q);
  const { ativos } = await api(`/api/ativos?${parametros}`);

  const STATUS_TODOS = ['Em estoque', 'Em formatação', 'Em uso', 'Em manutenção', 'Reservado para descarte', 'Descartado'];
  const opcoes = STATUS_TODOS.map((s) => `<option value="${s}" ${filtros.status === s ? 'selected' : ''}>${s}</option>`).join('');
  const comFiltro = Boolean(filtros.status || filtros.q);

  const linhas = ativos.map((a) => `
    <tr class="clicavel" data-id="${a.id}">
      <td><a class="link-ativo" href="${endereco('ativos', { parametro: a.id })}">${escapar(a.patrimonio)}</a></td>
      <td>${escapar(a.numero_serie)}</td>
      <td>${escapar(a.fabricante)} ${escapar(a.modelo)}<br><small>${escapar(a.tipo_equipamento)}</small></td>
      <td>${selo(a.status_atual)}</td>
      <td>${escapar(a.responsavel_atual || '—')}</td>
      <td>${escapar(a.localizacao_atual)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Ativos</h2>
    <form class="barra-acoes" id="form-filtro-ativos" role="search">
      <input id="busca-ativos" class="busca" name="q" placeholder="Buscar por patrimônio, S/N, modelo, responsável…"
             aria-label="Buscar equipamentos" value="${escapar(filtros.q)}">
      <select id="filtro-status" name="status" aria-label="Filtrar por status">
        <option value="">Todos os status</option>${opcoes}
      </select>
      <button class="botao" type="submit">Filtrar</button>
      ${comFiltro ? `<a class="botao discreto" href="${endereco('ativos')}">Limpar</a>` : ''}
    </form>
    <div class="cartao">
      ${linhas ? `<div class="rolagem-tabela">
        <table>
          <thead><tr><th>Patrimônio</th><th>S/N</th><th>Equipamento</th><th>Status</th><th>Responsável</th><th>Localização</th></tr></thead>
          <tbody id="corpo-ativos">${linhas}</tbody>
        </table>
      </div>
      <p class="rodape-tabela">${ativos.length} equipamento(s)${comFiltro ? ' para este filtro' : ''}.</p>`
      : blocoVazio(
        comFiltro ? 'Nenhum ativo para esse filtro' : 'Nenhum ativo cadastrado',
        comFiltro
          ? 'Tente outro termo de busca ou limpe o filtro de status.'
          : 'Registre um Recebimento para o primeiro equipamento entrar no controle.',
        comFiltro
          ? `<a class="botao" href="${endereco('ativos')}">Limpar filtro</a>`
          : `<a class="botao primario" href="${endereco('registrar')}">Registrar recebimento</a>`
      )}
    </div>`;

  $('#form-filtro-ativos').addEventListener('submit', (e) => {
    e.preventDefault();
    irPara(endereco('ativos', { filtros: { q: $('#busca-ativos').value.trim(), status: $('#filtro-status').value } }));
  });
  const corpo = $('#corpo-ativos');
  if (corpo) {
    corpo.addEventListener('click', (e) => {
      // O patrimônio é um link de verdade (dá para copiar e abrir em nova aba);
      // o resto da linha também navega, por conforto.
      if (e.target.closest('a')) return;
      const linha = e.target.closest('tr[data-id]');
      if (linha) irPara(endereco('ativos', { parametro: linha.dataset.id }));
    });
  }
}

async function telaDetalheAtivo(id) {
  const { ativo, eventos } = await api(`/api/ativos/${encodeURIComponent(id)}`);
  document.title = `SGA-TI — ${ativo.patrimonio}`;

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
      <a class="botao" href="${endereco('ativos')}">← Voltar para ativos</a>
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

  $('#verificar-integridade').addEventListener('click', async (e) => {
    mostrarAviso('#resultado-integridade', 'info', 'Verificando a cadeia de registros…');
    await comBotaoOcupado(e.currentTarget, 'Verificando…', async () => {
      try {
        const r = await api(`/api/ativos/${encodeURIComponent(id)}/integridade`);
        if (r.valida) {
          mostrarAviso('#resultado-integridade', 'sucesso',
            `Cadeia íntegra: ${r.eventos_verificados} evento(s) verificados, nenhum sinal de alteração.`);
        } else {
          mostrarAviso('#resultado-integridade', 'erro', 'Cadeia comprometida — registros não conferem:', r.falhas);
        }
      } catch (erro) {
        if (erro.message !== 'sessão expirada') mostrarAviso('#resultado-integridade', 'erro', erro.message, erro.detalhes);
      }
    });
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
    {
      nome: 'justificativa_dispensa',
      rotulo: 'Justificativa da dispensa',
      dica: 'Obrigatória quando a limpeza é dispensada',
      opcional: true,
      // Vira obrigatório assim que "dispensada" é escolhido, sem esperar o envio.
      obrigatorioSe: { campo: 'limpeza_dados', valor: 'dispensada' },
    },
    { nome: 'aprovador', rotulo: 'Aprovador' },
    { nome: 'evidencia', rotulo: 'Evidência', dica: 'Nº do termo assinado ou link https da empresa' },
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

async function telaRegistrar(rota) {
  const tipos = Object.keys(FORMULARIOS);
  const tipoRota = rota && rota.params.get('tipo');
  const tipoInicial = tipos.includes(tipoRota) ? tipoRota : tipos[0];

  $('#conteudo').innerHTML = `
    <h2>Registrar evento</h2>
    <div class="cartao">
      <label>Tipo de evento
        <select id="tipo-evento">${tipos.map((t) => `<option value="${t}" ${t === tipoInicial ? 'selected' : ''}>${escapar(rotuloEvento(t))}</option>`).join('')}</select>
        <span class="dica" id="resumo-evento"></span>
      </label>
      <p class="legenda-obrigatorio"><span class="marca-obrigatorio" aria-hidden="true">*</span> campo obrigatório</p>
      <form id="form-evento" novalidate></form>
      <div id="retorno-evento" hidden></div>
    </div>`;

  const campoHtml = (campo) => {
    const obrigatorio = !campo.opcional;
    const marca = obrigatorio ? '<span class="marca-obrigatorio" aria-hidden="true">*</span>' : '';
    const req = obrigatorio ? 'required' : '';
    // Campo cuja obrigatoriedade depende de outro ganha um asterisco que
    // aparece junto com a exigência, em vez de rótulo fixo que engana.
    const marcaCondicional = campo.obrigatorioSe
      ? `<span class="marca-obrigatorio" data-marca="${campo.nome}" hidden>*</span>` : '';
    const dica = campo.dica ? `<span class="dica" data-dica="${campo.nome}">${escapar(campo.dica)}</span>` : '';
    if (campo.tipo === 'select') {
      return `<label>${campo.rotulo}${marca}
        <select name="${campo.nome}" ${req}>${campo.opcoes.map((o) => `<option>${o}</option>`).join('')}</select>${dica}
      </label>`;
    }
    if (campo.tipo === 'textarea') {
      return `<label>${campo.rotulo}${marca}<textarea name="${campo.nome}" rows="2" ${req}></textarea>${dica}</label>`;
    }
    if (campo.tipo === 'checkbox') {
      return `<label class="campo-checkbox"><input type="checkbox" name="${campo.nome}" ${req}> ${campo.rotulo}${marca}</label>`;
    }
    return `<label>${campo.rotulo}${marca}${marcaCondicional}<input name="${campo.nome}" type="${campo.tipo || 'text'}" ${req}>${dica}</label>`;
  };

  const desenharCampos = () => {
    const tipo = $('#tipo-evento').value;
    $('#resumo-evento').textContent = RESUMO_EVENTO[tipo] || '';
    $('#form-evento').innerHTML = `
      <div class="linha-campos">${FORMULARIOS[tipo].map(campoHtml).join('')}</div>
      <button type="submit" class="botao primario">Registrar ${escapar(rotuloEvento(tipo))}</button>`;
    limparAviso('#retorno-evento');
    aplicarDependencias(tipo);
    restaurarRascunho(tipo);
  };

  // Campo que só é obrigatório em função de outro (a justificativa da dispensa
  // no descarte): a marcação muda na hora, não depois de o envio falhar.
  function aplicarDependencias(tipo) {
    const formulario = $('#form-evento');
    for (const campo of FORMULARIOS[tipo]) {
      if (!campo.obrigatorioSe) continue;
      const gatilho = formulario.elements[campo.obrigatorioSe.campo];
      const alvo = formulario.elements[campo.nome];
      if (!gatilho || !alvo) continue;
      const sincronizar = () => {
        const exigido = gatilho.value === campo.obrigatorioSe.valor;
        alvo.required = exigido;
        alvo.closest('label').classList.toggle('exigido-agora', exigido);
        const dica = formulario.querySelector(`[data-dica="${campo.nome}"]`);
        if (dica) dica.textContent = exigido ? 'Obrigatória: a limpeza foi dispensada' : campo.dica;
        const marca = formulario.querySelector(`[data-marca="${campo.nome}"]`);
        if (marca) marca.hidden = !exigido;
      };
      gatilho.addEventListener('change', sincronizar);
      sincronizar();
    }
  }

  // Rascunho em memória: trocar de tela, abrir a ficha de um ativo para
  // conferir o S/N ou perder a sessão não apaga o que já foi digitado.
  function guardarRascunho() {
    const tipo = $('#tipo-evento').value;
    const formulario = $('#form-evento');
    const valores = {};
    for (const campo of FORMULARIOS[tipo]) {
      const el = formulario.elements[campo.nome];
      if (!el) continue;
      valores[campo.nome] = campo.tipo === 'checkbox' ? el.checked : el.value;
    }
    estado.rascunhoEvento = { tipo, valores };
  }

  function restaurarRascunho(tipo) {
    const rascunho = estado.rascunhoEvento;
    if (!rascunho || rascunho.tipo !== tipo) return;
    const formulario = $('#form-evento');
    let restaurou = false;
    for (const [nome, valor] of Object.entries(rascunho.valores)) {
      const el = formulario.elements[nome];
      if (!el || valor === '' || valor === false) continue;
      if (typeof valor === 'boolean') el.checked = valor;
      else el.value = valor;
      restaurou = true;
    }
    if (restaurou) {
      mostrarAviso('#retorno-evento', 'info', 'Recuperamos o que você havia preenchido neste formulário.');
      aplicarDependencias(tipo);
    }
  }

  desenharCampos();
  $('#tipo-evento').addEventListener('change', () => {
    estado.rascunhoEvento = null;
    desenharCampos();
    // O tipo escolhido entra no endereço: dá para favoritar "registrar descarte".
    history.replaceState(null, '', endereco('registrar', { filtros: { tipo: $('#tipo-evento').value } }));
  });
  $('#form-evento').addEventListener('input', guardarRascunho);
  $('#form-evento').addEventListener('change', guardarRascunho);

  $('#form-evento').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const formulario = evento.target;
    if (!formulario.reportValidity()) return;

    const tipo = $('#tipo-evento').value;
    const dados = {};
    for (const campo of FORMULARIOS[tipo]) {
      const el = formulario.elements[campo.nome];
      if (!el) continue;
      if (campo.tipo === 'checkbox') dados[campo.nome] = el.checked;
      else if (el.value.trim()) dados[campo.nome] = el.value.trim();
    }

    mostrarAviso('#retorno-evento', 'info', 'Registrando…');
    await comBotaoOcupado(formulario.querySelector('button[type=submit]'), 'Registrando…', async () => {
      try {
        const resultado = await api('/api/eventos', { metodo: 'POST', corpo: { tipo, dados } });
        estado.rascunhoEvento = null;
        if (resultado.aprovacao_pendente) {
          mostrarAviso('#retorno-evento', 'alerta', resultado.mensagem);
        } else {
          const ver = `<a class="botao pequeno" href="${endereco('ativos', { parametro: resultado.ativo_id })}">Ver o equipamento</a>`;
          $('#retorno-evento').innerHTML = htmlAviso('sucesso',
            `Evento nº ${resultado.evento_id} registrado. Status do ativo: ${resultado.status_novo}.`, null, ver);
          $('#retorno-evento').hidden = false;
          formulario.reset();
          aplicarDependencias(tipo);
        }
      } catch (erro) {
        if (erro.message !== 'sessão expirada') mostrarAviso('#retorno-evento', 'erro', erro.message, erro.detalhes);
      }
    });
  });
}

async function telaAprovacoes() {
  const { aprovacoes } = await api('/api/aprovacoes?status=pendente');
  const podeDecidir = ['aprovador', 'admin'].includes(estado.usuario.papel);

  const linhas = aprovacoes.map((ap) => `
    <tr>
      <td>${ap.id}</td>
      <td><a class="link-ativo" href="${endereco('ativos', { parametro: ap.ativo_id })}">${escapar(ap.patrimonio)}</a>
        · ${escapar(ap.modelo)}<br><small>S/N ${escapar(ap.numero_serie)}</small></td>
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

    await comBotaoOcupado(botao, 'Enviando…', async () => {
      try {
        await api(`/api/aprovacoes/${botao.dataset.id}/decisao`, {
          metodo: 'POST',
          corpo: { decisao, justificativa: resposta.valor },
        });
        aplicarRota();
      } catch (erro) {
        if (erro.message !== 'sessão expirada') mostrarAviso('#retorno-aprovacao', 'erro', erro.message, erro.detalhes);
      }
    });
  });
}

async function telaAuditoria(rota) {
  const filtros = {
    colaborador: rota.params.get('colaborador') || '',
    tipo: rota.params.get('tipo') || '',
  };
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
      <td><a class="link-ativo" href="${endereco('ativos', { parametro: e.ativo_id })}">${escapar(e.patrimonio)}</a>
        <br><small>${escapar(e.modelo)}</small></td>
      <td>${escapar(e.autor_nome)}</td>
      <td>${transicao(e.status_anterior, e.status_novo)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Auditoria</h2>
    <p class="sub">Consulta do histórico por colaborador (LGPD, art. 18) ou por tipo de evento.
       Nenhum registro pode ser editado ou apagado — correções aparecem como Retificação.</p>
    ${apenasProprio ? htmlAviso('info',
      `Seu papel dá acesso apenas ao seu próprio histórico (${colaborador}). A consulta ampla, que mostra a atuação de todos os colaboradores, é restrita a aprovador e administrador.`) : ''}
    <form class="barra-acoes" id="form-filtro-auditoria" role="search">
      <input id="filtro-colaborador" class="busca" placeholder="Nome do colaborador…"
             aria-label="Filtrar por colaborador" value="${escapar(filtros.colaborador)}" ${apenasProprio ? 'disabled' : ''}>
      <select id="filtro-tipo" aria-label="Filtrar por tipo de evento">${tipos.map((t) => `<option value="${t}" ${filtros.tipo === t ? 'selected' : ''}>${t ? escapar(rotuloEvento(t)) : 'Todos os eventos'}</option>`).join('')}</select>
      <button class="botao" type="submit">Consultar</button>
    </form>
    <div class="cartao">
      ${linhas ? `<div class="rolagem-tabela">
        <table>
          <thead><tr><th>Nº</th><th>Data</th><th>Evento</th><th>Ativo</th><th>Autor</th><th>Status</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
      <p class="rodape-tabela">${eventos.length} evento(s)${eventos.length === 300 ? ' — mostrando os 300 mais recentes' : ''}.</p>`
      : blocoVazio('Nenhum evento encontrado', 'Ajuste o nome do colaborador ou o tipo de evento e consulte de novo.')}
    </div>`;

  $('#form-filtro-auditoria').addEventListener('submit', (e) => {
    e.preventDefault();
    irPara(endereco('auditoria', {
      filtros: {
        colaborador: apenasProprio ? '' : $('#filtro-colaborador').value.trim(),
        tipo: $('#filtro-tipo').value,
      },
    }));
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
      <p class="legenda-obrigatorio"><span class="marca-obrigatorio" aria-hidden="true">*</span> campo obrigatório</p>
      <form id="form-usuario">
        <div class="linha-campos">
          <label>Nome<span class="marca-obrigatorio" aria-hidden="true">*</span><input name="nome" required></label>
          <label>E-mail<span class="marca-obrigatorio" aria-hidden="true">*</span><input name="email" type="email" required></label>
          <label>Matrícula<input name="matricula"></label>
          <label>Papel<span class="marca-obrigatorio" aria-hidden="true">*</span>
            <select name="papel">
              <option>operador</option><option>tecnico</option>
              <option>aprovador</option><option>admin</option>
            </select>
            <span class="dica">Só aprovador e admin decidem descartes</span>
          </label>
          <label>Senha inicial<span class="marca-obrigatorio" aria-hidden="true">*</span>
            <input name="senha" type="password" minlength="8" required>
            <span class="dica">Mínimo de 8 caracteres</span>
          </label>
        </div>
        <button class="botao primario" type="submit">Criar usuário</button>
        <div id="retorno-usuario" hidden></div>
      </form>
    </div>`;

  $('#form-usuario').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const formulario = evento.target;
    await comBotaoOcupado(formulario.querySelector('button[type=submit]'), 'Criando…', async () => {
      try {
        await api('/api/usuarios', { metodo: 'POST', corpo: Object.fromEntries(new FormData(formulario)) });
        aplicarRota();
      } catch (erro) {
        if (erro.message !== 'sessão expirada') mostrarAviso('#retorno-usuario', 'erro', erro.message, erro.detalhes);
      }
    });
  });
}

iniciar();
