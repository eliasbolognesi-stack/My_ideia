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
    const detalhes = corpo.detalhes ? `: ${corpo.detalhes.join('; ')}` : '';
    const erro = new Error(`${corpo.erro || 'erro'}${detalhes}`);
    erro.detalhes = corpo.detalhes;
    throw erro;
  }
  return corpo;
}

function selo(status) {
  return `<span class="selo" data-status="${escapar(status)}">${escapar(status)}</span>`;
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
function sair() {
  if (estado.token) api('/api/auth/logout', { metodo: 'POST' }).catch(() => {});
  estado.token = null;
  estado.usuario = null;
  try { localStorage.removeItem('sga_ti_token'); } catch { /* ok */ }
  $('#app').hidden = true;
  $('#tela-login').hidden = false;
}

async function iniciar() {
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
  $('#usuario-logado').textContent = `${estado.usuario.nome} · ${estado.usuario.papel}`;
  $('#menu-usuarios').hidden = estado.usuario.papel !== 'admin';
  navegar('dashboard');
}

$('#form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const formulario = new FormData(evento.target);
  const erroEl = $('#erro-login');
  erroEl.hidden = true;
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
    erroEl.textContent = erro.message;
    erroEl.hidden = false;
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
  TELAS[nome](argumento).catch((erro) => {
    $('#conteudo').innerHTML = `<div class="cartao"><p class="erro">${escapar(erro.message)}</p></div>`;
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
      <div class="indicador">
        <div class="valor">${total}</div>
        <div class="rotulo">${escapar(status)}</div>
      </div>`)
    .join('');

  const linhas = dados.ultimos_eventos.map((e) => `
    <tr>
      <td>${formatarData(e.data_hora)}</td>
      <td>${escapar(e.tipo)}</td>
      <td>${escapar(e.patrimonio)} · ${escapar(e.modelo)}</td>
      <td>${escapar(e.autor_nome)}</td>
      <td>${e.status_anterior ? selo(e.status_anterior) + ' → ' : ''}${selo(e.status_novo)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Visão geral</h2>
    <div class="grade-indicadores">${indicadores}
      <div class="indicador">
        <div class="valor">${dados.aprovacoes_pendentes}</div>
        <div class="rotulo">Descartes aguardando aprovação</div>
      </div>
    </div>
    <div class="cartao">
      <h3>Últimos eventos</h3>
      <div class="rolagem-tabela">
        <table>
          <thead><tr><th>Data</th><th>Evento</th><th>Ativo</th><th>Autor</th><th>Status</th></tr></thead>
          <tbody>${linhas || '<tr><td colspan="5">Nenhum evento registrado ainda.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

async function telaAtivos(filtros = {}) {
  const parametros = new URLSearchParams();
  if (filtros.status) parametros.set('status', filtros.status);
  if (filtros.q) parametros.set('q', filtros.q);
  const { ativos } = await api(`/api/ativos?${parametros}`);

  const STATUS_TODOS = ['Em estoque', 'Em formatação', 'Em uso', 'Em manutenção', 'Reservado para descarte', 'Descartado'];
  const opcoes = STATUS_TODOS.map((s) => `<option value="${s}" ${filtros.status === s ? 'selected' : ''}>${s}</option>`).join('');

  const linhas = ativos.map((a) => `
    <tr class="clicavel" data-id="${a.id}">
      <td><strong>${escapar(a.patrimonio)}</strong></td>
      <td>${escapar(a.numero_serie)}</td>
      <td>${escapar(a.fabricante)} ${escapar(a.modelo)}</td>
      <td>${escapar(a.tipo_equipamento)}</td>
      <td>${selo(a.status_atual)}</td>
      <td>${escapar(a.responsavel_atual || '—')}</td>
      <td>${escapar(a.localizacao_atual)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Ativos</h2>
    <div class="barra-acoes">
      <input id="busca-ativos" placeholder="Buscar por patrimônio, S/N, modelo, responsável…" value="${escapar(filtros.q || '')}">
      <select id="filtro-status">
        <option value="">Todos os status</option>${opcoes}
      </select>
      <button class="botao" id="botao-filtrar">Filtrar</button>
    </div>
    <div class="cartao rolagem-tabela">
      <table>
        <thead><tr><th>Patrimônio</th><th>S/N</th><th>Equipamento</th><th>Tipo</th><th>Status</th><th>Responsável</th><th>Localização</th></tr></thead>
        <tbody id="corpo-ativos">${linhas || '<tr><td colspan="7">Nenhum ativo encontrado.</td></tr>'}</tbody>
      </table>
    </div>`;

  $('#botao-filtrar').addEventListener('click', () => {
    telaAtivos({ q: $('#busca-ativos').value.trim(), status: $('#filtro-status').value });
  });
  $('#busca-ativos').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#botao-filtrar').click();
  });
  $('#corpo-ativos').addEventListener('click', (e) => {
    const linha = e.target.closest('tr[data-id]');
    if (linha) telaDetalheAtivo(Number(linha.dataset.id));
  });
}

async function telaDetalheAtivo(id) {
  const { ativo, eventos } = await api(`/api/ativos/${id}`);

  const itens = eventos.map((e) => `
    <li>
      <div class="cabeca">${escapar(e.tipo)} — evento nº ${e.id}${e.evento_ref ? ` (retifica o evento nº ${e.evento_ref})` : ''}</div>
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
      <p>
        S/N <strong>${escapar(ativo.numero_serie)}</strong> · ${escapar(ativo.tipo_equipamento)} ·
        ${selo(ativo.status_atual)}<br>
        Localização: ${escapar(ativo.localizacao_atual)} ·
        Responsável: ${escapar(ativo.responsavel_atual || '—')} ·
        Entrada: ${escapar(ativo.data_entrada)}
      </p>
      <p id="resultado-integridade"></p>
    </div>
    <div class="cartao">
      <h3>Histórico (trilha de auditoria imutável)</h3>
      <ul class="linha-tempo">${itens || '<li>Nenhum evento.</li>'}</ul>
    </div>`;

  $('#voltar-ativos').addEventListener('click', () => navegar('ativos'));
  $('#verificar-integridade').addEventListener('click', async () => {
    const alvo = $('#resultado-integridade');
    alvo.innerHTML = 'Verificando…';
    try {
      const r = await api(`/api/ativos/${id}/integridade`);
      alvo.innerHTML = r.valida
        ? `<span class="sucesso">Cadeia íntegra: ${r.eventos_verificados} evento(s) verificados.</span>`
        : `<span class="erro">Cadeia comprometida:</span><ul class="aviso-lista">${r.falhas.map((f) => `<li>${escapar(f)}</li>`).join('')}</ul>`;
    } catch (erro) {
      alvo.innerHTML = `<span class="erro">${escapar(erro.message)}</span>`;
    }
  });
}

// Definições de formulário por tipo de evento (espelham a seção 5 do prompt).
const FORMULARIOS = {
  Recebimento: [
    { nome: 'patrimonio', rotulo: 'Nº de patrimônio' },
    { nome: 'numero_serie', rotulo: 'Número de série (S/N)' },
    { nome: 'fabricante', rotulo: 'Fabricante', tipo: 'select', opcoes: ['Dell', 'Lenovo', 'Outro'] },
    { nome: 'modelo', rotulo: 'Modelo (ex.: Latitude 5420)' },
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
    { nome: 'destino', rotulo: 'Destino (sala/filial/colaborador/assistência)' },
    { nome: 'tipo_destino', rotulo: 'Tipo de destino', tipo: 'select', opcoes: ['colaborador', 'estoque', 'assistencia', 'fornecedor'] },
    { nome: 'quem_entrega', rotulo: 'Quem entrega' },
    { nome: 'quem_recebe', rotulo: 'Quem recebe' },
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
    { nome: 'patrimonio_confirmado', rotulo: 'Confirme o patrimônio (redigite)' },
    { nome: 'numero_serie_confirmado', rotulo: 'Confirme o S/N (redigite)' },
    { nome: 'motivo', rotulo: 'Motivo do descarte' },
    { nome: 'limpeza_dados', rotulo: 'Limpeza segura de dados', tipo: 'select', opcoes: ['confirmada', 'dispensada'] },
    { nome: 'justificativa_dispensa', rotulo: 'Justificativa da dispensa (se dispensada)', opcional: true },
    { nome: 'aprovador', rotulo: 'Aprovador' },
    { nome: 'evidencia', rotulo: 'Evidência (nº do termo assinado / link da foto)' },
    { nome: 'observacoes', rotulo: 'Observações', tipo: 'textarea', opcional: true },
  ],
  Retificacao: [
    { nome: 'identificador', rotulo: 'Patrimônio ou S/N do ativo' },
    { nome: 'evento_ref', rotulo: 'Nº do evento original', tipo: 'number' },
    { nome: 'descricao', rotulo: 'Descrição da correção', tipo: 'textarea' },
  ],
};

async function telaRegistrar() {
  const tipos = Object.keys(FORMULARIOS);
  $('#conteudo').innerHTML = `
    <h2>Registrar evento</h2>
    <div class="cartao">
      <label>Tipo de evento
        <select id="tipo-evento">${tipos.map((t) => `<option>${t}</option>`).join('')}</select>
      </label>
      <form id="form-evento"></form>
      <p id="retorno-evento"></p>
    </div>`;

  const desenharCampos = () => {
    const tipo = $('#tipo-evento').value;
    const campos = FORMULARIOS[tipo].map((campo) => {
      const obrigatorio = campo.opcional ? '' : 'required';
      if (campo.tipo === 'select') {
        return `<label>${campo.rotulo}
          <select name="${campo.nome}" ${obrigatorio}>${campo.opcoes.map((o) => `<option>${o}</option>`).join('')}</select>
        </label>`;
      }
      if (campo.tipo === 'textarea') {
        return `<label>${campo.rotulo}<textarea name="${campo.nome}" rows="2" ${obrigatorio}></textarea></label>`;
      }
      if (campo.tipo === 'checkbox') {
        return `<label class="campo-checkbox"><input type="checkbox" name="${campo.nome}" ${obrigatorio}> ${campo.rotulo}</label>`;
      }
      return `<label>${campo.rotulo}<input name="${campo.nome}" type="${campo.tipo || 'text'}" ${obrigatorio}></label>`;
    }).join('');
    $('#form-evento').innerHTML = `
      <div class="linha-campos">${campos}</div>
      <button type="submit" class="botao primario">Registrar ${tipo}</button>`;
    $('#retorno-evento').textContent = '';
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
    const retorno = $('#retorno-evento');
    retorno.className = '';
    retorno.textContent = 'Registrando…';
    try {
      const resultado = await api('/api/eventos', { metodo: 'POST', corpo: { tipo, dados } });
      retorno.className = 'sucesso';
      if (resultado.aprovacao_pendente) {
        retorno.textContent = resultado.mensagem;
      } else {
        retorno.textContent = `Evento nº ${resultado.evento_id} registrado. Status do ativo: ${resultado.status_novo}.`;
        evento.target.reset();
      }
    } catch (erro) {
      retorno.className = 'erro';
      retorno.textContent = erro.message;
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
        <button class="botao primario" data-decisao="aprovado" data-id="${ap.id}">Aprovar</button>
        <button class="botao perigo" data-decisao="rejeitado" data-id="${ap.id}">Rejeitar</button>` : '<em>aguardando aprovador</em>'}
      </td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Descartes aguardando aprovação</h2>
    <p>Equipamentos que constavam como <strong>Em uso</strong> no momento do pedido de descarte
       exigem aprovação humana antes da baixa.</p>
    <div class="cartao rolagem-tabela">
      <table>
        <thead><tr><th>Nº</th><th>Ativo</th><th>Motivo</th><th>Solicitante</th><th>Decisão</th></tr></thead>
        <tbody id="corpo-aprovacoes">${linhas || '<tr><td colspan="5">Nenhuma pendência.</td></tr>'}</tbody>
      </table>
      <p id="retorno-aprovacao"></p>
    </div>`;

  $('#corpo-aprovacoes').addEventListener('click', async (e) => {
    const botao = e.target.closest('button[data-decisao]');
    if (!botao) return;
    const decisao = botao.dataset.decisao;
    const justificativa = decisao === 'rejeitado'
      ? prompt('Justificativa da rejeição:')
      : prompt('Justificativa/observação da aprovação (opcional):') || '';
    if (decisao === 'rejeitado' && !justificativa) return;
    const retorno = $('#retorno-aprovacao');
    try {
      await api(`/api/aprovacoes/${botao.dataset.id}/decisao`, {
        metodo: 'POST',
        corpo: { decisao, justificativa },
      });
      telaAprovacoes();
    } catch (erro) {
      retorno.className = 'erro';
      retorno.textContent = erro.message;
    }
  });
}

async function telaAuditoria(filtros = {}) {
  const parametros = new URLSearchParams();
  if (filtros.colaborador) parametros.set('colaborador', filtros.colaborador);
  if (filtros.tipo) parametros.set('tipo', filtros.tipo);
  const { eventos } = await api(`/api/auditoria/eventos?${parametros}`);

  const tipos = ['', 'Recebimento', 'Formatacao', 'Movimentacao', 'Manutencao', 'Descarte', 'Retificacao'];
  const linhas = eventos.map((e) => `
    <tr>
      <td>${e.id}</td>
      <td>${formatarData(e.data_hora)}</td>
      <td>${escapar(e.tipo)}</td>
      <td>${escapar(e.patrimonio)} · ${escapar(e.modelo)}</td>
      <td>${escapar(e.autor_nome)}</td>
      <td>${e.status_anterior ? escapar(e.status_anterior) + ' → ' : ''}${escapar(e.status_novo)}</td>
    </tr>`).join('');

  $('#conteudo').innerHTML = `
    <h2>Auditoria</h2>
    <p>Consulta do histórico por colaborador (LGPD, art. 18) ou por tipo de evento.
       Nenhum registro pode ser editado ou apagado — correções aparecem como Retificação.</p>
    <div class="barra-acoes">
      <input id="filtro-colaborador" placeholder="Nome do colaborador…" value="${escapar(filtros.colaborador || '')}">
      <select id="filtro-tipo">${tipos.map((t) => `<option value="${t}" ${filtros.tipo === t ? 'selected' : ''}>${t || 'Todos os eventos'}</option>`).join('')}</select>
      <button class="botao" id="botao-auditar">Consultar</button>
    </div>
    <div class="cartao rolagem-tabela">
      <table>
        <thead><tr><th>Nº</th><th>Data</th><th>Evento</th><th>Ativo</th><th>Autor</th><th>Status</th></tr></thead>
        <tbody>${linhas || '<tr><td colspan="6">Nenhum evento para os filtros informados.</td></tr>'}</tbody>
      </table>
    </div>`;

  $('#botao-auditar').addEventListener('click', () => {
    telaAuditoria({ colaborador: $('#filtro-colaborador').value.trim(), tipo: $('#filtro-tipo').value });
  });
}

async function telaUsuarios() {
  const { usuarios } = await api('/api/usuarios');
  const linhas = usuarios.map((u) => `
    <tr>
      <td>${escapar(u.nome)}</td><td>${escapar(u.email)}</td>
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
          </label>
          <label>Senha inicial<input name="senha" type="password" minlength="8" required></label>
        </div>
        <button class="botao primario" type="submit">Criar usuário</button>
        <p id="retorno-usuario"></p>
      </form>
    </div>`;

  $('#form-usuario').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const formulario = new FormData(evento.target);
    const retorno = $('#retorno-usuario');
    try {
      await api('/api/usuarios', { metodo: 'POST', corpo: Object.fromEntries(formulario) });
      telaUsuarios();
    } catch (erro) {
      retorno.className = 'erro';
      retorno.textContent = erro.message;
    }
  });
}

iniciar();
