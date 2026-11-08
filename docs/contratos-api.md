# Contratos da API

Regras de comportamento e erros dos dois serviços. Os campos das tabelas estão nas seções 5.1 e 5.2 do [prompt.md](prompt.md). As referências no formato D1, D2 etc. estão em [decisoes.md](decisoes.md).

Este documento deve continuar consistente com o Swagger em `/docs/events` e `/docs/tickets`.

## API Gateway (porta 8080)

Único ponto de entrada externo (D13, D14). Rotas não listadas respondem `404 Route not found`, e um serviço indisponível responde `503 Service unavailable`.

| Rota pública | Destino |
|---|---|
| `/events`, `/events/{id}` | `events-service` |
| `/tickets`, `/tickets/{id}` | `tickets-service` |
| `/docs/events`, `/docs/tickets` | Swagger de cada serviço |
| `/health/events`, `/health/tickets` | `GET /health` de cada serviço |
| `/metrics/events`, `/metrics/tickets` | `GET /metrics` de cada serviço |
| `/prometheus/` | Interface do Prometheus |
| `/grafana/` | Painéis do Grafana |
| `/rabbitmq/` | Interface de gerenciamento do RabbitMQ |
| `/gateway/health` | Saúde do próprio gateway |

`PATCH /events/{id}/reserve-spot` e `release-spot` são internas: só o `tickets-service` as alcança, pela rede Docker. As rotas das tabelas abaixo são as de cada serviço.

## `events-service` (porta 8000)

| Método e rota | Sucesso | Erros |
|---|---|---|
| `POST /events` | `201` | `422` |
| `GET /events?category=&status=` | `200` | `422` |
| `GET /events/{id}` | `200` | `404`, `422` |
| `PUT /events/{id}` | `200` | `404`, `409`, `422` |
| `DELETE /events/{id}` | `204` | `404`, `422` |
| `PATCH /events/{id}/reserve-spot` | `200` | `404`, `409`, `422` |
| `PATCH /events/{id}/release-spot` | `200` | `404`, `422` |
| `GET /health` · `GET /metrics` | `200` | |

### Regras de eventos

- `max_capacity > 0` e `end_at` posterior a `start_at`.
- `start_at` e `end_at` exigem fuso horário (`2026-11-20T08:00:00-04:00` ou sufixo `Z`); sem fuso, a API responde `422` (D10).
- O `PUT` altera somente os campos enviados, e enviar `null` só é aceito em `description` e `metadata_info` (D10).
- `GET /health` responde `503` quando o banco está indisponível.
- Na criação, `available_spots = max_capacity` e `status = PUBLISHED`. O cliente não define `available_spots` diretamente.
- **`reserve-spot`:** só com `status = PUBLISHED` e `available_spots > 0`; caso contrário, `409 Event is sold out` ou `409 Event is not open for registrations`. Ao chegar a `0`, o status passa para `SOLD_OUT`.
- **`release-spot`:** incrementa até `max_capacity`. No limite, responde `200` sem alterar e registra aviso no log. Com vagas livres, `SOLD_OUT` volta a `PUBLISHED`; os status `CANCELLED` e `FINISHED` não mudam.
- **Mudança de capacidade (D2):** `ocupadas = max_capacity - available_spots`. Com nova capacidade menor que `ocupadas`, responde `409`; caso contrário, `available_spots = nova capacidade - ocupadas`. O status alterna entre `PUBLISHED` e `SOLD_OUT` conforme as vagas livres.
- **Evento cancelado (D17):** `CANCELLED` é um estado final; mudar para outro status responde `409 Cancelled event cannot be reopened`. Os demais campos continuam editáveis.
- **`DELETE` de evento com ingressos ativos (D6, D16):** é permitido. Os ingressos são cancelados de forma assíncrona e seguem com o `event_snapshot`.

## `tickets-service` (porta 3000)

| Método e rota | Sucesso | Erros |
|---|---|---|
| `POST /tickets` | `201` | `400`, `404`, `409`, `500`, `503` |
| `GET /tickets?event_id=&participant_email=&status=` | `200` | `400` |
| `GET /tickets/:id` (UUID ou `ticket_code`) | `200` | `404` |
| `PUT /tickets/:id` | `200` | `400`, `404`, `409` |
| `DELETE /tickets/:id` | `200` | `400`, `404`, `409`, `503` |
| `GET /health` · `GET /metrics` | `200` | |

### Regras de ingressos

- `ticket_code` tem o formato `EVT-2026-XXXXXX` (6 caracteres alfanuméricos maiúsculos). Em caso de colisão, gera outro código.
- **Duplicidade (D3):** só um ingresso não cancelado por `(event_id, participant_document)`. Uma nova inscrição é aceita depois do cancelamento.
- **`PUT` (D5, D12):**
  - Altera somente os campos enviados; campos desconhecidos e `null` respondem `400`.
  - Aceita dados do participante, `modality_tier` e `status: CHECKED_IN`; enviar `event_id` responde `400`.
  - `CHECKED_IN` só a partir de `CONFIRMED`; outra origem responde `409`.
  - `status: CANCELLED` responde `400`, porque o cancelamento é feito por `DELETE`.
  - Ingresso `CANCELLED` não é editável (`409`).
  - Alterar o documento para um já ativo no evento responde `409`.
- **`DELETE` (D1):** vale para `CONFIRMED` e `CHECKED_IN`, e devolve o ingresso com status `CANCELLED`. Repetir responde `409`.

<a id="fluxos-entre-servicos"></a>

## Fluxos entre serviços

### Emissão: `POST /tickets`

```mermaid
sequenceDiagram
    participant C as Cliente
    participant T as tickets-service
    participant E as events-service
    participant D as tickets_db
    C->>T: POST /tickets
    T->>E: GET /events/{id}
    E-->>T: evento
    T->>D: verifica duplicidade
    T->>E: PATCH /events/{id}/reserve-spot
    E-->>T: vaga reservada
    T->>D: salva ingresso CONFIRMED
    alt falha ao salvar
        T->>E: PATCH /events/{id}/release-spot
        T-->>C: 409 (duplicidade) ou 500
    else sucesso
        T-->>C: 201 com ingresso
    end
```

| Situação | Resposta |
|---|---|
| Evento inexistente | `404 Event not found` |
| Status `CANCELLED` ou `FINISHED` | `400 Event is not open for registrations` |
| Status `SOLD_OUT` ou sem vagas, na consulta ou na reserva (D11) | `409 Event is sold out` |
| Evento fechado entre a consulta e a reserva | `409 Event is not open for registrations` |
| Falha ao salvar o ingresso | `500 Could not issue ticket`, com a vaga devolvida |
| Participante já inscrito | `409 Participant already registered for this event` |
| `events-service` indisponível ou timeout | `503 Events service unavailable` |

### Cancelamento: `DELETE /tickets/:id`

1. Atualiza para `CANCELLED` por `UPDATE` condicional (`status <> 'CANCELLED'`). Se nenhuma linha mudar, responde `404` ou `409`, sem devolver vaga.
2. Chama `release-spot`.
3. Se o evento não existir mais (`404`), mantém o cancelamento e registra no log (D6).
4. Se o `events-service` falhar ou esgotar o timeout, restaura o status anterior e responde `503` (D5).

### Cancelamento ou remoção de evento: mensageria assíncrona (D16)

```mermaid
sequenceDiagram
    participant C as Cliente
    participant E as events-service
    participant B as RabbitMQ
    participant T as tickets-service
    C->>E: PUT /events/{id} (CANCELLED) ou DELETE /events/{id}
    E->>E: salva o evento e a mensagem na mesma transação
    E-->>C: resposta imediata
    E->>B: publica a mensagem pendente (até 1 s depois)
    B->>T: entrega a mensagem
    T->>T: cancela os ingressos ativos do evento
    T->>B: confirma (ack)
```

| Item | Valor |
|---|---|
| Exchange | `events.exchange` (topic, durável) |
| Routing keys | `event.cancelled`, `event.deleted` |
| Fila | `tickets.event-updates` (durável) |
| Fila de mensagens inválidas | `tickets.event-updates.dlq` |

```json
{
  "message_id": "5a1e7c2e-9a55-4b2f-8f35-2f1b7e8a4c10",
  "event_type": "event.cancelled",
  "event_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "occurred_at": "2026-11-08T20:00:00+00:00",
  "correlation_id": "demo-123"
}
```

## Limitações conhecidas

Um ingresso cuja reserva terminou antes do cancelamento do evento, mas que só foi salvo depois de a mensagem ser processada, pode ficar ativo. A janela é de milissegundos diante do intervalo de publicação de até 1 s.

Com timeout em `reserve-spot` ou `release-spot`, o `tickets-service` não sabe se o Serviço A aplicou a operação. Corrigir isso exigiria chave de idempotência ou mensageria, fora do escopo síncrono do trabalho. Ver D5.
