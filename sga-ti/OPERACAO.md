# SGA-TI — Operação e resposta a incidentes

Documento curto e prático. Quem estiver de plantão deve conseguir agir só com o que está aqui.

**Preencha antes de publicar:** responsável técnico, responsável pelos dados (DPO) e canal de
aviso da empresa. Sem esses nomes, este documento não funciona numa emergência.

| Papel | Quem | Contato |
|---|---|---|
| Responsável técnico | *(preencher)* | |
| Responsável pelos dados (DPO) | *(preencher)* | |
| Canal de aviso do time | *(preencher)* | |

---

## 1. Desligar em emergência

Do menos drástico ao mais drástico — prefira sempre o primeiro que resolve:

| Situação | Ação | Efeito |
|---|---|---|
| Entrada automática do n8n se comportando mal | Remova `SGA_TI_WEBHOOK_KEYS` e reinicie | Só o webhook para; as pessoas continuam usando o site |
| Precisa parar tudo sem perder nada | `SGA_TI_MANUTENCAO=1` e reinicie | Tudo responde 503 com página de manutenção; o banco fica intacto |
| Comprometimento confirmado | Pare o processo (`SIGTERM`/`Ctrl+C`) | O servidor fecha as conexões e encerra o banco com segurança |
| Suspeita de sessões roubadas | Apague as sessões (abaixo) | Todos são deslogados; ninguém perde dado |

Encerrar todas as sessões ativas:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(process.env.SGA_TI_DB||'data/sga-ti.db');
console.log('sessões encerradas:', d.prepare('DELETE FROM sessoes').run().changes);"
```

**Bloquear uma pessoa** não precisa mais de comando: na aba **Usuários**, botão **Desativar** na
linha dela. O acesso cai na hora, inclusive nas sessões já abertas, e o histórico continua
intacto na trilha — desativar não apaga nada.

Na mesma linha há **Encerrar sessões** (derruba os acessos sem mexer na senha, para suspeita de
sessão roubada) e **Redefinir senha** (define uma senha provisória que a pessoa é obrigada a
trocar no próximo acesso).

O comando acima, que apaga **todas** as sessões de uma vez, continua sendo a opção mais drástica —
use quando não souber qual conta foi comprometida.

---

## 2. Cópia de segurança e restauração

**Gerar** (agende uma vez por dia e guarde uma cópia **fora deste servidor**):

```bash
npm run backup                         # grava em data/backups/
npm run backup -- /mnt/backup          # grava onde você indicar
```

O script usa `VACUUM INTO`, que gera cópia consistente com o sistema no ar, e confere a cópia
logo depois. Copiar o arquivo `.db` manualmente enquanto o servidor grava pode gerar cópia
corrompida — não faça isso.

**Restaurar:**

1. Pare o servidor.
2. Guarde o banco atual em vez de sobrescrevê-lo: `mv data/sga-ti.db data/sga-ti.db.suspeito`.
3. Copie a cópia escolhida para `data/sga-ti.db`.
4. Suba o servidor e confira a integridade da trilha de um ativo conhecido pela tela do ativo
   (botão **Verificar integridade da trilha**).

**Teste a restauração a cada trimestre.** Cópia que nunca foi restaurada não conta como cópia.

---

## 3. Registro de segurança

Arquivo separado do banco, em `data/seguranca.log` por padrão (`SGA_TI_LOG_SEGURANCA`), uma linha
JSON por evento. Encaminhe para fora do servidor — registro que mora junto com o sistema
comprometido não serve como prova.

Tipos registrados: `login_falho`, `acesso_sem_credencial`, `acesso_negado`, `limite_excedido`,
`webhook_chave_invalida`, `webhook_autor_desconhecido`, `webhook_autor_divergente`,
`texto_com_caracteres_ocultos`, `caminho_suspeito`, `decisao_descarte`, `usuario_criado`,
`anonimizacao_lgpd`.

Consultas rápidas:

```bash
# tentativas de login falhas por endereço, mais frequentes primeiro
grep login_falho data/seguranca.log | sed 's/.*"ip":"\([^"]*\)".*/\1/' | sort | uniq -c | sort -rn

# tudo que aconteceu nas últimas 24h
grep "$(date -u -d '1 day ago' +%Y-%m-%d)" data/seguranca.log
```

**Alerta mínimo sugerido** (enquanto não houver ferramenta de monitoramento): um cron de hora em
hora que conta as linhas de `login_falho`, `webhook_chave_invalida` e `webhook_autor_divergente`
da última hora e envia e-mail se passar de 20. Qualquer ocorrência de `webhook_autor_divergente`
merece aviso imediato — significa que alguém tentou registrar evento em nome de outra pessoa.

---

## 4. O que fazer quando algo acontece

### Suspeita de acesso indevido (senha vazada, sessão roubada)

1. Na aba **Usuários**, use **Redefinir senha** na linha da pessoa: isso derruba todas as sessões
   dela e obriga a troca no próximo acesso. Combine a senha provisória por um canal seguro —
   nunca por e-mail comum. Se não souber qual conta foi atingida, encerre **todas** as sessões
   (seção 1).
2. No registro de segurança, levante o que aquele endereço/usuário fez.
3. Na aba **Auditoria**, liste os eventos criados por aquele usuário no período.
4. **Não apague nada.** Se houver registro falso, crie uma **Retificação** apontando o evento
   original — é assim que a correção fica auditável.
5. Avise o responsável técnico e, se houver dado pessoal envolvido, o DPO.

### Chave do webhook vazada

1. Remova a chave comprometida de `SGA_TI_WEBHOOK_KEYS` e reinicie.
2. Gere uma nova (`openssl rand -hex 32`) e atualize no n8n.
3. Levante os eventos criados por aquela origem desde a data suspeita e retifique os falsos.

### Agente de IA manipulado (registro falso vindo de e-mail/WhatsApp)

1. Desligue a entrada automática (seção 1).
2. Retifique os eventos falsos; não os apague.
3. Guarde a mensagem original que causou o problema — ela é a prova e serve para ajustar o prompt.
4. Reforce a seção 14 do prompt do agente com o caso concreto antes de religar a entrada.

### Banco corrompido ou apagado

1. Pare o servidor e **não** tente reparar o arquivo original: guarde-o como está.
2. Restaure a cópia mais recente (seção 2).
3. Levante o que foi registrado entre a cópia e o incidente — esses eventos precisam ser
   redigitados manualmente.

### Vazamento de dados pessoais

Acione o DPO **no mesmo dia**. A LGPD exige comunicação à ANPD e aos titulares em prazo razoável
quando há risco relevante. Reúna: o que vazou, quantas pessoas, quando começou, como foi contido.

---

## 5. Rotina periódica

| Quando | O quê |
|---|---|
| Diário | Conferir que a cópia do dia foi gerada |
| Semanal | Ler o registro de segurança procurando padrão anormal |
| Mensal | Revisar a lista de usuários e desativar quem saiu da empresa |
| Trimestral | Testar a restauração da cópia; conferir a integridade da trilha de alguns ativos |
| Anual | Rodar `POST /api/lgpd/anonimizar`; revisar o prazo de retenção com o DPO |
