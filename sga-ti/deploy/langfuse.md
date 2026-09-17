# Acompanhar tudo pelo Langfuse

O Langfuse mostra, num painel, o caminho inteiro de cada registro:

```
mensagem no WhatsApp/e-mail  →  o que a IA entendeu  →  o que foi gravado aqui
```

Tudo isso num **rastro só**, em vez de três pedaços soltos que ninguém consegue ligar depois.
Serve para responder perguntas que hoje não têm resposta: *quantos pedidos a IA recusou por falta
de dado? quais campos faltam com mais frequência? quanto custou o mês? aquele registro estranho de
terça veio de onde?*

É **opcional e desligado por padrão**. Sem as variáveis abaixo, o SGA-TI não faz nenhuma chamada.

---

## Antes de mais nada: qual Langfuse

| | Langfuse próprio (auto-hospedado) | Langfuse em nuvem |
|---|---|---|
| Onde os dados ficam | No seu servidor | Fora da empresa |
| Dá para mandar conteúdo dos eventos | Sim | **Não** — ver abaixo |
| Trabalho para manter | Você sobe e atualiza | Nenhum |

O SGA-TI trata dado pessoal (nome, e-mail, matrícula de colaboradores). Mandá-lo para um serviço
em nuvem é **transferência de dado pessoal a terceiro**, com as obrigações que a LGPD impõe a
isso. Por essa razão:

- o padrão (`SGA_TI_OBS_CONTEUDO=metadados`) manda **apenas estrutura**: quais campos vieram,
  quantos, o resultado e a duração. Nunca o conteúdo. Isso é seguro em qualquer um dos dois;
- `completo` manda o conteúdo junto, e aí **só com Langfuse próprio**. O servidor avisa no boot se
  detectar essa combinação com endereço fora da rede local.

---

## 1. Subir o Langfuse

Use o `docker compose` **oficial do projeto** — ele monta as quatro peças que o Langfuse precisa
(banco, armazenamento de eventos, cache e arquivos), e é mantido por quem escreve o Langfuse:

```bash
git clone https://github.com/langfuse/langfuse
cd langfuse
docker compose up -d
```

> **Atenção à porta.** O Langfuse ocupa a **3000** por padrão — a mesma do SGA-TI. Um dos dois
> precisa mudar, senão o segundo a subir falha com uma mensagem que não deixa claro o motivo.
> O caminho mais simples é publicar o Langfuse em 3001, no `docker-compose.yml`:
>
> ```yaml
> services:
>   langfuse-web:
>     ports:
>       - "3001:3000"
> ```

Abra `http://localhost:3001`, crie a conta inicial, crie uma organização e um projeto.

## 2. Pegar as chaves

No projeto: **Settings → API Keys → Create new API keys**. Copie as duas:

- `pk-lf-...` — chave pública
- `sk-lf-...` — chave secreta

## 3. Ligar no SGA-TI

No arquivo de configuração (`/etc/sga-ti/sga-ti.env` em produção, `.env` no seu computador):

```bash
SGA_TI_LANGFUSE_URL=http://localhost:3001
SGA_TI_LANGFUSE_CHAVE_PUBLICA=pk-lf-...
SGA_TI_LANGFUSE_CHAVE_SECRETA=sk-lf-...
SGA_TI_OBS_CONTEUDO=metadados
```

Reinicie o serviço. Registre um equipamento e o rastro aparece no Langfuse em alguns segundos.

## 4. Ligar no n8n

Os fluxos em [`../../n8n/`](../../n8n/) já enviam o rastro da chamada à IA e **passam o
`traceparent` adiante** no cabeçalho da chamada ao SGA-TI. É esse cabeçalho que costura os dois
lados no mesmo rastro. O passo a passo está no `README.md` daquela pasta.

---

## Como isto foi construído (e por que importa)

**Não usamos a API de ingestão do Langfuse.** Ela é desligada em **16/11/2026** (só eventos de
`score` continuam). O envio usa o **endpoint OpenTelemetry** (`/api/public/otel/v1/traces`), que é
o caminho recomendado e um padrão aberto — se um dia vocês trocarem o Langfuse por outra
ferramenta, o mesmo envio serve, sem reescrever nada.

**Nenhuma dependência nova.** O endpoint aceita OTLP sobre HTTP com JSON, então o envio é feito
com o `fetch` embutido do Node. O "zero dependências" que blindou a auditoria de segurança
continua valendo: não há biblioteca de terceiros nova para ser invadida.

**O Langfuse nunca derruba o SGA-TI.** O envio é disparado e esquecido, com prazo de 3 segundos e
tratamento de erro em tudo. Com o Langfuse fora do ar, os registros continuam funcionando
normalmente e um único aviso aparece no log — não um por requisição. Isso é testado
automaticamente (`test/observabilidade.test.js`): observabilidade que derruba o sistema observado
é pior do que não ter observabilidade.

---

## O que conferir no primeiro rastro

- [ ] O rastro aparece com o nome `registrar_evento` (ou `webhook_n8n`, se veio do n8n).
- [ ] O `user.id` mostra quem registrou.
- [ ] Um pedido incompleto aparece com **erro** e o motivo em `sga_ti.detalhes` — é este número
      que diz se o prompt do agente está pedindo a informação certa.
- [ ] No modo `metadados`, **nenhum nome de pessoa** aparece na tela do Langfuse. Se aparecer,
      pare e confira a variável: é o sinal de que o modo está errado.

## Se não aparecer nada

1. `journalctl -u sga-ti | grep observabilidade` — o aviso diz o que o Langfuse respondeu.
2. Confira a porta (3000 × 3001) e se o endereço é alcançável **de dentro** do servidor do SGA-TI:
   `curl -I http://localhost:3001`.
3. Chave trocada (pública no lugar da secreta) responde 401.
