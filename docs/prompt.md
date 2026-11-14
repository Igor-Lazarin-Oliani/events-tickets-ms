# 🚀 CONTEXTO DO PROJETO E DIRETRIZES PARA O AGENTE DE IA (MASTER PROMPT)

> **Versão 3 (fase 11).** O sistema tem três microsserviços, cada um com seu banco: `events-service` (JavaScript/NestJS), `tickets-service` (TypeScript/NestJS) e `logs-service` (Python/FastAPI). As seções 1 a 7 descrevem a versão atual. As seções 8 a 12 são o histórico das versões 1 e 2; a seção 13 descreve a fase 11. As decisões estão em `docs/decisoes.md` (D29 a D36 tratam da versão 3).

## 1. Papel do Agente de IA (System Persona)

Você atua como um **Arquiteto de Sistemas Distribuídos Sênior e Engenheiro de Software Full-Cycle**. Sua missão é me guiar e implementar um sistema distribuído completo, limpo, modular, documentado com Swagger e 100% conteinerizado (`events-tickets-ms`) para um Trabalho Prático da disciplina de **Sistemas Distribuídos (UFMS)**.

**Regras de Ouro para geração de código:**

1. **Topologia de Contêineres:** São **10 contêineres** (seção 4): `api-gateway`, `events-db`, `events-service`, `tickets-db`, `tickets-service`, `logs-db`, `logs-service`, `rabbitmq`, `prometheus` e `grafana`. Nada além disso sem pedido do autor.

2. **Pragmatismo e Execução Limpa ("Clean Machine Ready"):** O projeto será avaliado em uma máquina limpa apenas com `git clone` e `docker compose up --build`. Não crie dependências manuais externas. Tudo deve subir orquestrado e pré-configurado.

3. **Alta Modularização e Boas Práticas:** Os três microsserviços devem ter responsabilidades bem separadas em camadas/módulos (Controllers/Routers, Services, Repositories/Entities, DTOs/Schemas, Integrations e Metrics).

4. **Swagger (OpenAPI 3.0) Obrigatório nas Três APIs:** Os três microsserviços devem expor o **Swagger UI**, acessível pelo API Gateway em `/docs/events`, `/docs/tickets` e `/docs/logs` (D14), com todos os endpoints, DTOs/Schemas, exemplos de payload e códigos de resposta HTTP documentados.

5. **Código didático e rastreável:** Adicione logs claros e estruturados no console (ex: `[TICKET ISSUED]`, `[EVENT SPOT RESERVED]`, `[HTTP SYNC REQUEST]`, `[ACTIVITY LOGGED]`, `[TELEMETRY]`) para facilitar a demonstração ao vivo.

6. **NUNCA faça `git commit` nem `git push`:** O agente nunca executa commit nem push, em nenhuma circunstância. Ao concluir uma entrega, apenas informe a frase de commit sugerida; o autor do projeto faz o commit e o push.

7. **Documentação viva em `docs/`:** Toda a documentação do projeto fica em `docs/`, inclusive este arquivo e o `AGENTS.md`; a única exceção é o `README.md`, que fica na raiz para o GitHub e para a entrega. Mudou um contrato, fluxo ou decisão? Atualize o documento correspondente na mesma entrega. As decisões que refinam esta especificação estão em `docs/decisoes.md`.

## 2. Requisitos Obrigatórios do Projeto

* [x] **1. Heterogeneidade e Serviços CRUD:** Três microsserviços distintos com operações CRUD completas (`Create`, `Read`, `Update`, `Delete`), em **linguagens/ecossistemas diferentes**: `events-service` em JavaScript/NestJS (CRUD de eventos), `tickets-service` em TypeScript/NestJS (CRUD de ingressos) e `logs-service` em Python/FastAPI (CRUD de registros de atividade).
* [x] **2. Descentralização de Dados (Database per Service):** Cada microsserviço possui e acessa exclusivamente sua própria instância PostgreSQL (`events-db`, `tickets-db` e `logs-db`).
* [x] **3. Conteinerização e Orquestração:** `Dockerfile` individual para cada microsserviço e um `docker-compose.yml` na raiz que orquestra os 10 contêineres na rede interna `events-tickets-network`.
* [x] **4. Comunicação entre Serviços:** JSON nos dois estilos. Síncrono por HTTP REST: o `tickets-service` reserva a vaga no `events-service` (D30), e os dois consultam o histórico no `logs-service` (D21). Assíncrono pelo RabbitMQ: a devolução de vagas (D31), o cancelamento em cascata dos ingressos (D33) e o registro de cada atividade (D20).
* [x] **5. Documentação Interativa (Swagger / OpenAPI):** Swagger UI dos três serviços, acessível pelo gateway.
* [x] **6. Observabilidade e Telemetria Integrada:** `/metrics` no padrão Prometheus nos três serviços, coleta pelo Prometheus, painel no Grafana e logs estruturados com `X-Correlation-Id`.

## 3. Visão do Produto: `events-tickets-ms`

Vamos construir o **`events-tickets-ms`**, uma plataforma distribuída *white-label* (genérica e agnóstica a nicho) para **Gestão de Eventos e Emissão Unificada de Inscrições/Ingressos**, com **registro de atividades** de tudo o que acontece.

* **Por que Eventos Genéricos?** O sistema não é travado em um único tema. Ele pode gerenciar desde um simpósio acadêmico na universidade, um workshop online, um show musical, até uma corrida de rua ou campeonato de e-sports.
* **Por que Inscrição e Ingresso Unificados?** No nosso domínio, realizar uma **Inscrição** e emitir um **Ingresso/Credencial** representam a mesma entidade transacional (`Ticket`). Quando um participante se inscreve, o sistema reserva a vaga e emite um ingresso digital único com código verificável e controle de presença (*check-in*).
* **Por que eventos e ingressos em serviços separados?** O `events-service` é dono do evento e das vagas; o `tickets-service`, dos ingressos e dos participantes. Cada um tem seu banco, e a regra de nunca vender mais ingressos que vagas atravessa os dois com reserva idempotente, compensação e mensagens (D29 a D33).
* **Por que um serviço de logs separado?** O registro de atividades responde "o que aconteceu com este evento ou ingresso, e quando". Ele só acrescenta dados, tem outra retenção e não pode impedir uma venda se cair. Por isso recebe as atividades de forma assíncrona e tem banco próprio.

## 4. Topologia da Arquitetura e Stack Tecnológica

```
                       [ Navegador (aplicação web, Swagger UI) / cURL ]
                                           |
                                    (Porta :8080)
                                           v
                         +-------------------------------------+
                         |     api-gateway (NGINX, porta 80)   |
                         +-------------------------------------+
                            |                |                |
                            v                v                v
   +----------------------------+  +----------------------------+  +----------------------------+
   | events-service (:3001)     |  | tickets-service (:3002)    |  | logs-service (:8000)       |
   | JavaScript + NestJS        |<-| TypeScript + NestJS        |  | Python + FastAPI           |
   | - CRUD /events             |  | - CRUD /tickets            |  | - CRUD /logs               |
   | - reserve-spot (interna)   |  | - reserva por HTTP ------->|  | - consumidor logs.activity |
   | - consumidor de devoluções |  | - consumidor de cascata    |  |                            |
   +----------------------------+  +----------------------------+  +----------------------------+
          |   histórico (HTTP) -------------------|------------------------------>^      |
          v                                       v                                      v
   +--------------+                        +--------------+                       +--------------+
   |  events-db   |                        |  tickets-db  |                       |   logs-db    |
   +--------------+                        +--------------+                       +--------------+

   rabbitmq: activities.exchange -> logs.activity (logs-service)
             events.exchange     -> tickets.event-updates (tickets-service)
             tickets.exchange    -> events.spot-releases (events-service)

   prometheus (coleta /metrics dos três serviços) -> grafana (painel "Visão Geral")
```

### Stack Definida:

* **Microsserviço A (`events-service` - Porta `3001`):** Node.js 20 + NestJS em **JavaScript** (Babel com decorators) + TypeORM (`EntitySchema`) + `@nestjs/swagger` + `prom-client` + `amqplib` + `@nestjs/axios` (D35).
* **Banco de Dados A (`events-db`):** PostgreSQL 16 (`events_db`), tabelas `events`, `spot_reservations` e `outbox_messages`.
* **Microsserviço B (`tickets-service` - Porta `3002`):** Node.js 20 + NestJS em **TypeScript** + TypeORM + `@nestjs/swagger` + `prom-client` + `amqplib` + `@nestjs/axios`.
* **Banco de Dados B (`tickets-db`):** PostgreSQL 16 (`tickets_db`), tabelas `tickets`, `closed_events` e `outbox_messages`.
* **Microsserviço C (`logs-service` - Porta `8000`):** Python 3.11 + FastAPI + SQLAlchemy 2.0 + Pydantic v2 + Prometheus Instrumentator + `pika`.
* **Banco de Dados C (`logs-db`):** PostgreSQL 16 (`logs_db`), tabela `activity_logs`.
* **Infraestrutura:** NGINX 1.27 (`api-gateway`), RabbitMQ 3.13 (`rabbitmq`), Prometheus 2.55 e Grafana 11.4.

Só o `api-gateway` publica porta no host (`8080`).

## 5. Especificação Detalhada dos Microsserviços e Swagger

### 5.1. Microsserviço A: `events-service` (Eventos e Vagas)

Responsável pelo ciclo de vida dos eventos e pela verdade absoluta sobre as vagas.

* **Tecnologia:** Node.js + NestJS (JavaScript) + TypeORM + PostgreSQL (`events_db`).
* **Documentação Swagger:** `/docs/events` e OpenAPI JSON em `/docs/events/openapi.json`.
* **Modelo de Dados (Tabela `events`):**
  * `id` (UUID, PK)
  * `title` (String, obrigatório) — *Ex: "Semana da Computação UFMS", "Festival de Música Indie", "Workshop Docker"*
  * `description` (Text, opcional)
  * `category` (String, padrão `GENERAL`) — *Ex: "ACADEMIC", "CONCERT", "WORKSHOP", "SPORTS", "GENERAL"*
  * `modality` (Enum) — `"IN_PERSON"`, `"ONLINE"`, `"HYBRID"`
  * `location` (String) — *Endereço físico ou link da transmissão*
  * `start_at` / `end_at` (timestamptz, ISO 8601 com fuso)
  * `max_capacity` (Integer, $> 0$)
  * `available_spots` (Integer, $\ge 0$) — *Inicia igual a `max_capacity`*
  * `status` (Enum) — `"PUBLISHED"`, `"SOLD_OUT"`, `"CANCELLED"`, `"FINISHED"`
  * `metadata_info` (JSONB, opcional) — *Atributos livres (palestrante, carga horária, classificação)*
  * `created_at` / `updated_at`
* **Tabela `spot_reservations` (D30, D31):** `ticket_id` (UUID, PK), `event_id`, `status` (`RESERVED` ou `RELEASED`), `reserved_at`, `released_at`, `created_at`, `updated_at`.
* **Tabela `outbox_messages`:** `id` (= `message_id`), `exchange`, `routing_key`, `payload` (JSONB), `created_at`, `published_at` (D20, D34).
* **Endpoints (Todos documentados no Swagger):**
  1. `POST /events` — Cria um evento (`available_spots = max_capacity`, status `PUBLISHED`).
  2. `GET /events` — Lista os eventos (filtros `?category=...&status=...`), paginada com `limit` e `offset` e com o total em `X-Total-Count` (D26).
  3. `GET /events/{id}` — Busca um evento.
  4. `PUT /events/{id}` — Atualiza só os campos enviados. Mudança de capacidade preserva as vagas ocupadas (D2); `CANCELLED` é final (D17) e avisa o `tickets-service` pela outbox (D33).
  5. `DELETE /events/{id}` — Remove o evento e avisa o `tickets-service` pela outbox (D33).
  6. `GET /events/{id}/history` — Histórico do evento, consultado no `logs-service` (D21), paginado com `limit` e `offset` (D26).
  7. `PATCH /events/{id}/reserve-spot` — **Interna**, fora do gateway: reserva idempotente pelo `ticket_id` (D30).
  8. `GET /health` e `GET /metrics`.
* **Consumidor:** fila `events.spot-releases`, que devolve cada vaga uma única vez (D31).

### 5.2. Microsserviço B: `tickets-service` (Inscrições e Ingressos)

Responsável pelas inscrições, pelos ingressos e pelo check-in.

* **Tecnologia:** Node.js + NestJS (TypeScript) + TypeORM + PostgreSQL (`tickets_db`).
* **Documentação Swagger:** `/docs/tickets` e OpenAPI JSON em `/docs/tickets/openapi.json`.
* **Modelo de Dados (Tabela `tickets`):**
  * `id` (UUID, PK, gerado pelo serviço antes da reserva — D30)
  * `ticket_code` (String, único, gerado) — *Ex: `EVT-2026-A8F9K2`*
  * `event_id` (UUID do evento no `events-service`, **sem chave estrangeira**)
  * `event_snapshot` (JSONB: `{ title, category, modality, location, start_at }` capturados na inscrição)
  * `participant_name`, `participant_email`, `participant_document` (CPF/RG/Matrícula)
  * `modality_tier` (String, padrão `STANDARD`) — *Ex: "VIP", "ESTUDANTE", "OUVINTE", "LOTE_1"*
  * `status` (Enum) — `"CONFIRMED"`, `"CHECKED_IN"`, `"CANCELLED"`
  * `created_at` / `updated_at`
  * Índice único parcial `(event_id, participant_document)` para `status <> 'CANCELLED'` (D3)
* **Tabela `closed_events` (D32):** `event_id` (UUID, PK), `reason` (`event_cancelled` ou `event_deleted`), `closed_at`.
* **Tabela `outbox_messages`:** mesma estrutura do `events-service` (D34).
* **Endpoints (Todos documentados no Swagger):**
  1. `POST /tickets` — Realiza a inscrição / emite o ingresso (seção 6).
  2. `GET /tickets` — Lista os ingressos (filtros `?event_id=...&participant_email=...&status=...`), paginada com `limit` e `offset` e com o total em `X-Total-Count` (D26).
  3. `GET /tickets/{id}` — Consulta por `id` (UUID) ou `ticket_code`.
  4. `PUT /tickets/{id}` — Atualiza dados do participante, `modality_tier` ou realiza o **Check-in** (`status: "CHECKED_IN"`) (D12).
  5. `DELETE /tickets/{id}` — **Cancela o ingresso** (soft delete, D1) e pede a devolução da vaga pela outbox (D31).
  6. `GET /tickets/{id}/history` — Histórico do ingresso, consultado no `logs-service` (D21), paginado com `limit` e `offset` (D26).
  7. `GET /health` e `GET /metrics`.
* **Consumidor:** fila `tickets.event-updates`, que cancela os ingressos ativos de eventos cancelados ou removidos (D33).

### 5.3. Microsserviço C: `logs-service` (Registro de Atividades)

Guarda o registro de tudo o que acontece com eventos e ingressos e permite a triagem desses registros.

* **Tecnologia:** Python 3.11 + FastAPI + SQLAlchemy + PostgreSQL (`logs_db`).
* **Documentação Swagger:** `/docs/logs` e OpenAPI JSON em `/docs/logs/openapi.json`.
* **Modelo de Dados (Tabela `activity_logs`):**
  * `id` (UUID, PK)
  * `message_id` (UUID, único, nulo nos registros manuais) — *descarta entregas repetidas*
  * `source` (String) — *`events-service`, `tickets-service` ou `manual`*
  * `action` (String) — *Ex: `ticket.issued`, `event.cancelled`, `incident.reported`*
  * `entity_type` (String, opcional) e `entity_id` (UUID, opcional)
  * `level` (Enum) — `"INFO"`, `"WARNING"`, `"ERROR"`
  * `message` (Text) e `data` (JSONB, opcional, **sem dados pessoais**)
  * `correlation_id` (String, opcional)
  * `occurred_at` (timestamptz)
  * `status` (Enum, triagem) — `"NEW"`, `"REVIEWED"`, `"RESOLVED"`
  * `notes` (Text, opcional)
  * `archived_at` (timestamptz, opcional) — *exclusão lógica*
  * `created_at` / `updated_at`
* **Endpoints Obrigatórios (Todos documentados no Swagger):**
  1. `POST /logs` — Cria um registro manual (D19).
  2. `GET /logs` — Lista com filtros, ordem e paginação; sem os arquivados, salvo `include_archived=true`.
  3. `GET /logs/{id}` — Busca um registro, mesmo arquivado.
  4. `PUT /logs/{id}` — Altera só `status` e `notes`; os demais campos são imutáveis.
  5. `DELETE /logs/{id}` — Arquiva o registro (D19).
  6. `GET /health` e `GET /metrics`.
* **Consumidor:** thread que consome a fila `logs.activity` e grava cada mensagem uma única vez (D20).

## 6. Fluxos de Comunicação

### Fluxo 1: Emissão de Inscrição/Ingresso (`POST /tickets`) (D30)

1. **Cliente** envia `POST /tickets` com `event_id`, dados do participante e `modality_tier`.
2. **Recusas locais** no `tickets-service`: evento já registrado em `closed_events` → `400 Event is not open for registrations` (D32); documento já inscrito → `409` (D3).
3. **Reserva síncrona:** o `tickets-service` gera o `id` do ingresso e chama `PATCH /events/{id}/reserve-spot` com o `ticket_id`. O `events-service`, em uma transação, valida o evento (inexistente → `404`; encerrado → `400 Event has already ended` (D25); `SOLD_OUT` ou sem vagas → `409 Event is sold out` (D11); `CANCELLED` ou `FINISHED` → `400 Event is not open for registrations`), executa o `UPDATE` condicional (`status = 'PUBLISHED' AND available_spots > 0 AND end_at > now()`, `SOLD_OUT` ao zerar), grava a reserva em `spot_reservations` e `event.spot_reserved` na outbox. Repetir com o mesmo `ticket_id` não reserva outra vaga.
4. **Transação local** no `tickets_db`: lock consultivo do evento, confirmação de que ele não foi encerrado (D32), ingresso `CONFIRMED` com `ticket_code` e `event_snapshot`, e `ticket.issued` na outbox.
5. **Compensação:** se o passo 4 falhar, ou se o `events-service` não der resposta definitiva (que vira `503 Events service unavailable`), o `tickets-service` grava na outbox o pedido de devolução da vaga (D30, D31).

### Fluxo 2: Cancelamento de Inscrição/Ingresso (`DELETE /tickets/{id}`) (D31)

Em uma transação do `tickets_db`: muda o status para `CANCELLED` com `UPDATE` condicional e grava `ticket.cancelled` e o pedido `spot.release_requested`. O `events-service` consome o pedido, devolve a vaga uma única vez (`SOLD_OUT` volta a `PUBLISHED`) e grava `event.spot_released`.

### Fluxo 3: Cancelamento ou Remoção de Evento (D33)

Em uma transação do `events_db`: trava o evento, atualiza ou remove e grava a atividade e o aviso `event.cancelled`/`event.deleted`. O `tickets-service` consome o aviso e, em uma transação com o lock consultivo, registra o evento em `closed_events`, cancela os ingressos ativos sem devolver vagas e grava um `ticket.cancelled` por ingresso.

### Fluxo 4: Registro de Atividades (assíncrono)

O `events-service` e o `tickets-service` publicam as mensagens pendentes de suas outbox a cada segundo, cada uma na sua exchange, em lotes de 50 e com confirmação do broker; com acúmulo, os lotes seguintes saem em sequência (D28, D34). As atividades vão para `activities.exchange`, e o `logs-service` consome a fila `logs.activity`, grava e confirma (D20).

### Fluxo 5: Histórico (síncrono)

`GET /events/{id}/history` (no `events-service`) ou `GET /tickets/{id}/history` (no `tickets-service`) chamam `GET http://logs-service:8000/logs?entity_type=...&entity_id=...&order=asc&limit=...&offset=...`, com timeout de 3 s, e devolvem `total` a partir do `X-Total-Count` (D26). Falha → `503 Logs service unavailable`, sem afetar o resto da API (D21).

## 7. Estrutura de Diretórios Modularizada Esperada

```
events-tickets-ms/
├── docker-compose.yml                        # Orquestração dos 10 contêineres
├── README.md                                 # Guia de execução e demonstração
├── frontend/                                 # Aplicação web estática, servida pelo gateway em /app/
├── gateway/nginx.conf                        # API Gateway
├── messaging/rabbitmq.conf                   # Prefixo da interface do RabbitMQ
├── observability/                            # Prometheus e Grafana provisionados
├── docs/                                     # Toda a documentação do projeto
│   ├── prompt.md · AGENTS.md · arquitetura.md · contratos-api.md · decisoes.md
│   └── guia-da-implementacao.md · roteiro-apresentacao.md
└── microservices/
    ├── events-service/                       # Microsserviço A (Node.js + NestJS em JavaScript)
    │   ├── Dockerfile · package.json · package-lock.json · babel.config.json
    │   └── src/                              # Testes Jest (*.spec.js) ao lado do código
    │       ├── main.js                       # Bootstrap e Swagger
    │       ├── app.module.js
    │       ├── openapi.spec.js               # Gera o Swagger e confere os tipos declarados
    │       ├── config/typeorm.config.js
    │       ├── common/                       # Erro padrão, paginação, validação (ValidBody/ValidQuery)
    │       ├── database/database.module.js   # Repositórios das três tabelas
    │       ├── events/                       # Controller, service, repositórios, EntitySchema e DTOs
    │       ├── spot-releases/                # Consumidor da fila events.spot-releases
    │       ├── outbox/                       # Entidade, repositório, mensagens e publicador RabbitMQ
    │       ├── logs-integration/             # Cliente HTTP do histórico (logs-service)
    │       ├── metrics/                      # /health, /metrics, logs e X-Correlation-Id
    │       └── testing/                      # Dublês usados pelos testes
    │
    ├── tickets-service/                      # Microsserviço B (Node.js + NestJS em TypeScript)
    │   ├── Dockerfile · package.json · package-lock.json · tsconfig*.json · nest-cli.json
    │   └── src/                              # Testes Jest (*.spec.ts) ao lado do código
    │       ├── main.ts · app.module.ts · config/typeorm.config.ts
    │       ├── common/                       # Erro padrão, paginação, validações e erros do PostgreSQL
    │       ├── database/database.module.ts   # Repositórios das três tabelas
    │       ├── tickets/                      # Controller, service, repositórios, entidades e DTOs
    │       ├── events-integration/           # Cliente HTTP da reserva de vaga (events-service)
    │       ├── event-updates/                # Consumidor da fila tickets.event-updates
    │       ├── outbox/                       # Entidade, repositório, mensagens e publicador RabbitMQ
    │       ├── logs-integration/             # Cliente HTTP do histórico (logs-service)
    │       ├── metrics/                      # /health, /metrics, logs e X-Correlation-Id
    │       └── testing/                      # Dublês usados pelos testes
    │
    └── logs-service/                         # Microsserviço C (Python + FastAPI + SQLAlchemy)
        ├── Dockerfile · requirements.txt · requirements-dev.txt · pytest.ini
        ├── tests/                            # pytest (CRUD, arquivamento e consumidor)
        └── app/
            ├── main.py                       # Bootstrap, Swagger, /health, /metrics e consumidor
            ├── core/                         # config.py, database.py, telemetry.py
            └── modules/logs/
                ├── router.py · service.py · repository.py · models.py · schemas.py
                └── consumer.py               # Consumidor da fila logs.activity
```

## 8. Plano de Execução da Versão 1 (Fases 1 a 4, histórico)

As fases abaixo construíram a versão 1, com `events-service` (Python) e `tickets-service` (NestJS) separados e comunicação HTTP para reservar e devolver vagas. Foram concluídas e substituídas pela fase 8 (versão 2) e, depois, pela fase 11 (versão 3).

* **Fase 1:** `events-service` em FastAPI, com CRUD de eventos, reserva e devolução atômicas de vagas, Swagger, telemetria e testes `pytest`.
* **Fase 2:** `tickets-service` em NestJS, com CRUD de ingressos, cliente HTTP para o Serviço A, compensações, Swagger, métricas e testes Jest.
* **Fase 3:** `docker-compose.yml` com os 4 contêineres (dois serviços e dois bancos), healthchecks e rede `events-tickets-network`.
* **Fase 4:** `README.md` com guia de execução em máquina limpa e roteiro de demonstração.

## 9. Adequação ao Edital (Fases 5 a 7)

O edital do trabalho (`trabalho_cd.pdf`) pontua itens que a especificação original não previa.

### Pontuação do edital

| Item | Pontos | Atendido por |
|---|---|---|
| Heterogeneidade e CRUDs | 2,0 | `events-service` (JavaScript), `tickets-service` (TypeScript) e `logs-service` (Python), todos com CRUD completo |
| Banco por serviço | 1,0 | `events-db`, `tickets-db` e `logs-db` |
| Conteinerização e orquestração | 1,0 | Dockerfiles e `docker-compose.yml` |
| API Gateway | 1,0 | Fase 5 |
| Observabilidade com ferramentas especializadas | 1,0 | Fase 6 (Prometheus e Grafana; o `logs-service` não substitui este item) |
| Mensageria assíncrona (bônus) | +1,0 | Fase 7, ampliada nas fases 8 e 11 |
| Apresentação síncrona, de até 30 min | 4,0 | Até 21/11; a nota do código depende dela |

A apresentação deve conter a contextualização do problema (incluindo a justificativa da divisão dos microsserviços), os detalhes da arquitetura e a demonstração prática: build a partir do repositório em máquina limpa, rotas, persistência e coleta de telemetria.

### 🔹 FASE 5: API Gateway (`gateway/nginx.conf`)

Contêiner `api-gateway` (NGINX) como única porta de entrada, em `8080`. Serviços e bancos ficam sem porta no host. O gateway usa lista de rotas permitidas (D13, D14).

### 🔹 FASE 6: Observabilidade

Contêineres `prometheus` e `grafana`, com coleta das métricas dos serviços e painel já configurado no repositório, sem passo manual. Ambos são acessados pelo gateway, em `/prometheus/` e `/grafana/` (D15).

### 🔹 FASE 7: Mensageria Assíncrona

Contêiner `rabbitmq`, com publicação por outbox gravada na mesma transação da mudança (D16). Na versão 1, cancelar ou remover um evento cancelava os ingressos de forma assíncrona; na fase 8, a mensageria passou a levar o registro de atividades ao `logs-service` (D20); na fase 11, faz as duas coisas e também devolve as vagas (D31, D33).

## 10. Fase 8: Versão 2, `events-tickets-service` + `logs-service` (histórico)

Juntou eventos e ingressos em um único microsserviço NestJS e criou o microsserviço de logs, de modo que toda a comunicação distribuída acontecesse entre os dois (D18). Reserva e emissão viraram uma transação local, o cancelamento em cascata passou a ser síncrono na mesma transação (D22), toda mudança passou a gerar uma atividade pela outbox (D20) e o histórico passou a ser consultado por HTTP (D21). Foi substituída pela fase 11.

## 11. Fase 9: Aplicação web

Objetivo: dar ao sistema uma aplicação web que use as rotas públicas e mostre a comunicação entre os componentes, sem novo contêiner (D24).

* **Passo 9.1:** página estática em `frontend/` (HTML, CSS e módulos JavaScript, sem build nem CDN), servida pelo `api-gateway` em `/app/`, com `/` redirecionando para lá.
* **Passo 9.2:** CRUD de eventos, ingressos e registros de atividade, mais um teste de concorrência que dispara várias inscrições ao mesmo tempo.
* **Passo 9.3:** diagrama dos contêineres com a saúde de cada um, animação das chamadas e rastro por `X-Correlation-Id`, com a parte assíncrona confirmada pelo `logs-service`.

## 12. Fase 10: Desempenho, resiliência e evento encerrado

Objetivo: corrigir os gargalos encontrados na revisão do projeto e impedir inscrições em eventos encerrados (D25 a D28).

* **Passo 10.1:** inscrição recusada em evento inexistente (`404`) ou já encerrado (`400 Event has already ended`), também no `UPDATE` condicional da reserva (D25).
* **Passo 10.2:** paginação com `limit`, `offset` e `X-Total-Count` em `GET /events`, `GET /tickets` e `GET /logs`, e históricos paginados com `total` (D26).
* **Passo 10.3:** `restart: unless-stopped` em todos os contêineres, e `api-gateway` e `prometheus` sem depender do `logs-service` (D27).
* **Passo 10.4:** publicador da outbox com lotes em sequência, conexão fora da transação e métrica do acúmulo total; reserva e devolução de vaga com `RETURNING` (D28).

## 13. Fase 11: Versão 3, três microsserviços e três bancos

Objetivo: separar de novo eventos e ingressos, agora com o `events-service` em JavaScript e o `tickets-service` em TypeScript, mantendo o `logs-service` em Python, com um banco por serviço (D29).

* **Passo 11.1:** `events-service` em JavaScript (Babel, `EntitySchema`, `@Dependencies`, `@Bind`, validação explícita e Swagger com tipos declarados), com CRUD de eventos, histórico e a rota interna de reserva idempotente (D30, D35).
* **Passo 11.2:** `tickets-service` a partir do serviço da versão 2, com a reserva por HTTP, a compensação e o `id` do ingresso gerado antes da reserva (D30).
* **Passo 11.3:** devolução de vaga pela outbox, com a tabela `spot_reservations` e o consumidor `events.spot-releases` (D31).
* **Passo 11.4:** cancelamento em cascata assíncrono, com o consumidor `tickets.event-updates`, a tabela `closed_events` e o lock consultivo (D32, D33).
* **Passo 11.5:** uma exchange por finalidade e publicação mensagem a mensagem (D34); `logs-service` consumindo `activities.exchange`.
* **Passo 11.6:** `docker-compose.yml` com 10 contêineres, `nginx.conf`, `prometheus.yml`, painel do Grafana e aplicação web com os três serviços (D36).
* **Passo 11.7:** testes Jest e `pytest`, validação em contêiner (fluxos, concorrência e falhas) e atualização de toda a documentação.
