#!/usr/bin/env node
// Confere os fluxos deste diretório.
//
// Não há n8n na integração contínua, então o que dá para garantir é o que mais
// quebra na importação: conexão apontando para um nó que não existe, nó que
// nunca executa, JSON inválido — e, o mais importante, segredo colado dentro do
// arquivo, que entraria no histórico do repositório para sempre.
//
//   node n8n/verificar.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const GATILHOS = ['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger'];

// Marcas de segredo de verdade. As variáveis ($env.ALGUMA_COISA) são o jeito
// certo e não casam com nenhuma delas.
const SEGREDOS = [
  { marca: /sk-ant-[A-Za-z0-9_-]{10,}/, nome: 'chave da API do Claude' },
  { marca: /\b(pk|sk)-lf-[A-Za-z0-9_-]{10,}/, nome: 'chave do Langfuse' },
  { marca: /"(x-api-key|X-Api-Key)"\s*:\s*"[A-Za-z0-9+/=_-]{16,}"/, nome: 'chave de webhook colada' },
];

const falhas = [];
const arquivos = fs.readdirSync(PASTA).filter((n) => n.endsWith('.json')).sort();

if (!arquivos.length) falhas.push('nenhum fluxo encontrado');

for (const arquivo of arquivos) {
  const texto = fs.readFileSync(path.join(PASTA, arquivo), 'utf8');
  let fluxo;
  try {
    fluxo = JSON.parse(texto);
  } catch (erro) {
    falhas.push(`${arquivo}: JSON inválido — ${erro.message}`);
    continue;
  }

  const nos = fluxo.nodes || [];
  const nomes = new Set(nos.map((n) => n.name));
  if (nomes.size !== nos.length) falhas.push(`${arquivo}: há nós com nome repetido`);
  if (!nos.length) falhas.push(`${arquivo}: sem nós`);

  for (const no of nos) {
    if (!no.type || no.typeVersion === undefined) falhas.push(`${arquivo}: nó "${no.name}" sem tipo ou versão`);
    // Nó de comunidade não existe no n8n Cloud e quebra a cada versão nova.
    if (no.type && !no.type.startsWith('n8n-nodes-base.')) {
      falhas.push(`${arquivo}: nó "${no.name}" não é nativo (${no.type})`);
    }
  }

  const conexoes = fluxo.connections || {};
  for (const [origem, ligacoes] of Object.entries(conexoes)) {
    if (!nomes.has(origem)) falhas.push(`${arquivo}: conexão partindo de "${origem}", que não existe`);
    for (const saida of ligacoes.main || []) {
      for (const destino of saida) {
        if (!nomes.has(destino.node)) falhas.push(`${arquivo}: conexão para "${destino.node}", que não existe`);
      }
    }
  }

  // Todo nó precisa ser alcançável a partir de um gatilho: nó solto no canvas
  // parece configurado e nunca roda.
  const alcancados = new Set();
  const fila = nos.filter((n) => GATILHOS.includes(n.type)).map((n) => n.name);
  if (!fila.length) falhas.push(`${arquivo}: nenhum gatilho (webhook ou agenda)`);
  while (fila.length) {
    const atual = fila.pop();
    if (alcancados.has(atual)) continue;
    alcancados.add(atual);
    for (const saida of (conexoes[atual] || {}).main || []) {
      for (const destino of saida) fila.push(destino.node);
    }
  }
  const orfaos = [...nomes].filter((n) => !alcancados.has(n));
  if (orfaos.length) falhas.push(`${arquivo}: nó(s) que nunca executam: ${orfaos.join(', ')}`);

  for (const { marca, nome } of SEGREDOS) {
    if (marca.test(texto)) falhas.push(`${arquivo}: parece conter ${nome} — use $env.NOME_DA_VARIAVEL`);
  }

  console.log(`  ${arquivo}: ${nos.length} nós, ${Object.keys(conexoes).length} ligados`);
}

if (falhas.length) {
  console.error('');
  for (const f of falhas) console.error(`  ERRO ${f}`);
  process.exit(1);
}
console.log('\n  ok: fluxos íntegros, só nós nativos, nenhum segredo embutido');
