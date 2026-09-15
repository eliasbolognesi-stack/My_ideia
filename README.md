# My_ideia — SGA-TI

Gestão de Ativos e Estoque de TI: do prompt de sistema ao sistema funcionando.

| Item | Descrição |
|---|---|
| [`sga-ti-prompt-de-sistema.md`](sga-ti-prompt-de-sistema.md) | Prompt de sistema do assistente SGA-TI para o node de IA no n8n |
| [`sga-ti/`](sga-ti/) | Sistema completo (backend Node.js + SQLite, frontend web, testes) que implementa as regras do prompt e recebe a saída do assistente via webhook |

Para rodar o sistema: veja [`sga-ti/README.md`](sga-ti/README.md). Requisito único: Node.js ≥ 22.5.

```bash
cd sga-ti && npm start
```
