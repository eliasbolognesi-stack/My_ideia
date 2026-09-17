# Fluxos do n8n

Três fluxos prontos para importar. Todos usam **apenas nós nativos** do n8n (Webhook, HTTP
Request, Code, IF, Schedule) — nada de nó de comunidade, que não existe no n8n Cloud e quebra a
cada versão nova dos nós de IA.

| Arquivo | O que faz |
|---|---|
| [`01-registrar-evento.json`](01-registrar-evento.json) | Recebe uma mensagem em texto, pede ao Claude que extraia o evento e registra no SGA-TI. Se faltar dado, devolve a pergunta em vez de inventar. |
| [`02-monitor-saude.json`](02-monitor-saude.json) | A cada 5 minutos pergunta se o SGA-TI está no ar; avisa quando não está. |
| [`03-resumo-semanal.json`](03-resumo-semanal.json) | Toda segunda às 8h, monta o resumo da semana. |

---

## Como colocar no seu n8n

Você já tem um workflow aberto em `http://localhost:5678`. O caminho mais curto é **copiar e
colar**:

1. Abra `01-registrar-evento.json` num editor e copie **todo** o conteúdo.
2. No canvas do n8n, clique numa área vazia e tecle **Ctrl+V** — o n8n cola o fluxo inteiro, com
   os nós já ligados.

Para os outros dois, ou se preferir um workflow novo: **Workflows → Import from File**.

---

## Antes de rodar: dois tropeços locais

**1. Se o seu n8n roda em Docker, `localhost` dentro dele é o próprio contêiner.** Não é a sua
máquina — e o fluxo não encontra o SGA-TI. Neste caso, troque nos nós de HTTP Request:

```
http://localhost:3000   →   http://host.docker.internal:3000
```

No Linux, o contêiner ainda precisa subir com `--add-host=host.docker.internal:host-gateway`.
É o erro nº 1 de quem liga n8n a um serviço rodando na própria máquina.

**2. O Langfuse ocupa a porta 3000 por padrão — a mesma do SGA-TI.** Suba o Langfuse em 3001 (ou
mova o SGA-TI), senão o segundo a subir falha com uma mensagem que não deixa claro o motivo. Ver
[`../sga-ti/deploy/langfuse.md`](../sga-ti/deploy/langfuse.md).

---

## Variáveis de ambiente do n8n

Os fluxos leem os segredos do ambiente do n8n — **nenhum deles está dentro dos arquivos**, que
podem ser versionados e compartilhados à vontade.

| Variável | Para que serve | Onde conseguir |
|---|---|---|
| `ANTHROPIC_API_KEY` | Chamar o Claude | console.anthropic.com |
| `SGA_TI_WEBHOOK_KEY` | Registrar no SGA-TI | `SGA_TI_WEBHOOK_KEYS` do servidor — a chave define **quem** é o autor do evento |
| `LANGFUSE_CHAVE_PUBLICA` | Enviar o rastro | Langfuse → Settings → API Keys |
| `LANGFUSE_CHAVE_SECRETA` | idem | idem |
| `SGA_TI_EMAIL_RELATORIO` | Entrar para o resumo semanal | um usuário criado só para isso |
| `SGA_TI_SENHA_RELATORIO` | idem | idem |

Rodando o n8n direto no terminal, basta exportá-las antes de subir. Em Docker, use `-e` ou o
`environment:` do compose.

> A chave do webhook **é a identidade**: no SGA-TI, quem registra é a pessoa dona daquela chave,
> e o corpo da mensagem não pode declarar outro autor. Crie uma chave por integração
> (`openssl rand -hex 32`) e nunca a compartilhe entre fluxos.

Para o resumo semanal, crie um usuário próprio no SGA-TI (papel **aprovador**, que enxerga a
trilha completa) em vez de usar a conta de uma pessoa. Ele nasce com senha provisória: entre uma
vez pela tela para trocá-la, senão o login pelo fluxo é recusado com 428.

---

## Fluxo 1 — registrar evento a partir de uma mensagem

```
Mensagem recebida (webhook)
   → Abrir rastro            gera o traceparent que costura tudo
   → Claude                  extrai o evento, ou diz o que falta
   → Ler a decisão da IA
   → Deu para registrar? ──sim→ SGA-TI /api/webhook/n8n
                         └─não→ (segue com a pergunta)
   → Montar resposta e rastro
   → Langfuse
   → Responder
```

**Testando:**

```bash
curl -s -X POST http://localhost:5678/webhook-test/sga-ti-registrar \
  -H 'Content-Type: application/json' \
  -d '{"de":"joao@empresa.com","mensagem":"Chegou um notebook Dell Latitude 5440, patrimônio 4521, número de série ABC123XY, comprado da Dell Brasil. Quem recebeu fui eu, João Silva."}'
```

Resposta esperada: `{"resposta":"Registrado: evento nº 1, ativo nº 1 (Em estoque).","aceito":true}`

Agora mande uma mensagem incompleta e veja a diferença:

```bash
curl -s -X POST http://localhost:5678/webhook-test/sga-ti-registrar \
  -H 'Content-Type: application/json' \
  -d '{"mensagem":"chegou um notebook novo"}'
```

Ele **não inventa** patrimônio nem número de série: devolve a pergunta do que falta. Essa é a
regra mais importante do prompt, e é por isso que existem duas ferramentas em vez de uma.

### Decisões deste fluxo

- **Modelo `claude-opus-5`**, com o prompt do sistema marcado para cache
  (`cache_control: ephemeral`). O prompt é grande e constante: com o cache, a maior parte dele
  deixa de ser cobrada a cada mensagem.
- **Duas ferramentas, e o modelo é obrigado a usar uma delas** (`tool_choice: any`):
  `registrar_evento` quando está tudo lá, `pedir_informacao` quando falta. Não existe caminho em
  que ele responde texto solto e alguém precisa adivinhar o que fazer com aquilo.
- **A validação de verdade é a do SGA-TI.** O fluxo não repete as regras: manda o que entendeu, e
  o servidor recusa com 422 listando o que falta. Régua repetida em dois lugares vira duas réguas
  diferentes na primeira mudança.
- **A mensagem original não vai para o Langfuse**, porque costuma conter nome de pessoa. Vai o
  tamanho dela, que ajuda a investigar sem identificar ninguém. Se o seu Langfuse for próprio e
  você quiser o conteúdo, o nó `Montar resposta e rastro` diz em qual linha mexer.
- **Falha no Langfuse não derruba o fluxo**: aquele nó está marcado para continuar mesmo com erro.

### Para usar o prompt completo

O prompt embutido é a versão operacional — o suficiente para extrair o evento. A versão integral,
com as 15 seções, está em [`../sga-ti-prompt-de-sistema.md`](../sga-ti-prompt-de-sistema.md).
Para usá-la, crie uma variável do n8n chamada `SGA_TI_PROMPT` com aquele conteúdo: o fluxo já a
prefere quando existe (`$vars.SGA_TI_PROMPT || <o texto embutido>`).

---

## Fluxo 2 — monitor de saúde

Consulta `GET /api/saude` a cada 5 minutos. Trata três situações diferentes:

| Resposta | Situação |
|---|---|
| `ok: true` | no ar |
| `503` | janela de manutenção — aparece de propósito, senão ninguém nota que ficou ligada |
| sem resposta | fora do ar |

O último nó (`Avisar o time`) é um espaço reservado: **ligue nele o seu canal** — Slack, e-mail,
Telegram. O texto pronto chega em `$json.texto`.

Se você já tem um monitor de uptime (UptimeRobot, Better Stack), ele resolve o mesmo problema com
menos peças; este fluxo é para quem prefere manter tudo no n8n.

---

## Fluxo 3 — resumo semanal

Segunda às 8h: entra no SGA-TI, lê o painel e a semana de auditoria, e monta um texto curto com o
parque por situação, o movimento dos últimos 7 dias e as aprovações pendentes. Como no fluxo 2, o
último nó é onde você liga o seu canal.

---

## Se o n8n reclamar na importação

Os fluxos foram escritos com os nós mais estáveis que existem, mas a versão dos nós muda entre
lançamentos do n8n. Se aparecer erro ao importar ou um nó vier marcado como desconhecido:

1. Veja qual nó é, e qual `typeVersion` ele traz no JSON.
2. Crie o mesmo nó à mão pelo próprio n8n (ele usa a versão que a sua instalação tem) e copie os
   parâmetros do arquivo.
3. O mais provável de precisar disso é o **IF**, cuja estrutura de condições mudou entre versões.
   Nos dois lugares em que ele aparece, a condição é simples: comparar um texto com outro.
