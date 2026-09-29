# SGA-TI — Como funciona e plano de ação

**Sistema de Gestão de Ativos e Estoque de TI · versão 1.5.1 · setembro de 2026**

Documento para quem precisa entender o sistema sem ler código: o que ele resolve, como funciona
hoje, como vai se ligar ao portal da TI e o que falta fazer.

---

# Parte 1 — O que é e que problema resolve

## O problema

Equipamento de TI se perde no caminho. Um notebook entra pela nota fiscal, passa por formatação,
vai para um colaborador, volta, é consertado, vai para outro, e um dia alguém pergunta *"cadê o
4521?"* — e a resposta está espalhada entre uma planilha desatualizada, um grupo de WhatsApp e a
memória de quem estava lá.

Quando isso vira auditoria, inventário ou processo trabalhista, a pergunta muda de figura:
**quem entregou, para quem, quando, e como você prova?**

## A resposta

O SGA-TI registra o **ciclo de vida** de cada equipamento numa trilha que **não pode ser
alterada nem apagada**. Não é uma planilha com controle de acesso: é um livro em que só se
escreve, e cada linha carrega a assinatura da anterior.

Se alguém alterar um registro por fora — direto no banco de dados — **o sistema detecta**.

---

# Parte 2 — Como funciona hoje

## O ciclo de vida

Cada equipamento tem uma situação, e só muda de situação por um evento registrado:

```
Recebimento → Em estoque → Formatação → Movimentação → Em uso
                                ↑            ↓
                          Manutenção ←───────┘
                                ↓
                 Reservado para descarte → Descartado
```

Seis tipos de evento: **Recebimento, Formatação, Movimentação, Manutenção, Descarte e
Retificação**.

## A trilha imutável, em duas camadas

**Primeira camada — o banco recusa.** Há uma trava no próprio banco de dados que aborta qualquer
tentativa de alterar ou apagar um evento. Não é uma regra do programa que se possa contornar
chamando outra função: é o banco dizendo não.

**Segunda camada — a cadeia de assinaturas.** Cada evento guarda uma assinatura digital do seu
conteúdo **mais a assinatura do evento anterior**. Mudar um evento antigo quebraria todas as
assinaturas seguintes.

Na tela de cada equipamento há o botão **Verificar integridade da trilha**, que recalcula a cadeia
inteira e responde, por exemplo: *"Cadeia íntegra: 3 eventos verificados, nenhum sinal de
alteração."*

> **Corrigir não é apagar.** Registrou errado? Cria-se uma **Retificação**, que aponta para o
> evento original. Os dois ficam visíveis — é assim que a correção fica auditável.

## As regras que o sistema não deixa passar

| Regra | Por que existe |
|---|---|
| Patrimônio e número de série são **únicos entre equipamentos vivos** | Dois equipamentos com o mesmo patrimônio tornam o inventário ficção. Após a baixa, o número pode ser reusado |
| Descarte exige **redigitar** patrimônio e S/N, e os dois têm de bater | Evita dar baixa no equipamento errado — o erro mais caro e o mais difícil de desfazer |
| Descarte de equipamento **em uso** vai para aprovação humana | Ninguém dá baixa sozinho num equipamento que está com alguém |
| Movimentação exige **quem entrega e quem recebe** | Sem os dois lados, não há responsabilidade |
| Antes da baixa, **limpeza de dados confirmada** ou formalmente dispensada com justificativa | Dado da empresa não sai em disco de equipamento descartado |
| **Nenhum registro anônimo** | Trilha sem autor não prova nada |

## Quem pode o quê

| Papel | Pode |
|---|---|
| **Operador** | Registrar eventos; vê apenas o próprio histórico na auditoria |
| **Técnico** | O mesmo, voltado a formatação e manutenção |
| **Aprovador** | Tudo acima, mais **decidir descartes** e ver a trilha completa |
| **Administrador** | Tudo, mais gestão de pessoas |

A verificação é feita **no servidor**, não apenas na tela. Esconder um botão não é segurança.

## Contas e senhas

- Toda senha definida por outra pessoa nasce **provisória**: o sistema trava até a troca. Assim
  ninguém além da própria pessoa conhece a própria senha — sem isso, a trilha não prova quem
  registrou o quê.
- **Trocar a senha derruba as outras sessões** — é isso que resolve uma senha vazada.
- Desativar alguém corta o acesso **na hora**, inclusive nas sessões abertas, e **não apaga** o
  histórico da pessoa.

## LGPD

- Só os dados necessários: nome, e-mail e matrícula. **Não há campo para CPF.**
- Aviso de privacidade na tela de entrada, com o contato do encarregado (DPO).
- Rotina de **anonimização** após o prazo de retenção, que preserva a cadeia de assinaturas.
- A auditoria por colaborador atende ao direito de acesso do titular (art. 18), e cada
  **exportação fica registrada** — é por ela que dado pessoal sai do sistema.

## Como se registra hoje

1. **Pela tela** — formulário por tipo de evento, com os campos obrigatórios marcados.
2. **Por mensagem de texto** (WhatsApp/e-mail) — um fluxo no n8n lê a mensagem, a IA extrai os
   campos e o sistema valida. **Se faltar dado, a IA pergunta em vez de inventar.**
3. **Em breve: pelo portal da TI** — é a Parte 3 deste documento.

## Sob o capô, em uma linha

Node.js com o banco SQLite embutido. **Zero dependências externas**: não há `npm install`, nem
biblioteca de terceiros para ser invadida ou abandonada.

---

# Parte 3 — Como vai funcionar ligado ao portal da TI

## O objetivo

O chamado nasce **no portal que o time já usa** e vira evento no SGA-TI, sem ninguém digitar nada
duas vezes e **sem IA no meio** — ligação direta entre os dois sistemas.

## Quem é dono do quê

| | Portal da TI | SGA-TI |
|---|---|---|
| **Quem é o equipamento** (patrimônio, S/N, modelo) | **fonte da verdade** | espelho, atualizado a cada evento |
| **O que aconteceu** | o chamado | **trilha imutável** |
| **As regras** (conferência, aprovação, LGPD) | — | **aqui** |

Essa divisão é o que torna a integração sustentável: cada sistema faz o que já faz bem.

## O caminho de um chamado

```
Técnico fecha o chamado no portal da TI
   │  o portal avisa o SGA-TI na hora (webhook assinado)
   ▼
SGA-TI confere a assinatura e recusa envio repetido
   │
   ├─ pergunta ao portal: qual equipamento está neste chamado?
   ├─ pergunta ao portal: quem é o técnico responsável?
   │
   ▼
Passa pelas MESMAS regras da tela → evento na trilha imutável
```

## Os quatro fluxos

| No portal | No SGA-TI |
|---|---|
| Entrega de equipamento | Movimentação para o colaborador |
| Devolução ao estoque | Movimentação para o estoque |
| Defeito / manutenção | Evento de Manutenção, com o problema relatado |
| Baixa / descarte | **Pedido na fila de aprovação** — nunca baixa automática |

## Três decisões que vale entender

**1. O mapeamento fica no portal da TI, não numa configuração à parte.** Cada situação vira um
webhook próprio no portal, filtrado pela categoria do chamado, e o conteúdo enviado declara qual
evento é. Quem administra categorias já administra isso — a alternativa seria uma tabela de/para
no SGA-TI que ninguém lembraria de atualizar quando a categoria mudasse de nome.

**2. Quem é a pessoa, o SGA-TI pergunta ao portal.** O conteúdo recebido diz apenas **qual
chamado**. Quem é o técnico vem de uma consulta autenticada do SGA-TI ao portal. Se viesse no
corpo da mensagem, quem forjasse um envio escolheria em nome de quem registrar. E se esse técnico
não for usuário ativo do SGA-TI, o evento é **recusado** — registro anônimo continua proibido.

**3. Descarte não vira automático.** Chamado de baixa entra na fila de aprovação com o que veio
preenchido; um aprovador confere patrimônio e S/N e decide. A origem ser o portal não afasta a
regra.

## Segurança da ligação

O portal da TI assina cada envio, e o SGA-TI confere antes de aceitar:

- **Antes de entregar qualquer coisa**, o portal testa o endereço com um desafio criptográfico.
  Só entrega para quem responde certo.
- **Cada envio vem assinado** com um segredo compartilhado. Assinatura errada, segredo trocado ou
  envio repetido são recusados.
- O segredo fica no arquivo de configuração do servidor, legível só pelo serviço.

## Falha não pode ser silenciosa

Como a ligação é de mão única, o técnico **não fica sabendo** se o SGA-TI recusou o evento
(faltou campo, equipamento não encontrado, técnico não cadastrado). Sem tratamento, eventos
sumiriam sem ninguém notar — o pior defeito possível numa integração.

→ Por isso haverá uma tela **Integrações** no SGA-TI, listando cada recusa com o número do
chamado, o motivo e um caminho para completar à mão. Com contador no menu, como o das aprovações.

---

# Parte 4 — Plano de ação

## Fases

| Fase | O quê | Por que nesta ordem | Tamanho |
|---|---|---|---|
| **1** | Receber e conferir: responder ao desafio do portal, validar a assinatura, guardar o conteúdo original | Sem isto o portal **nem entrega** o primeiro evento | ~4 h |
| **2** | Ligação com o cadastro do portal: buscar equipamento e técnico; ajuste no banco para guardar o vínculo | O evento precisa saber de qual equipamento se trata | ~5 h |
| **3** | Os quatro fluxos, com o descarte indo para aprovação | O miolo da integração | ~6 h |
| **4** | Tela de pendências | Sem ela, recusa vira perda silenciosa | ~3 h |
| **5** | Documentação e ensaio ponta a ponta | Para você conseguir ligar sozinho | ~4 h |

**Total: cerca de dois dias** de trabalho, com testes e documentação.

## O que vai ser entregue

```
sga-ti/src/portal.js             cliente do portal + tradução chamado → evento
sga-ti/src/api.js                rotas do webhook (desafio e entrega)
sga-ti/server.js                 guardar o conteúdo original, para conferir a assinatura
sga-ti/migracoes/002-portal.sql  vínculo com o portal e controle de envio repetido
sga-ti/public/app.js             tela Integrações
sga-ti/deploy/portal.md          passo a passo de configuração no portal
```

## Como vai ser verificado

**O que eu consigo provar aqui:** vou construir um **portal de mentira** — um servidor que faz o
desafio, assina os envios exatamente como o código real do portal e responde como a API dele — e
rodar contra o SGA-TI de verdade. Cada item abaixo vira um teste automatizado:

- o desafio é respondido corretamente;
- assinatura válida entra; assinatura errada, segredo trocado e envio repetido são recusados;
- o mesmo envio chegando duas vezes registra **um** evento só;
- os quatro fluxos produzem o evento certo, e a baixa cai na fila de aprovação;
- técnico não cadastrado → evento recusado e visível na tela de pendências;
- equipamento que está no portal e não no SGA-TI é criado a partir dos dados do portal.

**O que eu não consigo verificar daqui, e não vou fingir que sim:** o portal real de vocês — as
categorias, o formato exato do conteúdo e se a API está habilitada. A primeira ligação de verdade
é sua; com o log do sistema e a tela de pendências, ajustamos em uma rodada.

## Riscos conhecidos

| Risco | Tamanho | O que fazer |
|---|---|---|
| O formato do conteúdo enviado pelo portal difere do previsto | Médio | A tela de pendências mostra o que chegou; ajuste de uma rodada |
| A API do portal está desabilitada na instalação de vocês | Médio | Conferir antes de começar (Configuração → Geral → API) |
| O banco usa uma função do Node ainda marcada como experimental | Baixo | Versão do Node fixada no servidor; documentado |
| O sistema só funciona na raiz de um domínio, não em subcaminho | Baixo | Usar um subdomínio (`sga-ti.empresa.com`) |

## O que depende de você

1. **Conferir se a API do portal está habilitada** e gerar as credenciais de um usuário de serviço
   (só leitura).
2. **Os nomes das categorias** de chamado (entrega, devolução, defeito, baixa) — para a
   documentação sair com os seus nomes em vez de exemplos.
3. **Decidir sobre a carga inicial** (abaixo).
4. Depois de pronto: **criar os webhooks no portal** seguindo o passo a passo, e fazer a primeira
   entrega de verdade.

## Uma decisão em aberto

Com o inventário no portal da TI, o cadastro do SGA-TI vira espelho. Vale uma **carga inicial**
dos equipamentos do portal, para a tela de ativos já nascer completa em vez de ir se preenchendo
conforme os chamados acontecem?

- **Com carga inicial:** +meio dia; inventário completo desde o primeiro dia.
- **Sem:** começa vazio e se preenche sozinho, ao longo de semanas.

Recomendo **com**, se o cadastro do portal estiver confiável.

---

# Parte 5 — O que já está pronto

| Versão | O que entrou |
|---|---|
| **1.0** | Ciclo de vida, trilha imutável com cadeia de assinaturas, regras não negociáveis, aprovação humana, papéis, anonimização LGPD |
| **1.1** | Interface com tema claro e escuro (escuro por padrão) |
| **1.2** | Auditoria de segurança: cabeçalhos estritos, registro de segurança, limite de tentativas, cópia de segurança, contenção da IA contra texto malicioso |
| **1.2.1** | Dez defeitos de usabilidade: voltar do navegador, links compartilháveis, rascunho preservado na expiração da sessão, contraste |
| **1.3** | Prontidão para produção: reinício automático, rota de saúde, rotação de registro, recusa de subir com configuração perigosa |
| **1.4** | Contas (trocar senha, desativar, encerrar sessões), migrações de banco, fim do corte silencioso das listas, exportação CSV |
| **1.5** | Observabilidade opcional (Langfuse) e fluxos do n8n |
| **1.5.1** | Conferidor de pré-voo para o servidor |

**Estado atual:** 98 testes automatizados verdes, ensaio de deploy completo, interface conferida
em navegador real.

---

## Próximo passo

A integração com o portal da TI (Parte 3) **ainda não foi iniciada** — este documento é o plano
dela. Quando você disser para começar, eu sigo pela **fase 1**, que é o que destrava todo o
resto: sem responder ao desafio do portal, ele nem entrega o primeiro evento.

Enquanto isso, os dois itens da lista *"O que depende de você"* que podem andar em paralelo são a
conferência da API do portal e os nomes das categorias de chamado.

---

## Onde encontrar mais detalhe

| Assunto | Arquivo no repositório |
|---|---|
| Instalação e operação do servidor | `sga-ti/DEPLOY.md` |
| Histórico de versões, item a item | `sga-ti/CHANGELOG.md` |
| Visão geral e como rodar localmente | `sga-ti/README.md` |
| Fluxos do n8n e como importá-los | `n8n/README.md` |
| Regras de negócio na forma original | `sga-ti-prompt-de-sistema.md` |
