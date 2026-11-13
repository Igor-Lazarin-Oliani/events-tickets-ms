# 🚀 CONTEXTO DO PROJETO E DIRETRIZES PARA O AGENTE DE IA (MASTER PROMPT)

> **Versão 2 (fase 8).** O sistema foi reestruturado: eventos e ingressos formam um único microsserviço (`events-tickets-service`, NestJS), e o segundo microsserviço é o `logs-service` (Python), que guarda o registro de atividades. As seções 1 a 7 descrevem a versão atual. As fases 1 a 7 da seção 8 são o histórico da versão 1; a seção 10 descreve a fase 8. As decisões estão em `docs/decisoes.md` (D18 a D23 tratam da reestruturação).

## 1. Papel do Agente de IA (System Persona)

Você atua como um **Arquiteto de Sistemas Distribuídos Sênior e Engenheiro de Software Full-Cycle**. Sua missão é me guiar e implementar um sistema distribuído completo, limpo, modular, documentado com Swagger e 100% conteinerizado (`events-tickets-ms`) para um Trabalho Prático da disciplina de **Sistemas Distribuídos (UFMS)**.

**Regras de Ouro para geração de código:**

1. **Topologia de Contêineres:** São **8 contêineres** (seção 4): `api-gateway`, `events-tickets-db`, `events-tickets-service`, `logs-db`, `logs-service`, `rabbitmq`, `prometheus` e `grafana`. Nada além disso sem pedido do autor.

2. **Pragmatismo e Execução Limpa ("Clean Machine Ready"):** O projeto será avaliado em uma máquina limpa apenas com `git clone` e `docker compose up --build`. Não crie dependências manuais externas. Tudo deve subir orquestrado e pré-configurado.

3. **Alta Modularização e Boas Práticas:** Ambos os microsserviços devem ter responsabilidades bem separadas em camadas/módulos (Controllers/Routers, Services, Repositories/Entities, DTOs/Schemas, Integrations e Metrics).

4. **Swagger (OpenAPI 3.0) Obrigatório nas Duas APIs:** Ambos os microsserviços devem expor o **Swagger UI**, acessível pelo API Gateway em `/docs/events-tickets` e `/docs/logs` (D14), com todos os endpoints, DTOs/Schemas, exemplos de payload e códigos de resposta HTTP documentados.

5. **Código didático e rastreável:** Adicione logs claros e estruturados no console (ex: `[TICKET ISSUED]`, `[EVENT SPOT RESERVED]`, `[HTTP SYNC REQUEST]`, `[ACTIVITY LOGGED]`, `[TELEMETRY]`) para facilitar a demonstração ao vivo.

6. **NUNCA faça `git commit` nem `git push`:** O agente nunca executa commit nem push, em nenhuma circunstância. Ao concluir uma entrega, apenas informe a frase de commit sugerida; o autor do projeto faz o commit e o push.

7. **Documentação viva em `docs/`:** Toda a documentação do projeto fica em `docs/`, inclusive este arquivo e o `AGENTS.md`; a única exceção é o `README.md`, que fica na raiz para o GitHub e para a entrega. Mudou um contrato, fluxo ou decisão? Atualize o documento correspondente na mesma entrega. As decisões que refinam esta especificação estão em `docs/decisoes.md`.

## 2. Requisitos Obrigatórios do Projeto

* [x] **1. Heterogeneidade e Serviços CRUD:** Dois microsserviços distintos com operações CRUD completas (`Create`, `Read`, `Update`, `Delete`), em **linguagens/ecossistemas diferentes**: `events-tickets-service` em TypeScript/NestJS (CRUD de eventos e de ingressos) e `logs-service` em Python/FastAPI (CRUD de registros de atividade).
* [x] **2. Descentralização de Dados (Database per Service):** Cada microsserviço possui e acessa exclusivamente sua própria instância PostgreSQL (`events-tickets-db` e `logs-db`).
* [x] **3. Conteinerização e Orquestração:** `Dockerfile` individual para cada microsserviço e um `docker-compose.yml` na raiz que orquestra os 8 contêineres na rede interna `events-tickets-network`.
* [x] **4. Comunicação entre Serviços:** JSON nos dois sentidos de uso: assíncrono via RabbitMQ para gravar cada atividade no `logs-service` (D20) e HTTP REST síncrono para consultar o histórico de um evento ou ingresso (D21).
* [x] **5. Documentação Interativa (Swagger / OpenAPI):** Swagger UI dos dois serviços, acessível pelo gateway.
* [x] **6. Observabilidade e Telemetria Integrada:** `/metrics` no padrão Prometheus nos dois serviços, coleta pelo Prometheus, painel no Grafana e logs estruturados com `X-Correlation-Id`.

## 3. Visão do Produto: `events-tickets-ms`

Vamos construir o **`events-tickets-ms`**, uma plataforma distribuída *white-label* (genérica e agnóstica a nicho) para **Gestão de Eventos e Emissão Unificada de Inscrições/Ingressos**, com **registro de atividades** de tudo o que acontece.

* **Por que Eventos Genéricos?** O sistema não é travado em um único tema. Ele pode gerenciar desde um simpósio acadêmico na universidade, um workshop online, um show musical, até uma corrida de rua ou campeonato de e-sports.
* **Por que Inscrição e Ingresso Unificados?** No nosso domínio, realizar uma **Inscrição** e emitir um **Ingresso/Credencial** representam a mesma entidade transacional (`Ticket`). Quando um participante se inscreve, o sistema reserva a vaga e emite um ingresso digital único com código verificável e controle de presença (*check-in*).
* **Por que eventos e ingressos no mesmo serviço?** Eles compartilham a regra mais importante: nunca vender mais ingressos que vagas. No mesmo banco, reserva e emissão acontecem em uma única transação (D18).
* **Por que um serviço de logs separado?** O registro de atividades responde "o que aconteceu com este evento ou ingresso, e quando". Ele só acrescenta dados, tem outra retenção e não pode impedir uma venda se cair. Por isso recebe as atividades de forma assíncrona e tem banco próprio.

## 4. Topologia da Arquitetura e Stack Tecnológica

```
                 [ Navegador (Swagger UI) / Insomnia / Postman / cURL ]
                                         |
                                  (Porta :8080)
                                         v
                       +-------------------------------------+
                       |     api-gateway (NGINX, porta 80)   |
                       +-------------------------------------+
                          |                               |
                          v                               v
   +-----------------------------------------+   +-----------------------------------------+
   |   events-tickets-service (:3000)        |   |   logs-service (:8000)                  |
   |   Node.js 20 + NestJS + TypeORM         |   |   Python 3.11 + FastAPI + SQLAlchemy    |
   |   - CRUD de eventos (/events)           |   |   - CRUD de registros (/logs)           |
   |   - CRUD de ingressos (/tickets)        |   |   - Consumidor da fila logs.activity    |
   |   - Histórico (/.../history) --HTTP-->  |-->|   - Swagger: /docs/logs                 |
   |   - Outbox -> RabbitMQ                  |   |                                         |
   |   - Swagger: /docs/events-tickets       |   |                                         |
   +-----------------------------------------+   +-----------------------------------------+
          |                 |                                  ^                |
          | TypeORM         | publica atividades               | entrega        | SQLAlchemy
          v                 v                                  |                v
   +------------------+   +------------------------------------------+   +------------------+
   | events-tickets-db|   | rabbitmq: events-tickets.exchange (topic) |   |     logs-db      |
   | events_tickets_db|   |           -> fila logs.activity           |   |     logs_db      |
   +------------------+   +------------------------------------------+   +------------------+

   prometheus (coleta /metrics dos dois serviços) -> grafana (painel "Visão Geral")
```

### Stack Definida:

* **Microsserviço A (`events-tickets-service` - Porta `3000`):** Node.js 20 + NestJS (TypeScript) + TypeORM + `@nestjs/swagger` + `prom-client` + `amqplib` + `@nestjs/axios`.
* **Banco de Dados A (`events-tickets-db`):** PostgreSQL 16 (`events_tickets_db`), tabelas `events`, `tickets` e `outbox_messages`.
* **Microsserviço B (`logs-service` - Porta `8000`):** Python 3.11 + FastAPI + SQLAlchemy 2.0 + Pydantic v2 + Prometheus Instrumentator + `pika`.
* **Banco de Dados B (`logs-db`):** PostgreSQL 16 (`logs_db`), tabela `activity_logs`.
* **Infraestrutura:** NGINX 1.27 (`api-gateway`), RabbitMQ 3.13 (`rabbitmq`), Prometheus 2.55 e Grafana 11.4.

Só o `api-gateway` publica porta no host (`8080`).

## 5. Especificação Detalhada dos Microsserviços e Swagger

### 5.1. Microsserviço A: `events-tickets-service` (Eventos, Vagas e Ingressos)

Responsável pelo ciclo de vida dos eventos, pela verdade absoluta sobre as vagas e pelas inscrições/ingressos.

* **Tecnologia:** Node.js + NestJS (TypeScript) + TypeORM + PostgreSQL (`events_tickets_db`).
* **Documentação Swagger:** `/docs/events-tickets` e OpenAPI JSON em `/docs/events-tickets/openapi.json`.
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
* **Modelo de Dados (Tabela `tickets`):**
  * `id` (UUID, PK)
  * `ticket_code` (String, único, gerado) — *Ex: `EVT-2026-A8F9K2`*
  * `event_id` (UUID, referência ao evento **sem chave estrangeira**, para o ingresso sobreviver à remoção do evento)
  * `event_snapshot` (JSONB: `{ title, category, modality, location, start_at }` capturados na inscrição)
  * `participant_name`, `participant_email`, `participant_document` (CPF/RG/Matrícula)
  * `modality_tier` (String, padrão `STANDARD`) — *Ex: "VIP", "ESTUDANTE", "OUVINTE", "LOTE_1"*
  * `status` (Enum) — `"CONFIRMED"`, `"CHECKED_IN"`, `"CANCELLED"`
  * `created_at` / `updated_at`
  * Índice único parcial `(event_id, participant_document)` para `status <> 'CANCELLED'` (D3)
* **Tabela `outbox_messages`:** `id` (= `message_id`), `routing_key`, `payload` (JSONB), `created_at`, `published_at` (D20).
* **Endpoints Obrigatórios (Todos documentados no Swagger):**
  1. `POST /events` — Cria um evento (`available_spots = max_capacity`, status `PUBLISHED`).
  2. `GET /events` — Lista os eventos (filtros `?category=...&status=...`), paginada com `limit` e `offset` e com o total em `X-Total-Count` (D26).
  3. `GET /events/{id}` — Busca um evento.
  4. `PUT /events/{id}` — Atualiza só os campos enviados. Mudança de capacidade preserva as vagas ocupadas (D2); `CANCELLED` é final (D17) e cancela os ingressos ativos na mesma transação (D22).
  5. `DELETE /events/{id}` — Remove o evento e cancela os ingressos ativos na mesma transação (D22).
  6. `GET /events/{id}/history` — Histórico do evento, consultado no `logs-service` (D21), paginado com `limit` e `offset` (D26).
  7. `POST /tickets` — Realiza a inscrição / emite o ingresso (seção 6).
  8. `GET /tickets` — Lista os ingressos (filtros `?event_id=...&participant_email=...&status=...`), paginada com `limit` e `offset` e com o total em `X-Total-Count` (D26).
  9. `GET /tickets/{id}` — Consulta por `id` (UUID) ou `ticket_code`.
  10. `PUT /tickets/{id}` — Atualiza dados do participante, `modality_tier` ou realiza o **Check-in** (`status: "CHECKED_IN"`) (D12).
  11. `DELETE /tickets/{id}` — **Cancela o ingresso** (soft delete, D1) e devolve a vaga na mesma transação.
  12. `GET /tickets/{id}/history` — Histórico do ingresso, consultado no `logs-service` (D21), paginado com `limit` e `offset` (D26).
  13. `GET /health` e `GET /metrics`.

### 5.2. Microsserviço B: `logs-service` (Registro de Atividades)

Guarda o registro de tudo o que acontece com eventos e ingressos e permite a triagem desses registros.

* **Tecnologia:** Python 3.11 + FastAPI + SQLAlchemy + PostgreSQL (`logs_db`).
* **Documentação Swagger:** `/docs/logs` e OpenAPI JSON em `/docs/logs/openapi.json`.
* **Modelo de Dados (Tabela `activity_logs`):**
  * `id` (UUID, PK)
  * `message_id` (UUID, único, nulo nos registros manuais) — *descarta entregas repetidas*
  * `source` (String) — *`events-tickets-service` ou `manual`*
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

### Fluxo 1: Emissão de Inscrição/Ingresso (`POST /tickets`)

1. **Cliente** envia `POST /tickets` com `event_id`, dados do participante e `modality_tier`.
2. **Validação prévia** (mensagens de erro claras): evento inexistente → `404`; evento que já terminou (`end_at` no passado) → `400 Event has already ended` (D25); `SOLD_OUT` ou sem vagas → `409 Event is sold out` (D11); `CANCELLED` ou `FINISHED` → `400 Event is not open for registrations`; documento já inscrito → `409` (D3).
3. **Transação única** no `events_tickets_db`:
   * Reserva a vaga com `UPDATE` condicional (`status = 'PUBLISHED' AND available_spots > 0 AND end_at > now()`), mudando para `SOLD_OUT` ao zerar. Se nenhuma linha mudar, `409`.
   * Salva o ingresso `CONFIRMED` com `ticket_code` e `event_snapshot`.
   * Grava `ticket.issued` e `event.spot_reserved` na outbox.
4. Qualquer falha desfaz tudo, inclusive a reserva. Inscrição simultânea duplicada é barrada pelo índice único (`409`).

### Fluxo 2: Cancelamento de Inscrição/Ingresso (`DELETE /tickets/{id}`)

Em uma transação: muda o status para `CANCELLED` com `UPDATE` condicional, devolve a vaga (`SOLD_OUT` volta a `PUBLISHED`) e grava `ticket.cancelled` e `event.spot_released`.

### Fluxo 3: Cancelamento ou Remoção de Evento

Em uma transação: trava o evento, cancela os ingressos ativos sem devolver vagas, atualiza ou remove o evento e grava `event.cancelled`/`event.deleted` e um `ticket.cancelled` por ingresso (D22).

### Fluxo 4: Registro de Atividades (assíncrono)

O `events-tickets-service` publica as mensagens pendentes da outbox a cada segundo em `events-tickets.exchange`, em lotes de 50 e com confirmação do broker; com acúmulo, os lotes seguintes saem em sequência (D28). O `logs-service` consome a fila `logs.activity`, grava e confirma (D20).

### Fluxo 5: Histórico (síncrono)

`GET /events/{id}/history` ou `GET /tickets/{id}/history` chamam `GET http://logs-service:8000/logs?entity_type=...&entity_id=...&order=asc&limit=...&offset=...`, com timeout de 3 s, e devolvem `total` a partir do `X-Total-Count` (D26). Falha → `503 Logs service unavailable`, sem afetar o resto da API (D21).

## 7. Estrutura de Diretórios Modularizada Esperada

```
events-tickets-ms/
├── docker-compose.yml                        # Orquestração dos 8 contêineres
├── README.md                                 # Guia de execução e demonstração
├── frontend/                                 # Aplicação web estática, servida pelo gateway em /app/
├── gateway/nginx.conf                        # API Gateway
├── messaging/rabbitmq.conf                   # Prefixo da interface do RabbitMQ
├── observability/                            # Prometheus e Grafana provisionados
├── docs/                                     # Toda a documentação do projeto
│   ├── prompt.md · AGENTS.md · arquitetura.md · contratos-api.md · decisoes.md
│   └── guia-da-implementacao.md · roteiro-apresentacao.md
└── microservices/
    ├── events-tickets-service/               # Microsserviço A (Node.js + NestJS + TypeORM)
    │   ├── Dockerfile · package.json · package-lock.json · tsconfig*.json · nest-cli.json
    │   └── src/                              # Testes Jest (*.spec.ts) ao lado do código
    │       ├── main.ts                       # Bootstrap, ValidationPipe e Swagger
    │       ├── app.module.ts
    │       ├── config/typeorm.config.ts
    │       ├── common/                       # Erro padrão, validações e erros do PostgreSQL
    │       ├── database/database.module.ts   # Repositórios das três tabelas
    │       ├── events/                       # Controller, service, repository, entidade e DTOs
    │       ├── tickets/                      # Controller, service, repository, entidade e DTOs
    │       ├── outbox/                       # Entidade, repositório, mensagens e publicador RabbitMQ
    │       ├── logs-integration/             # Cliente HTTP do histórico (logs-service)
    │       ├── metrics/                      # /health, /metrics, logs e X-Correlation-Id
    │       └── testing/                      # Dublês usados pelos testes
    │
    └── logs-service/                         # Microsserviço B (Python + FastAPI + SQLAlchemy)
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

As fases abaixo construíram a versão 1, com `events-service` (Python) e `tickets-service` (NestJS) separados e comunicação HTTP para reservar e devolver vagas. Foram concluídas e substituídas pela fase 8; ficam aqui como registro.

* **Fase 1:** `events-service` em FastAPI, com CRUD de eventos, reserva e devolução atômicas de vagas, Swagger, telemetria e testes `pytest`.
* **Fase 2:** `tickets-service` em NestJS, com CRUD de ingressos, cliente HTTP para o Serviço A, compensações, Swagger, métricas e testes Jest.
* **Fase 3:** `docker-compose.yml` com os 4 contêineres (dois serviços e dois bancos), healthchecks e rede `events-tickets-network`.
* **Fase 4:** `README.md` com guia de execução em máquina limpa e roteiro de demonstração.

## 9. Adequação ao Edital (Fases 5 a 7)

O edital do trabalho (`trabalho_cd.pdf`) pontua itens que a especificação original não previa.

### Pontuação do edital

| Item | Pontos | Atendido por |
|---|---|---|
| Heterogeneidade e CRUDs | 2,0 | `events-tickets-service` (NestJS) e `logs-service` (Python), ambos com CRUD completo |
| Banco por serviço | 1,0 | `events-tickets-db` e `logs-db` |
| Conteinerização e orquestração | 1,0 | Dockerfiles e `docker-compose.yml` |
| API Gateway | 1,0 | Fase 5 |
| Observabilidade com ferramentas especializadas | 1,0 | Fase 6 (Prometheus e Grafana; o `logs-service` não substitui este item) |
| Mensageria assíncrona (bônus) | +1,0 | Fase 7, ampliada na fase 8 |
| Apresentação síncrona, de até 30 min | 4,0 | Até 21/11; a nota do código depende dela |

A apresentação deve conter a contextualização do problema (incluindo a justificativa da divisão dos microsserviços), os detalhes da arquitetura e a demonstração prática: build a partir do repositório em máquina limpa, rotas, persistência e coleta de telemetria.

### 🔹 FASE 5: API Gateway (`gateway/nginx.conf`)

Contêiner `api-gateway` (NGINX) como única porta de entrada, em `8080`. Serviços e bancos ficam sem porta no host. O gateway usa lista de rotas permitidas (D13, D14).

### 🔹 FASE 6: Observabilidade

Contêineres `prometheus` e `grafana`, com coleta das métricas dos dois serviços e painel já configurado no repositório, sem passo manual. Ambos são acessados pelo gateway, em `/prometheus/` e `/grafana/` (D15).

### 🔹 FASE 7: Mensageria Assíncrona

Contêiner `rabbitmq`, com publicação por outbox gravada na mesma transação da mudança (D16). Na versão 1, cancelar ou remover um evento cancelava os ingressos de forma assíncrona; na fase 8, a mensageria passou a levar o registro de atividades ao `logs-service` (D20).

## 10. Fase 8: Reestruturação em `events-tickets-service` + `logs-service`

Objetivo: juntar eventos e ingressos em um único microsserviço e criar o microsserviço de logs, de modo que toda a comunicação distribuída aconteça entre os dois (D18).

* **Passo 8.1:** portar o módulo de eventos para o NestJS (entidade, DTOs com fuso obrigatório, repositório com `UPDATE` condicional de vagas, serviço e controller) e unir ao módulo de ingressos no `events-tickets-service`.
* **Passo 8.2:** emissão e cancelamento de ingresso em transação única; cancelamento e remoção de evento cancelam os ingressos na mesma transação (D22).
* **Passo 8.3:** outbox para toda atividade, com publicador `amqplib` em canal de confirmação e `mandatory` (D20).
* **Passo 8.4:** `logs-service` em FastAPI: CRUD com campos imutáveis, triagem e arquivamento (D19), consumidor `pika` idempotente com DLQ.
* **Passo 8.5:** rotas `/history` com cliente HTTP, timeout e `503` (D21).
* **Passo 8.6:** `docker-compose.yml`, `nginx.conf`, `prometheus.yml` e painel do Grafana com os novos serviços.
* **Passo 8.7:** testes Jest e `pytest`, validação em contêiner e atualização de toda a documentação.

## 11. Fase 9: Aplicação web

Objetivo: dar ao sistema uma aplicação web que use as rotas públicas e mostre a comunicação entre os componentes, sem novo contêiner (D24).

* **Passo 9.1:** página estática em `frontend/` (HTML, CSS e módulos JavaScript, sem build nem CDN), servida pelo `api-gateway` em `/app/`, com `/` redirecionando para lá.
* **Passo 9.2:** CRUD de eventos, ingressos e registros de atividade, mais um teste de concorrência que dispara várias inscrições ao mesmo tempo.
* **Passo 9.3:** diagrama dos 8 contêineres com a saúde de cada um, animação das chamadas e rastro por `X-Correlation-Id`, com a parte assíncrona confirmada pelo `logs-service`.

## 12. Fase 10: Desempenho, resiliência e evento encerrado

Objetivo: corrigir os gargalos encontrados na revisão do projeto e impedir inscrições em eventos encerrados (D25 a D28).

* **Passo 10.1:** inscrição recusada em evento inexistente (`404`) ou já encerrado (`400 Event has already ended`), também no `UPDATE` condicional da reserva (D25).
* **Passo 10.2:** paginação com `limit`, `offset` e `X-Total-Count` em `GET /events`, `GET /tickets` e `GET /logs`, e históricos paginados com `total` (D26).
* **Passo 10.3:** `restart: unless-stopped` nos 8 contêineres, e `api-gateway` e `prometheus` sem depender do `logs-service` (D27).
* **Passo 10.4:** publicador da outbox com lotes em sequência, conexão fora da transação e métrica do acúmulo total; reserva e devolução de vaga com `RETURNING` (D28).
