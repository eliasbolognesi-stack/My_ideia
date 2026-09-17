# My_ideia — SGA-TI

Gestão de Ativos e Estoque de TI: do prompt de sistema ao sistema funcionando.

| Item | Descrição |
|---|---|
| [`sga-ti-prompt-de-sistema.md`](sga-ti-prompt-de-sistema.md) | Prompt de sistema do assistente SGA-TI para o node de IA no n8n |
| [`sga-ti/`](sga-ti/) | Sistema completo (backend Node.js + SQLite, frontend web, testes) que implementa as regras do prompt e recebe a saída do assistente via webhook |
| [`n8n/`](n8n/) | Três fluxos prontos para importar: registrar evento a partir de uma mensagem, monitor de saúde e resumo semanal |

Para rodar o sistema: veja [`sga-ti/README.md`](sga-ti/README.md). Requisito único: Node.js ≥ 22.5.

```bash
cd sga-ti && npm start
```

O caminho completo, quando tudo está ligado:

```
mensagem do colaborador  →  n8n  →  Claude extrai o evento  →  SGA-TI grava
                                          └──────────── Langfuse mostra o rastro inteiro
```

- Fluxos e como importá-los: [`n8n/README.md`](n8n/README.md)
- Acompanhar pelo Langfuse (opcional): [`sga-ti/deploy/langfuse.md`](sga-ti/deploy/langfuse.md)
