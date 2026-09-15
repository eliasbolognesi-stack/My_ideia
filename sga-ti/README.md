# SGA-TI — Sistema de Gestão de Ativos e Estoque de TI

Implementação completa (backend + frontend + testes) do assistente descrito em
[`../sga-ti-prompt-de-sistema.md`](../sga-ti-prompt-de-sistema.md): registro do ciclo de vida de
equipamentos de TI com **trilha de auditoria imutável**, validações não negociáveis e um
**webhook compatível com o JSON da seção 10 do prompt**, pronto para receber a saída do
assistente rodando no n8n.

**Zero dependências externas**: só precisa de Node.js ≥ 22.5 (usa o SQLite embutido do Node).
Não há `npm install`.

## Como rodar

```bash
cd sga-ti
npm start          # sobe em http://localhost:3000
npm test           # roda a suíte de testes (node:test)
```

No primeiro boot é criado o usuário `admin@local` e a senha é impressa **uma única vez** no
console (ou use `SGA_TI_ADMIN_SENHA` para defini-la). Troque-a e cadastre os demais usuários na
aba **Usuários**.

### Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `SGA_TI_DB` | `data/sga-ti.db` | Caminho do banco SQLite |
| `SGA_TI_ADMIN_SENHA` | *(gerada)* | Senha do admin no primeiro boot |
| `SGA_TI_WEBHOOK_KEY` | *(vazia)* | Chave do webhook n8n — **vazio = webhook desabilitado** |
| `SGA_TI_PRAZO_RETENCAO_ANOS` | `5` | Prazo de retenção antes da anonimização LGPD |
| `SGA_TI_EMPRESA` | `Empresa` | Nome exibido |
| `SGA_TI_SESSAO_HORAS` | `12` | Validade da sessão de login |

## O que o sistema garante (mapeado ao prompt)

| Regra do prompt | Implementação |
|---|---|
| Unicidade de patrimônio/S/N entre ativos vivos (§6) | Índices únicos parciais no SQLite (`WHERE status_atual != 'Descartado'`) + checagem no serviço; reuso permitido só após baixa |
| Descarte exige patrimônio e S/N **conferidos** (§6, §13) | O operador redigita os dois valores (`patrimonio_confirmado`/`numero_serie_confirmado`) e eles precisam bater com o cadastro |
| Movimentação exige quem entrega **e** quem recebe (§6) | Validação obrigatória dos dois lados |
| Nenhum registro é apagado/sobrescrito (§6, §7) | Triggers no banco abortam `UPDATE`/`DELETE` em `eventos`; correções são eventos `Retificacao` referenciando o original |
| Cadeia de hash por ativo (§7) | Cada evento carrega `hash_anterior` + `hash` SHA-256 do conteúdo canônico; endpoint de verificação recomputa a cadeia inteira |
| Descarte de ativo `Em uso` vai para aprovação humana (§13) | Fila de aprovações; só papéis `aprovador`/`admin` decidem |
| Limpeza segura de dados antes da baixa (§6, §8) | `limpeza_dados: confirmada` com evidência, ou `dispensada` com justificativa formal |
| Sem registros anônimos (§8) | Toda rota exige sessão autenticada; o webhook exige `X-Api-Key` **e** um `responsavel_acao` que corresponda a usuário cadastrado |
| Minimização de dados (§8) | Só nome/e-mail/matrícula; nenhum campo para CPF ou dado sensível |
| Retenção e anonimização (§8) | `POST /api/lgpd/anonimizar` (admin) anonimiza dados pessoais de ativos baixados há mais de N anos, preservando o histórico patrimonial e registrando a própria anonimização na trilha |
| Direitos do titular (§8) | Aba **Auditoria** filtra o histórico por nome do colaborador |
| `Descartado` é status final (§4) | Só `Retificacao` é aceita depois da baixa |

### Ciclo de vida e efeito dos eventos

- **Recebimento** cria o ativo em `Em estoque`.
- **Formatação** (ação concluída) devolve ao `Em estoque`; motivo `pré-descarte` leva a
  `Reservado para descarte`. Sempre exige confirmação de backup/limpeza.
- **Movimentação** por tipo de destino: `colaborador` → `Em uso` (com responsável);
  `estoque` → `Em estoque`; `assistencia` → `Em manutenção`;
  `fornecedor` (logística reversa) → `Reservado para descarte` — a baixa definitiva continua
  exigindo um evento de Descarte.
- **Manutenção** registra a intervenção concluída sem alterar status nem responsável.
- **Descarte** → `Descartado` (final).

## API

Autenticação: `POST /api/auth/login` → `{ token }`; demais rotas usam `Authorization: Bearer <token>`.

| Método e rota | Descrição |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/me` | Sessão |
| `GET /api/dashboard` | Contagens por status, pendências, últimos eventos |
| `GET /api/ativos?status=&q=` | Lista/busca de ativos |
| `GET /api/ativos/:id` | Ativo + histórico completo |
| `GET /api/ativos/:id/integridade` | Recomputa a cadeia de hashes |
| `POST /api/eventos` | `{ tipo, dados }` — registra qualquer evento |
| `GET /api/aprovacoes?status=pendente` | Fila de aprovação de descartes |
| `POST /api/aprovacoes/:id/decisao` | `{ decisao: aprovado\|rejeitado, justificativa }` (aprovador/admin) |
| `GET /api/auditoria/eventos?colaborador=&tipo=&ativo_id=` | Trilha filtrável (LGPD art. 18) |
| `GET/POST /api/usuarios` | Gestão de usuários (admin) |
| `POST /api/lgpd/anonimizar` | Rotina de anonimização pós-retenção (admin) |
| `POST /api/webhook/n8n` | Entrada do JSON da seção 10 do prompt (header `X-Api-Key`) |

### Webhook do n8n

No fluxo do n8n, ligue a saída JSON do node de IA (com o prompt SGA-TI) a um node **HTTP Request**:

```
POST http://<servidor>:3000/api/webhook/n8n
Headers: X-Api-Key: <SGA_TI_WEBHOOK_KEY>, Content-Type: application/json
Body: o JSON gerado pelo assistente (seção 10 do prompt)
```

Exemplo:

```bash
curl -s http://localhost:3000/api/webhook/n8n \
  -H 'X-Api-Key: minha-chave' -H 'Content-Type: application/json' \
  -d '{
    "evento": "Recebimento",
    "ativo": {"patrimonio": "4521", "numero_serie": "ABC123XY", "fabricante": "Dell",
              "modelo": "Latitude 5440", "tipo_equipamento": "Notebook"},
    "responsavel_acao": "admin@local",
    "responsavel_recebendo": "João Silva",
    "data_hora": "2026-09-14T10:00:00Z",
    "origem": "Dell Brasil"
  }'
```

Comportamento:

- `responsavel_acao` precisa corresponder ao e-mail ou nome de um usuário cadastrado — registros
  anônimos são recusados com `422`.
- Eventos incompletos retornam `422` com a lista exata dos campos que faltam (mesmas regras da
  UI), espelhando o comportamento do assistente de "não gerar o JSON enquanto faltar dado".
- `"Logistica Reversa"` e `"enviar para assistencia"` (presentes no enum da seção 10, mas sem
  regras próprias nas seções 2/5 do prompt) são tratados como **Movimentação** com destino
  `fornecedor` e `assistencia`, respectivamente.
- Campos extras no corpo (`motivo`, `confirmacao_backup`, `tecnico`, `problema_relatado`,
  `solucao_aplicada`, `limpeza_dados`, `aprovador`, `evento_ref`…) são repassados à validação —
  estenda o prompt do n8n para coletá-los nos eventos que os exigem.

## Decisões de projeto

- **Trilha imutável no banco, não só na aplicação**: triggers SQLite abortam qualquer
  `UPDATE`/`DELETE` em `eventos`. A única exceção permitida pelo trigger é o padrão estrito de
  anonimização (marca `anonimizado=1` sem tocar em hash, tipo, datas ou encadeamento).
- **Cadeia de hash**: `hash = SHA-256(serialização canônica do evento + hash do evento anterior
  do mesmo ativo)`. Adulteração direta no banco quebra a verificação. Eventos anonimizados têm o
  conteúdo alterado por definição, então para eles a verificação cobre apenas o elo da cadeia
  (o hash armazenado é preservado).
- **Anonimização ≠ apagamento**: a rotina LGPD substitui campos pessoais por `ANONIMIZADO`
  mantendo patrimônio, S/N, datas e transições de status — o histórico patrimonial agregado
  sobrevive, como pede a seção 8. Limitação conhecida: o `autor_id` continua apontando para a
  tabela `usuarios` (integridade referencial); uma anonimização completa exigiria também tratar
  contas desligadas nessa tabela.
- **Papéis**: `operador`, `tecnico`, `aprovador`, `admin`. Decisão de descarte pendente é
  restrita a `aprovador`/`admin`; gestão de usuários e rotina LGPD, a `admin`.
- **Senhas** com `scrypt` + sal; sessões com token aleatório de 256 bits e expiração;
  comparações sensíveis com `timingSafeEqual`; limite de tentativas de login por IP.

## Estrutura

```
sga-ti/
├── server.js               # HTTP + estáticos + tratamento de erros
├── src/
│   ├── config.js           # variáveis de ambiente
│   ├── db.js               # schema, índices parciais, triggers de imutabilidade
│   ├── hash.js             # serialização canônica + hash encadeado
│   ├── auth.js             # senhas, sessões, admin inicial
│   ├── regras.js           # validações e transições (seções 4/5/6 do prompt)
│   ├── servico-eventos.js  # registro de eventos, aprovações, integridade, LGPD
│   ├── n8n.js              # tradução do JSON da seção 10 → eventos internos
│   └── api.js              # rotas REST + papéis + webhook
├── public/                 # SPA (login, dashboard, ativos, eventos, aprovações, auditoria)
└── test/sga-ti.test.js     # 22 testes das regras não negociáveis
```

## Próximos passos sugeridos

- HTTPS/reverse proxy (nginx/Caddy) e backup automatizado do arquivo SQLite.
- Upload real de evidências de descarte (hoje registra referência: nº do termo/link).
- Exportação CSV da auditoria e relatório periódico por e-mail via n8n.
- SSO corporativo (OIDC) no lugar do login local, mantendo os papéis.
