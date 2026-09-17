#!/usr/bin/env bash
# Conferidor de pré-voo do SGA-TI.
#
# Rode NO SERVIDOR, depois de instalar e antes de liberar o sistema para o
# time. Ele não muda nada: só olha e diz o que está errado, com o que fazer.
#
#   sudo bash /opt/sga-ti/scripts/pre-voo.sh
#
# Saída 0 = pronto para liberar. Saída 1 = há bloqueio.
#
# A ideia é simples: quase todo problema de estreia é uma configuração
# esquecida, e todas elas são verificáveis em segundos. Errar aqui custa um
# comando; errar depois custa a confiança do time no sistema.

set -uo pipefail

RAIZ="${SGA_TI_RAIZ:-/opt/sga-ti}"
DADOS="${SGA_TI_DADOS:-/var/lib/sga-ti}"
ENV_ARQ="${SGA_TI_ENV:-/etc/sga-ti/sga-ti.env}"
SERVICO="${SGA_TI_SERVICO:-sga-ti}"
URL_LOCAL="${SGA_TI_URL:-http://127.0.0.1:3000}"
URL_PUBLICA="${SGA_TI_URL_PUBLICA:-}"

bloqueios=0
alertas=0

secao() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
pare()  { printf '  \033[31m✗\033[0m %s\n     → %s\n' "$1" "$2"; bloqueios=$((bloqueios+1)); }
olhe()  { printf '  \033[33m!\033[0m %s\n     → %s\n' "$1" "$2"; alertas=$((alertas+1)); }
pulou() { printf '  \033[90m—\033[0m %s (%s)\n' "$1" "$2"; }

tem() { command -v "$1" >/dev/null 2>&1; }

# Lê uma variável do arquivo de configuração sem carregá-lo (não queremos
# executar nada que esteja lá dentro).
config() {
  [ -r "$ENV_ARQ" ] || return 1
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_ARQ" | tail -1 | sed 's/^"//; s/"$//'
}

printf '\033[1mSGA-TI — conferência de pré-voo\033[0m\n'
printf 'código: %s · dados: %s · configuração: %s\n' "$RAIZ" "$DADOS" "$ENV_ARQ"

# ---------------------------------------------------------------------------
secao '1. Node.js'
if tem node; then
  VERSAO_NODE=$(node --version)
  MAIOR=$(echo "$VERSAO_NODE" | sed 's/^v//' | cut -d. -f1)
  MENOR=$(echo "$VERSAO_NODE" | sed 's/^v//' | cut -d. -f2)
  if [ "$MAIOR" -gt 22 ] || { [ "$MAIOR" -eq 22 ] && [ "$MENOR" -ge 5 ]; }; then
    ok "versão $VERSAO_NODE (mínimo v22.5)"
  else
    pare "Node $VERSAO_NODE é antigo demais" \
         "o banco usa o SQLite embutido, que só existe a partir da v22.5. Ver DEPLOY.md, passo 1."
  fi
  if tem apt-mark && apt-mark showhold 2>/dev/null | grep -q '^nodejs$'; then
    ok "pacote nodejs segurado (não atualiza sozinho)"
  elif tem apt-mark; then
    olhe "o Node pode ser atualizado sozinho" \
         "a API SQLite ainda é experimental: 'sudo apt-mark hold nodejs' evita uma quebra silenciosa."
  fi
else
  pare "node não encontrado" "instale conforme o passo 1 do DEPLOY.md."
fi

# ---------------------------------------------------------------------------
secao '2. Código e dados'
if [ -f "$RAIZ/server.js" ]; then
  ok "código em $RAIZ"
  if [ -r "$RAIZ/package.json" ] && tem node; then
    ok "versão instalada: $(node -pe "require('$RAIZ/package.json').version" 2>/dev/null || echo '?')"
  fi
else
  pare "não achei $RAIZ/server.js" "confira o caminho ou use SGA_TI_RAIZ=/outro/caminho."
fi

if [ -d "$DADOS" ]; then
  ok "pasta de dados em $DADOS"
  PERM=$(stat -c '%a' "$DADOS" 2>/dev/null)
  case "$PERM" in
    750|700) ok "permissão $PERM (só o serviço lê)" ;;
    *) olhe "permissão $PERM em $DADOS" "o banco fica aqui: 'sudo chmod 750 $DADOS' fecha para os outros." ;;
  esac
else
  pare "pasta de dados $DADOS não existe" "'sudo mkdir -p $DADOS' e ajuste o dono (DEPLOY.md, passo 2)."
fi

# ---------------------------------------------------------------------------
secao '3. Configuração'
if [ -r "$ENV_ARQ" ]; then
  ok "arquivo de configuração encontrado"
  PERM=$(stat -c '%a' "$ENV_ARQ" 2>/dev/null)
  if [ "$PERM" = "640" ] || [ "$PERM" = "600" ]; then
    ok "permissão $PERM (as chaves não são legíveis por qualquer um)"
  else
    pare "permissão $PERM em $ENV_ARQ" \
         "este arquivo tem as chaves: 'sudo chmod 640 $ENV_ARQ' e 'sudo chown root:sga-ti $ENV_ARQ'."
  fi

  [ "$(config NODE_ENV)" = "production" ] \
    && ok "NODE_ENV=production (o boot recusa configuração perigosa)" \
    || pare "NODE_ENV não é production" \
            "sem isso, uma combinação perigosa vira aviso em vez de impedir a subida."

  HOST=$(config SGA_TI_HOST)
  case "${HOST:-127.0.0.1}" in
    127.0.0.1|localhost) ok "escuta em ${HOST:-127.0.0.1} (quem fala com a internet é o proxy)" ;;
    *) pare "escuta em $HOST" "exponha pelo proxy reverso e volte SGA_TI_HOST para 127.0.0.1." ;;
  esac

  [ -n "$(config SGA_TI_WEBHOOK_KEYS)" ] \
    && ok "chaves de webhook definidas (a chave determina o autor)" \
    || olhe "sem SGA_TI_WEBHOOK_KEYS" "a entrada automática do n8n fica desligada."
  [ -n "$(config SGA_TI_WEBHOOK_KEY)" ] \
    && pare "SGA_TI_WEBHOOK_KEY (modo legado) presente" \
            "qualquer um com a chave registra em nome de outra pessoa. Migre para SGA_TI_WEBHOOK_KEYS." \
    || true

  [ -n "$(config SGA_TI_CONTATO_DPO)" ] \
    && ok "contato do DPO preenchido" \
    || olhe "SGA_TI_CONTATO_DPO vazio" "a LGPD exige um canal para o titular dos dados."
  [ -n "$(config SGA_TI_DOMINIOS_EVIDENCIA)" ] \
    && ok "domínios de evidência restritos" \
    || olhe "SGA_TI_DOMINIOS_EVIDENCIA vazio" "a evidência de descarte aceitaria link de qualquer domínio."

  CONTEUDO=$(config SGA_TI_OBS_CONTEUDO)
  LANGFUSE=$(config SGA_TI_LANGFUSE_URL)
  if [ -n "$LANGFUSE" ]; then
    if [ "${CONTEUDO:-metadados}" = "completo" ]; then
      case "$LANGFUSE" in
        http://localhost*|http://127.*|http://10.*|http://192.168.*) ok "Langfuse próprio, com conteúdo completo" ;;
        *) pare "conteúdo completo indo para um Langfuse fora da rede local" \
                "isso envia DADO PESSOAL para fora da empresa. Use Langfuse próprio ou SGA_TI_OBS_CONTEUDO=metadados." ;;
      esac
    else
      ok "observabilidade ligada, enviando só metadados"
    fi
  else
    pulou "observabilidade (Langfuse)" "não configurada — opcional"
  fi
else
  pare "não consegui ler $ENV_ARQ" "crie a partir de .env.example (DEPLOY.md, passo 4)."
fi

# ---------------------------------------------------------------------------
secao '4. Segredo fora do repositório'
if [ -f "$RAIZ/.env" ]; then
  olhe "existe um .env dentro de $RAIZ" \
       "a configuração deve ficar em $ENV_ARQ, fora da pasta do código."
else
  ok "nenhum .env dentro da pasta do código"
fi

# ---------------------------------------------------------------------------
secao '5. Serviço'
if tem systemctl && [ -d /run/systemd/system ]; then
  if systemctl is-active --quiet "$SERVICO"; then
    ok "$SERVICO está ativo"
  else
    pare "$SERVICO não está ativo" "'sudo systemctl status $SERVICO' e 'sudo journalctl -u $SERVICO -n 50'."
  fi
  systemctl is-enabled --quiet "$SERVICO" \
    && ok "sobe sozinho quando o servidor reinicia" \
    || pare "$SERVICO não está habilitado" "'sudo systemctl enable $SERVICO', senão ele não volta após um reboot."

  REINICIO=$(systemctl show -p Restart --value "$SERVICO" 2>/dev/null)
  [ "$REINICIO" = "always" ] \
    && ok "Restart=always (volta sozinho se cair)" \
    || pare "Restart=$REINICIO" "sem 'always', uma queda derruba o sistema até alguém perceber."

  if systemctl is-enabled --quiet "${SERVICO}-backup.timer" 2>/dev/null; then
    ok "cópia de segurança agendada"
    PROXIMA=$(systemctl show -p NextElapseUSecRealtime --value "${SERVICO}-backup.timer" 2>/dev/null)
    [ -n "$PROXIMA" ] && printf '     próxima: %s\n' "$PROXIMA"
  else
    pare "timer de cópia de segurança não habilitado" \
         "'sudo systemctl enable --now ${SERVICO}-backup.timer'. Cópia que ninguém dispara não é cópia."
  fi
else
  pulou "serviço (systemd)" "systemd não disponível neste ambiente"
fi

# ---------------------------------------------------------------------------
secao '6. Respondendo'
if tem curl; then
  SAUDE=$(curl -s --max-time 5 "$URL_LOCAL/api/saude" 2>/dev/null)
  CODIGO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL_LOCAL/api/saude" 2>/dev/null)
  if [ "$CODIGO" = "200" ]; then
    ok "rota de saúde responde 200"
    echo "$SAUDE" | grep -q '"banco":"ok"' \
      && ok "banco abre normalmente" \
      || pare "o banco não abriu" "veja o journal: pode ser permissão em $DADOS."
    echo "$SAUDE" | grep -q '"manutencao":false' \
      || olhe "o sistema está em MODO MANUTENÇÃO" "ninguém consegue usar. Remova SGA_TI_MANUTENCAO e reinicie."
  elif [ "$CODIGO" = "503" ]; then
    olhe "responde 503" "modo manutenção ligado — remova SGA_TI_MANUTENCAO e reinicie."
  else
    pare "a rota de saúde não respondeu (código $CODIGO)" \
         "o serviço está no ar? A porta em SGA_TI_URL ($URL_LOCAL) está certa?"
  fi

  if [ -n "$URL_PUBLICA" ]; then
    CODIGO_HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${URL_PUBLICA#http*://}/" 2>/dev/null)
    case "$CODIGO_HTTP" in
      301|302|308) ok "http redireciona para https" ;;
      *) olhe "http respondeu $CODIGO_HTTP em vez de redirecionar" \
              "sem o redirecionamento, a primeira visita trafega aberta e a senha vai junto." ;;
    esac
    curl -s --max-time 8 -o /dev/null "https://${URL_PUBLICA#http*://}/api/saude" \
      && ok "https respondendo de fora" \
      || pare "https não respondeu" "confira o certificado e o proxy reverso (DEPLOY.md, passo 6)."
  else
    pulou "HTTPS público" "defina SGA_TI_URL_PUBLICA=sga-ti.suaempresa.com para conferir"
  fi
else
  pulou "respostas HTTP" "curl não instalado"
fi

# ---------------------------------------------------------------------------
secao '7. Dados e cópias'
BANCO=$(config SGA_TI_DB 2>/dev/null || echo "$DADOS/sga-ti.db")
if [ -f "$BANCO" ]; then
  ok "banco em $BANCO ($(du -h "$BANCO" 2>/dev/null | cut -f1))"
else
  olhe "banco ainda não existe em $BANCO" "normal antes do primeiro acesso; ele nasce na primeira subida."
fi

COPIAS=$(ls -1 "$DADOS"/backups/*.db 2>/dev/null | wc -l)
if [ "$COPIAS" -gt 0 ]; then
  ok "$COPIAS cópia(s) de segurança, a mais recente de $(date -r "$(ls -t "$DADOS"/backups/*.db | head -1)" '+%d/%m %H:%M' 2>/dev/null)"
else
  olhe "nenhuma cópia gerada ainda" \
       "rode 'sudo systemctl start ${SERVICO}-backup.service' e confira. Teste a RESTAURAÇÃO antes de precisar."
fi
olhe "a cópia sai deste servidor?" \
     "cópia no mesmo disco não protege contra a perda do disco. Ver ExecStartPost em ${SERVICO}-backup.service."

# Espaço: disco cheio derruba o banco junto.
USO=$(df -P "$DADOS" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ -n "$USO" ]; then
  if [ "$USO" -lt 80 ]; then ok "disco em ${USO}% de uso"
  elif [ "$USO" -lt 90 ]; then olhe "disco em ${USO}%" "acompanhe: disco cheio corrompe o banco."
  else pare "disco em ${USO}%" "libere espaço agora; o SQLite não sobrevive a disco cheio."
  fi
fi

# ---------------------------------------------------------------------------
secao '8. Conferências que dependem de você'
cat <<'LEMBRETE'
  Estas ninguém automatiza — marque no DEPLOY.md quando fizer:
    • entrar como admin e trocar a senha (o sistema obriga, mas faça agora)
    • cadastrar as pessoas com o papel mínimo necessário
    • preencher o contato do DPO em public/privacidade.html
    • preencher os responsáveis em OPERACAO.md
    • restaurar uma cópia num servidor de teste, ao menos uma vez
LEMBRETE

# ---------------------------------------------------------------------------
printf '\n'
if [ "$bloqueios" -gt 0 ]; then
  printf '\033[31m%s bloqueio(s) e %s ponto(s) de atenção. NÃO libere ainda.\033[0m\n' "$bloqueios" "$alertas"
  exit 1
fi
if [ "$alertas" -gt 0 ]; then
  printf '\033[33mNenhum bloqueio; %s ponto(s) de atenção acima.\033[0m\n' "$alertas"
else
  printf '\033[32mTudo conferido. Pode liberar para o time.\033[0m\n'
fi
exit 0
