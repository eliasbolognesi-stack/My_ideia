# SGA-TI — como publicar

Passo a passo para colocar o sistema no ar num servidor Linux e para atualizá-lo depois.
Escrito para quem não é especialista em infraestrutura: cada comando vem com o motivo dele.

Se algo der errado no meio, pule para [Plano de reversão](#plano-de-reversão) no fim.

- **Tempo do primeiro deploy:** cerca de 1 hora.
- **O que você precisa ter:** um servidor Linux (Ubuntu 22.04+ ou Debian 12+), acesso `sudo`,
  e um nome de domínio apontando para ele.

---

## 0. Antes de começar — decisões de 5 minutos

| Pergunta | Onde isso aparece |
|---|---|
| Qual domínio o sistema vai usar? | `Caddyfile` / `nginx.conf` |
| Quem é o responsável por acionar a reversão se der errado? | [Plano de reversão](#plano-de-reversão) |
| Quem é o contato de privacidade (DPO) da empresa? | `public/privacidade.html` e `SGA_TI_CONTATO_DPO` |
| De quais domínios virão os links de evidência de descarte? | `SGA_TI_DOMINIOS_EVIDENCIA` |
| Para onde vai a cópia de segurança **fora** deste servidor? | `deploy/sga-ti-backup.service` |

> **Limitação conhecida:** o sistema só funciona na **raiz de um domínio**
> (`sga-ti.empresa.com`), não em subcaminho (`empresa.com/sga-ti`), porque os caminhos no HTML
> são absolutos. Se precisar de subcaminho, use um subdomínio.

---

## 1. Instalar o Node.js na versão certa

O sistema usa o SQLite embutido do próprio Node, o que dá a vantagem de **zero dependências**
(não existe `npm install`, nem biblioteca de terceiros para ser invadida). O preço é que essa
API ainda é marcada como experimental pelo Node: **atualizar o Node sem testar pode quebrar o
sistema**. Por isso a versão é fixada.

Ubuntu 24.04 e Debian 12 entregam Node 18 nos repositórios padrão — **não serve**, o mínimo é
22.5. Instale pelo repositório oficial do Node:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version        # precisa começar com v22.
```

A versão exata usada e testada está em [`.nvmrc`](.nvmrc). Quem usa `nvm` roda só `nvm install`.

**Não deixe o Node atualizar sozinho.** Segure o pacote:

```bash
sudo apt-mark hold nodejs
```

Quando quiser subir de versão, faça isso em um servidor de teste, rode `npm test` e só então
solte o pacote (`sudo apt-mark unhold nodejs`).

---

## 2. Criar o usuário e as pastas

O sistema roda com um usuário próprio, **sem poder de administrador e sem shell**. Se alguém
achar uma falha na aplicação, o que ele consegue fazer no servidor fica limitado a isso.

```bash
sudo useradd --system --home /opt/sga-ti --shell /usr/sbin/nologin sga-ti

sudo mkdir -p /opt/sga-ti          # o código
sudo mkdir -p /var/lib/sga-ti      # banco, registro e cópias (a ÚNICA pasta gravável)
sudo mkdir -p /etc/sga-ti          # a configuração, com as chaves

sudo chown -R sga-ti:sga-ti /var/lib/sga-ti
sudo chmod 750 /var/lib/sga-ti
```

O código fica em uma pasta e os dados em outra de propósito: atualizar o sistema é trocar
`/opt/sga-ti` sem encostar em `/var/lib/sga-ti`.

---

## 3. Copiar o código

```bash
sudo git clone <url-do-repositorio> /tmp/sga-ti-fonte
sudo cp -r /tmp/sga-ti-fonte/sga-ti/. /opt/sga-ti/
sudo rm -rf /tmp/sga-ti-fonte

# O serviço só precisa LER o código. Escrever, só na pasta de dados.
sudo chown -R root:sga-ti /opt/sga-ti
sudo chmod -R 750 /opt/sga-ti
```

Confirme que veio tudo:

```bash
ls /opt/sga-ti        # deve mostrar server.js, src/, public/, scripts/, deploy/
```

---

## 4. Escrever a configuração

Comece do modelo e edite:

```bash
sudo cp /opt/sga-ti/.env.example /etc/sga-ti/sga-ti.env
sudo nano /etc/sga-ti/sga-ti.env
```

O arquivo já traz as obrigatórias no topo, com explicação. O mínimo para produção:

```bash
NODE_ENV=production
SGA_TI_HOST=127.0.0.1
SGA_TI_FORCAR_HTTPS=1
SGA_TI_ATRAS_PROXY=1
SGA_TI_DB=/var/lib/sga-ti/sga-ti.db
SGA_TI_LOG_SEGURANCA=/var/lib/sga-ti/seguranca.log
SGA_TI_ADMIN_SENHA=<uma senha longa, só para o primeiro acesso — o sistema exige a troca>
SGA_TI_WEBHOOK_KEYS=<gerado no passo abaixo>
SGA_TI_CONTATO_DPO=privacidade@suaempresa.com
SGA_TI_DOMINIOS_EVIDENCIA=suaempresa.com,docs.suaempresa.com
SGA_TI_EMPRESA=Sua Empresa
```

### Gerar as chaves de webhook

Cada chave **pertence a uma pessoa**: quem registra pelo n8n fica identificado por ela, e o
corpo da mensagem não pode declarar outro autor. Uma chave por integração, nunca compartilhada.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Monte assim, separando pares por vírgula:

```bash
SGA_TI_WEBHOOK_KEYS=a1b2...:estoque@suaempresa.com,c3d4...:suporte@suaempresa.com
```

### Proteger o arquivo

Esse arquivo tem as chaves. Só o serviço pode lê-lo:

```bash
sudo chown root:sga-ti /etc/sga-ti/sga-ti.env
sudo chmod 640 /etc/sga-ti/sga-ti.env
```

> **Nunca coloque esse arquivo dentro do repositório.** O `.gitignore` já barra `.env`, mas o
> caminho seguro é o que está aqui: fora da pasta do código.

---

## 5. Ligar o serviço

```bash
sudo cp /opt/sga-ti/deploy/sga-ti.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sga-ti
sudo systemctl status sga-ti
```

Deve aparecer `active (running)`. Se aparecer `failed`, veja o motivo:

```bash
sudo journalctl -u sga-ti -n 50 --no-pager
```

**O sistema se recusa a subir com configuração perigosa** e diz exatamente o que corrigir. Se a
mensagem for `CONFIGURACAO RECUSADA`, leia os itens listados — cada um traz o que fazer. Isso é
proteção, não defeito: as combinações barradas (proxy ligado com escuta aberta para a internet,
ou senha trafegando sem HTTPS) deixariam o sistema exposto de um jeito silencioso.

Anote a senha do admin: no primeiro boot o `journalctl` a imprime **uma única vez**.

### Confirmar que ele volta sozinho

Este é o teste que evita a pior falha possível — o sistema sumir e ninguém perceber:

```bash
sudo systemctl kill -s SIGKILL sga-ti      # mata do jeito mais bruto
sleep 5
sudo systemctl status sga-ti               # precisa estar 'active (running)' de novo
```

---

## 6. Colocar o HTTPS na frente

O SGA-TI escuta só em `127.0.0.1`: quem fala com a internet é o proxy, que cuida do certificado.
Sem isso, senha e sessão trafegam abertas.

### Opção A — Caddy (recomendado)

Cuida do certificado sozinho e renova sem intervenção.

```bash
sudo apt-get install -y caddy
sudo cp /opt/sga-ti/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # troque sga-ti.suaempresa.com pelo seu domínio
sudo systemctl reload caddy
```

O domínio precisa já estar apontando para o servidor, senão a emissão do certificado falha.

### Opção B — nginx

```bash
sudo cp /opt/sga-ti/deploy/nginx.conf /etc/nginx/sites-available/sga-ti
sudo nano /etc/nginx/sites-available/sga-ti      # troque o domínio
sudo ln -s /etc/nginx/sites-available/sga-ti /etc/nginx/sites-enabled/
sudo certbot --nginx -d sga-ti.suaempresa.com
sudo nginx -t && sudo systemctl reload nginx
```

Confira que funcionou:

```bash
curl -I http://sga-ti.suaempresa.com          # deve responder 301 para https
curl -s https://sga-ti.suaempresa.com/api/saude
# {"ok":true,"versao":"1.4.0","banco":"ok","manutencao":false,...}
```

---

## 7. Agendar a cópia de segurança

O script existe desde o começo, mas cópia que ninguém dispara não é cópia.

```bash
sudo cp /opt/sga-ti/deploy/sga-ti-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sga-ti-backup.timer
systemctl list-timers sga-ti-backup           # confirma o próximo disparo
```

Teste **agora**, sem esperar as 2 da manhã:

```bash
sudo systemctl start sga-ti-backup.service
ls -lh /var/lib/sga-ti/backups/
```

> **Cópia no mesmo disco não protege contra a perda do disco.** Descomente a linha
> `ExecStartPost` em `sga-ti-backup.service` e ajuste para o seu destino externo (outro
> servidor, NAS, armazenamento em nuvem). Enquanto isso não for feito, você tem cópia contra
> engano humano, não contra perda de hardware.

E **teste a restauração** uma vez, antes de precisar (o passo a passo está em
[`OPERACAO.md`](OPERACAO.md), seção 2). Cópia nunca testada é esperança, não plano.

---

## 8. Monitorar

A rota `GET /api/saude` é pública, barata e não revela nada: responde 200 com a versão e se o
banco abre. Aponte o monitor de uptime (UptimeRobot, Better Stack, Zabbix, o que já usarem) para:

```
https://sga-ti.suaempresa.com/api/saude
```

Configure o alerta para: **resposta diferente de 200**, ou **`ok` diferente de `true`**.

Durante uma janela de manutenção (`SGA_TI_MANUTENCAO=1`) a rota responde 503 de propósito —
assim ninguém esquece a manutenção ligada.

Nos primeiros 15 minutos depois de publicar, acompanhe:

```bash
sudo journalctl -u sga-ti -f                              # o que o sistema está fazendo
sudo grep -c . /var/lib/sga-ti/seguranca.log              # eventos de segurança
```

---

## 9. Conferência final (faça pelo navegador)

- [ ] Entrar com `admin@local`. O sistema **obriga** a trocar a senha antes de liberar qualquer
      tela: a senha do primeiro boot aparece no `journalctl` e vale só para esse primeiro acesso.
- [ ] Cadastrar os usuários reais, cada um com o papel certo.
- [ ] Registrar uma **entrada** de teste e conferir que ela aparece na lista.
- [ ] Abrir o ativo de teste e conferir a **trilha de auditoria**.
- [ ] Tentar um **descarte** e conferir que ele exige a conferência de patrimônio e S/N.
- [ ] Trocar entre tema claro e escuro.
- [ ] Abrir `/privacidade.html` e conferir que o **contato do DPO** está preenchido.
- [ ] Preencher os responsáveis em [`OPERACAO.md`](OPERACAO.md).
- [ ] Disparar um evento pelo n8n com a chave de webhook e conferir o autor registrado.

---

## Atualizar para uma nova versão

O banco fica fora da pasta do código, então atualizar é trocar o código e reiniciar.

```bash
# 1. Cópia ANTES de qualquer coisa
sudo systemctl start sga-ti-backup.service

# 2. Guardar a versão atual, para poder voltar
sudo cp -a /opt/sga-ti /opt/sga-ti.anterior

# 3. Trazer o código novo
sudo git clone <url-do-repositorio> /tmp/sga-ti-novo
sudo rm -rf /opt/sga-ti && sudo mkdir -p /opt/sga-ti
sudo cp -r /tmp/sga-ti-novo/sga-ti/. /opt/sga-ti/
sudo chown -R root:sga-ti /opt/sga-ti && sudo chmod -R 750 /opt/sga-ti
sudo rm -rf /tmp/sga-ti-novo

# 4. Rodar os testes com o código novo, no servidor
sudo -u sga-ti env HOME=/tmp npm --prefix /opt/sga-ti test

# 5. Reiniciar e conferir
sudo systemctl restart sga-ti
curl -s https://sga-ti.suaempresa.com/api/saude
```

Leia o [`CHANGELOG.md`](CHANGELOG.md) da versão antes de atualizar: ele avisa quando alguma
variável de ambiente muda.

> **Sobre mudanças no banco:** as migrações rodam sozinhas na subida, em ordem e dentro de
> transação, e cada uma é aplicada **uma única vez** (o número aplicado fica no próprio arquivo do
> banco, em `PRAGMA user_version`). Se uma falhar, ela é desfeita e o servidor **não sobe** — o
> banco fica como estava. A linha `Banco: esquema N -> M` no log diz o que foi aplicado.
>
> Faça a cópia de segurança **antes** de atualizar, como no passo 1: migração desfeita devolve o
> esquema, mas voltar para uma versão anterior do código com o esquema já migrado não é previsto.

---

## Plano de reversão

**Quando reverter:** a rota de saúde não volta em 5 minutos, o login para de funcionar, ou
qualquer erro aparece no registro para mais de um usuário.

**Quem aciona:** _preencha aqui o nome e o telefone do responsável._

### Voltar o código (o caso comum)

```bash
sudo systemctl stop sga-ti
sudo rm -rf /opt/sga-ti
sudo mv /opt/sga-ti.anterior /opt/sga-ti
sudo systemctl start sga-ti
curl -s https://sga-ti.suaempresa.com/api/saude
```

Leva menos de um minuto e **não mexe nos dados**: nenhum registro é perdido.

### Voltar também o banco (só se o banco tiver sido corrompido)

O passo a passo está em [`OPERACAO.md`](OPERACAO.md), seção 2. Atenção: restaurar o banco
**desfaz os registros feitos desde a cópia**. Antes disso, considere ligar
`SGA_TI_MANUTENCAO=1` para estancar e avaliar com calma.

### Estancar sem reverter

Para parar o mundo e pensar, sem perder nada:

```bash
sudo systemctl stop sga-ti        # ou SGA_TI_MANUTENCAO=1 + restart, que mostra
                                  # uma página de manutenção em vez de erro de conexão
```

---

## Perguntas rápidas

**O serviço não sobe e o journal fala em `CONFIGURACAO RECUSADA`.**
É a checagem de boot. Leia os itens — cada um diz o que corrigir em `/etc/sga-ti/sga-ti.env`.

**O serviço sobe e cai em laço.**
Depois de 5 quedas em 60 segundos o systemd para e deixa em `failed`, de propósito, para o
monitoramento acusar. Veja `journalctl -u sga-ti -n 100` — normalmente é permissão na pasta
`/var/lib/sga-ti` ou caminho de banco errado.

**O registro de segurança está enchendo o disco.**
Não deveria: ele rotaciona sozinho ao passar de `SGA_TI_LOG_TAMANHO_MB` (5 MB por padrão),
guardando `SGA_TI_LOG_ARQUIVOS` (5) arquivos. Confira se o serviço tem permissão de escrita na
pasta — sem ela, a rotação não acontece e o aviso aparece no journal.

**Preciso mudar uma variável de ambiente.**
Edite `/etc/sga-ti/sga-ti.env` e rode `sudo systemctl restart sga-ti`. Não existe recarga a
quente: a configuração é lida uma vez, na subida.

**Onde ficam os dados?**
Tudo em `/var/lib/sga-ti`: `sga-ti.db` (banco), `seguranca.log` (registro) e `backups/`. Essa é
a única pasta que o serviço pode escrever — o systemd bloqueia o resto do disco.
