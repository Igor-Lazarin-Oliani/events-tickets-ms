# Arquitetura

Visão do que existe e do que está previsto. A especificação completa está em [prompt.md](prompt.md).

<a id="estado-da-implementacao"></a>

## Estado da implementação

| Fase | Entrega | Estado |
|---|---|---|
| 1 | `events-service` (FastAPI + PostgreSQL) | Código e testes concluídos; imagem Docker e PostgreSQL real ainda não validados |
| 2 | `tickets-service` (NestJS + PostgreSQL) | Não iniciada |
| 3 | `docker-compose.yml` com 4 contêineres | Não iniciada |
| 4 | `README.md` e roteiro de demonstração | Não iniciada |

Atualize esta tabela ao concluir cada fase.

## Topologia

```mermaid
flowchart TB
    cliente["Swagger UI / curl / Postman"]
    subgraph rede["Rede Docker: events-tickets-network"]
        events["events-service<br/>FastAPI :8000"]
        tickets["tickets-service<br/>NestJS :3000"]
        eventsdb[("events-db<br/>events_db")]
        ticketsdb[("tickets-db<br/>tickets_db")]
    end
    cliente -->|":8000"| events
    cliente -->|":3000"| tickets
    tickets -->|"HTTP REST síncrono"| events
    events --> eventsdb
    tickets --> ticketsdb
```

| Contêiner | Tecnologia | Porta no host | Porta interna | Responsabilidade |
|---|---|---|---|---|
| `events-service` | Python 3.11, FastAPI, SQLAlchemy 2 | 8000 | 8000 | Eventos e capacidade |
| `events-db` | PostgreSQL 16 | 5433 | 5432 | Dados de `events_db` |
| `tickets-service` | Node.js 20, NestJS, TypeORM | 3000 | 3000 | Inscrições e ingressos |
| `tickets-db` | PostgreSQL 16 | 5434 | 5432 | Dados de `tickets_db` |

## Fronteiras entre os serviços

- O `events-service` é a fonte da verdade sobre capacidade e não conhece ingressos.
- O `tickets-service` guarda `event_id` como referência lógica, sem chave estrangeira, e copia os dados do evento em `event_snapshot` no momento da inscrição.
- A dependência é unidirecional: só o `tickets-service` chama o `events-service`.

## Ordem de inicialização

`events-db` e `tickets-db` saudáveis → `events-service` saudável → `tickets-service`. Cada dependência usa `depends_on` com `condition: service_healthy`, e os serviços criam as próprias tabelas ao subir.

## Configuração

Os valores padrão ficam no `docker-compose.yml`, para que a avaliação não dependa de `.env`. As credenciais são exclusivas do ambiente local do trabalho.

| Serviço | Variável | Uso |
|---|---|---|
| `events-service` | `DATABASE_URL`, `PORT`, `SERVICE_NAME` | Banco e identificação |
| `tickets-service` | `DATABASE_URL`, `PORT`, `SERVICE_NAME` | Banco e identificação |
| `tickets-service` | `EVENTS_SERVICE_URL` | `http://events-service:8000` |
| `tickets-service` | `EVENTS_SERVICE_TIMEOUT_MS` | Timeout das chamadas ao Serviço A (padrão: 5000) |

## Observabilidade

- `GET /health` e `GET /metrics` (formato Prometheus) nos dois serviços, sem contêiner de Prometheus.
- Métricas de requisições e latência nos dois serviços, além de contadores de ingressos emitidos e cancelados no `tickets-service`.
- Logs estruturados com método, rota, status e duração em milissegundos.
- O cabeçalho `X-Correlation-Id` é gerado ou reaproveitado pelo `tickets-service`, enviado ao `events-service` e impresso nos logs dos dois lados (D7).
