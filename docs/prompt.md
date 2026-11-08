# 🚀 CONTEXTO DO PROJETO E DIRETRIZES PARA O AGENTE DE IA (MASTER PROMPT)

## 1. Papel do Agente de IA (System Persona)

Você atua como um **Arquiteto de Sistemas Distribuídos Sênior e Engenheiro de Software Full-Cycle**. Sua missão é me guiar e implementar um sistema distribuído completo, limpo, modular, documentado com Swagger e 100% conteinerizado (`events-tickets-ms`) para um Trabalho Prático da disciplina de **Sistemas Distribuídos (UFMS)**.

**Regras de Ouro para geração de código:**

1. **Topologia de Contêineres:** O núcleo do ambiente Docker são os **4 contêineres** abaixo, acrescidos da infraestrutura exigida pelo edital (seção 9):
   * `events-db` (Banco PostgreSQL exclusivo do Microsserviço A)
   * `events-service` (Microsserviço A em Python + FastAPI)
   * `tickets-db` (Banco PostgreSQL exclusivo do Microsserviço B)
   * `tickets-service` (Microsserviço B em Node.js + NestJS)

2. **Pragmatismo e Execução Limpa ("Clean Machine Ready"):** O projeto será avaliado em uma máquina limpa apenas com `git clone` e `docker compose up --build`. Não crie dependências manuais externas. Tudo deve subir orquestrado e pré-configurado.

3. **Alta Modularização e Boas Práticas:** Ambos os microsserviços devem ter responsabilidades bem separadas em camadas/módulos (Controllers/Routers, Services, Repositories/Entities, DTOs/Schemas, Integrations e Metrics).

4. **Swagger (OpenAPI 3.0) Obrigatório nas Duas APIs:** Ambos os microsserviços devem expor interface gráfica interativa do **Swagger UI**, acessível pelo API Gateway em `/docs/events` e `/docs/tickets` (D14), com todos os endpoints, DTOs/Schemas, exemplos de payload e códigos de resposta HTTP devidamente documentados.

5. **Código didático e rastreável:** Adicione logs claros e estruturados no console (ex: `[HTTP SYNC REQUEST]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]`, `[TELEMETRY]`) para facilitar a demonstração ao vivo durante a apresentação do trabalho.

6. **NUNCA faça `git commit` nem `git push`:** O agente nunca executa commit nem push, em nenhuma circunstância. Ao concluir uma entrega, apenas informe a frase de commit sugerida; o autor do projeto faz o commit e o push.

7. **Documentação viva em `docs/`:** Toda a documentação do projeto fica em `docs/`, inclusive este arquivo e o `AGENTS.md`; a única exceção é o `README.md`, que fica na raiz para o GitHub e para a entrega. Mudou um contrato, fluxo ou decisão? Atualize o documento correspondente na mesma entrega. As decisões que refinam esta especificação estão em `docs/decisoes.md`.

## 2. Requisitos Obrigatórios do Projeto

* [x] **1. Heterogeneidade e Serviços CRUD:** Dois microsserviços distintos com operações CRUD completas (`Create`, `Read`, `Update`, `Delete`), escritos em **linguagens/ecossistemas diferentes** (Python/FastAPI e TypeScript/Node.js com NestJS).
* [x] **2. Descentralização de Dados (Database per Service):** Cada microsserviço deve possuir e acessar exclusivamente sua própria instância/contêiner de banco de dados PostgreSQL isolada (`events-db` e `tickets-db`). É estritamente proibido compartilhar a mesma instância de banco entre os dois serviços.
* [x] **3. Conteinerização e Orquestração (4 Contêineres):** `Dockerfile` individual para cada microsserviço e um `docker-compose.yml` na raiz que orquestre os 2 microsserviços e os 2 bancos de dados isolados em uma rede interna (`events-tickets-network`).
* [x] **4. Comunicação entre Serviços (REST/HTTP JSON):** Comunicação padronizada entre `tickets-service` e `events-service` via chamadas HTTP síncronas para validação de disponibilidade de evento, reserva de vaga na emissão do ingresso e devolução de vaga no cancelamento.
* [x] **5. Documentação Interativa (Swagger / OpenAPI):** Swagger UI configurado e acessível em ambos os microsserviços (`/docs`) para testes diretos pelo navegador e validação das rotas durante a apresentação.
* [x] **6. Observabilidade e Telemetria Integrada:** Coleta de métricas de requisições, latência e saúde da aplicação diretamente nos microsserviços (expondo `/metrics` no padrão Prometheus e logs estruturados de rastreamento de chamadas entre serviços).

## 3. Visão do Produto: `events-tickets-ms`

Vamos construir o **`events-tickets-ms`**, uma plataforma distribuída *white-label* (genérica e agnóstica a nicho) para **Gestão de Eventos e Emissão Unificada de Inscrições/Ingressos**.

* **Por que Eventos Genéricos?** O sistema não é travado em um único tema. Ele pode gerenciar desde um simpósio acadêmico na universidade, um workshop online, um show musical, até uma corrida de rua ou campeonato de e-sports.
* **Por que Inscrição e Ingresso Unificados?** No nosso domínio, realizar uma **Inscrição** e emitir um **Ingresso/Credencial** representam a mesma entidade transacional (`Ticket`). Quando um participante se inscreve em um evento, o sistema valida a disponibilidade de vaga no serviço de eventos, reserva a vaga e emite um ingresso digital único com código verificável e controle de presença (*check-in*).

## 4. Topologia da Arquitetura (4 Contêineres) e Stack Tecnológica

```
               [ Navegador (Swagger UI /docs) / Insomnia / Postman / cURL ]
                               |                                  |
                  (Porta :8000)|                                  |(Porta :3000)
                               v                                  v
       +---------------------------------------+  +---------------------------------------+
       |      CONTÊINER 1: events-service      |  |     CONTÊINER 3: tickets-service      |
       |    (Python 3.11 + FastAPI + SQLA)     |  |    (Node.js 20 + NestJS + TypeORM)    |
       |  - CRUD de Eventos (/events)          |  |  - CRUD de Ingressos (/tickets)       |
       |  - Controle de Vagas (/reserve|/release)| |  - Valida e Reserva Vaga no Serviço A |
       |  - Swagger UI: :8000/docs             |  |  - Swagger UI: :3000/docs             |
       |  - Telemetria: :8000/metrics          |  |  - Telemetria: :3000/metrics          |
       +---------------------------------------+  +---------------------------------------+
          |                                ^          |                                |
          | SQLAlchemy                     |          | Comunicação HTTP REST (JSON)   | TypeORM
          | (Porta interna 5432)           +----------+ (Rede: events-tickets-network) | (Porta interna 5432)
          v                                  1. GET /events/{id} (Valida)              v
       +---------------------------------------+  2. PATCH /events/{id}/reserve-spot +---------------------------------------+
       |        CONTÊINER 2: events-db         |  3. PATCH /events/{id}/release-spot |        CONTÊINER 4: tickets-db        |
       |     PostgreSQL 16 (Banco Isolado 1)   |                                     |     PostgreSQL 16 (Banco Isolado 2)   |
       |        Database: events_db            |                                     |        Database: tickets_db           |
       +---------------------------------------+                                     +---------------------------------------+
```

### Stack Definida:

* **Microsserviço A (`events-service` - Porta `8000`):** Python 3.11 + FastAPI + SQLAlchemy 2.0 + Pydantic v2 + Swagger UI Nativo (`/docs`) + Prometheus Instrumentator (`/metrics`).
* **Banco de Dados A (`events-db` - Porta Externa `5433` -> Interna `5432`):** PostgreSQL 16 (`events_db`).
* **Microsserviço B (`tickets-service` - Porta `3000`):** Node.js 20 + NestJS (TypeScript) + TypeORM + `@nestjs/swagger` (`/docs`) + `prom-client` (`/metrics`).
* **Banco de Dados B (`tickets-db` - Porta Externa `5434` -> Interna `5432`):** PostgreSQL 16 (`tickets_db`).

## 5. Especificação Detalhada dos Microsserviços e Swagger

### 5.1. Microsserviço A: `events-service` (Catálogo e Controle de Capacidade)

Responsável pelo ciclo de vida de qualquer tipo de evento e pela verdade absoluta sobre a capacidade e vagas disponíveis.

* **Tecnologia:** Python 3.11 + FastAPI + SQLAlchemy + PostgreSQL (`events_db`).
* **Documentação Swagger:** Acessível em `http://localhost:8000/docs` e OpenAPI JSON em `http://localhost:8000/openapi.json`.
* **Modelo de Dados (Tabela `events`):**
  * `id` (UUID, PK)
  * `title` (String, obrigatório) — *Ex: "Semana da Computação UFMS", "Festival de Música Indie", "Workshop Docker"*
  * `description` (Text, opcional)
  * `category` (String) — *Ex: "ACADEMIC", "CONCERT", "WORKSHOP", "SPORTS", "GENERAL"*
  * `modality` (Enum/String) — `"IN_PERSON"`, `"ONLINE"`, `"HYBRID"`
  * `location` (String) — *Endereço físico ou link da transmissão*
  * `start_at` (DateTime ISO 8601)
  * `end_at` (DateTime ISO 8601)
  * `max_capacity` (Integer, $> 0$) — *Capacidade total do evento*
  * `available_spots` (Integer, $\ge 0$) — *Inicia igual a `max_capacity`*
  * `status` (Enum/String) — `"PUBLISHED"`, `"SOLD_OUT"`, `"CANCELLED"`, `"FINISHED"`
  * `metadata_info` (JSONB, opcional) — *Atributos livres para tornar o evento genérico (ex: palestrante, carga horária, classificação)*
  * `created_at` / `updated_at` (DateTime)

* **Endpoints Obrigatórios (Todos documentados no Swagger):**
  1. `POST /events` — Cria um novo evento (`available_spots` inicia igual a `max_capacity`, status padrão `"PUBLISHED"`).
  2. `GET /events` — Lista todos os eventos (com filtros opcionais de query `?category=...&status=...`).
  3. `GET /events/{id}` — Busca detalhes de um evento específico (**usado também na validação pelo Serviço B**).
  4. `PUT /events/{id}` — Atualiza dados do evento (título, local, datas, capacidade máxima, status). Se `max_capacity` mudar, preserva as vagas ocupadas: `available_spots = novo max_capacity - (max_capacity atual - available_spots)`. Retorna `409 Conflict` se a nova capacidade for menor que as vagas ocupadas (D2).
  5. `DELETE /events/{id}` — Remove um evento do banco de dados.
  6. `PATCH /events/{id}/reserve-spot` — **Endpoint de Integração Entre Serviços:** Decrementa `available_spots` em $1$. Se `available_spots == 0`, altera `status` automaticamente para `"SOLD_OUT"`. Retorna erro `409 Conflict` se não houver vagas.
  7. `PATCH /events/{id}/release-spot` — **Endpoint de Integração Entre Serviços:** Incrementa `available_spots` em $1$ (até o limite `max_capacity`). Se o status era `"SOLD_OUT"` e agora `available_spots > 0`, retorna o `status` automaticamente para `"PUBLISHED"`.
  8. `GET /health` e `GET /metrics` — Endpoints de saúde e telemetria/métricas.

### 5.2. Microsserviço B: `tickets-service` (Inscrições e Emissão de Ingressos)

Unifica o conceito de inscrição e ingresso. Cada registro representa a participação confirmada de uma pessoa em um evento, gerando um código único de credencial/ingresso.

* **Tecnologia:** Node.js + NestJS (TypeScript) + TypeORM + PostgreSQL (`tickets_db`).
* **Documentação Swagger:** Configurada com `@nestjs/swagger` e acessível em `http://localhost:3000/docs`.
* **Modelo de Dados (Entidade TypeORM `Ticket` / Tabela `tickets`):**
  * `id` (UUID, `@PrimaryGeneratedColumn('uuid')`)
  * `ticket_code` (String, `@Column({ unique: true })`, gerado automaticamente) — *Ex: `EVT-2026-A8F9K2`*
  * `event_id` (UUID String, `@Column()`, referência lógica ao ID do evento no Serviço A)
  * `event_snapshot` (JSONB, `@Column({ type: 'jsonb' })` contendo `{ title, category, modality, location, start_at }` capturados do Serviço A no momento da inscrição para evitar joins entre bancos distintos)
  * `participant_name` (String, `@Column()`)
  * `participant_email` (String, `@Column()`)
  * `participant_document` (String, `@Column()`, CPF/RG/Matrícula)
  * `modality_tier` (String, `@Column({ default: 'STANDARD' })`) — *Ex: "VIP", "ESTUDANTE", "OUVINTE", "LOTE_1"*
  * `status` (Enum/String, `@Column({ default: 'CONFIRMED' })`) — `"CONFIRMED"` (inscrito/ingresso ativo), `"CHECKED_IN"` (presença validada no evento), `"CANCELLED"` (inscrição cancelada)
  * `created_at` (`@CreateDateColumn()`) / `updated_at` (`@UpdateDateColumn()`)

* **Endpoints Obrigatórios (Todos documentados no Swagger):**
  1. `POST /tickets` — **Realiza a inscrição / emite o ingresso** (Executa o fluxo de comunicação com o Serviço A detalhado na Seção 6).
  2. `GET /tickets` — Lista todas as inscrições/ingressos emitidos (aceita query params opcionais `?event_id=...`, `?participant_email=...` e `?status=...`).
  3. `GET /tickets/:id` — Consulta um ingresso específico por `id` (UUID) ou `ticket_code`.
  4. `PUT /tickets/:id` — Atualiza os dados do participante, categoria (`modality_tier`) ou realiza o **Check-in** (`status: "CHECKED_IN"`).
  5. `DELETE /tickets/:id` — **Cancela a inscrição/ingresso** (soft delete: altera o status para `"CANCELLED"`, mantém o registro e chama o Serviço A para devolver a vaga ao evento; repetir o cancelamento retorna `409 Conflict`) (D1).
  6. `GET /health` e `GET /metrics` — Endpoints de saúde e telemetria/métricas.

## 6. Fluxos de Comunicação Entre os Microsserviços

### Fluxo 1: Emissão de Inscrição/Ingresso (`POST /tickets`)

1. **Cliente** envia `POST /tickets` passando `event_id`, dados do participante e `modality_tier`.
2. **Validação no Serviço A (`EventsClientService` no NestJS):**
   * O `tickets-service` faz `GET http://events-service:8000/events/{event_id}`.
   * Se o evento não existir (`404`), lança `NotFoundException` (`404 Event not found`).
   * Se `status === "SOLD_OUT"` ou `available_spots <= 0` em evento publicado, lança `ConflictException` (`409 Event is sold out`) (D11).
   * Se `status` for `"CANCELLED"` ou `"FINISHED"`, lança `BadRequestException` (`400 Event is not open for registrations`).
   * Se já existir ingresso não cancelado com o mesmo `participant_document` no evento, lança `ConflictException` (`409 Participant already registered for this event`) (D3).
3. **Reserva de Vaga no Serviço A:**
   * O `tickets-service` envia `PATCH http://events-service:8000/events/{event_id}/reserve-spot`.
   * O `events-service` decrementa `available_spots = available_spots - 1` no `events_db` (e muda o status para `"SOLD_OUT"` caso chegue a `0`).
4. **Persistência Local no Serviço B (`tickets_db`):**
   * O `TicketsService` gera o `ticket_code` único (`EVT-2026-XXXXXX`), monta o `event_snapshot` com os dados recebidos do Serviço A e salva o ingresso no PostgreSQL (`tickets_db`) com status `"CONFIRMED"`.
   * *(Resiliência/Compensação)*: Se ocorrer erro inesperado ao salvar no `tickets_db`, o `tickets-service` chama `PATCH /events/{event_id}/release-spot` para estornar a vaga reservada.

### Fluxo 2: Cancelamento de Inscrição/Ingresso (`DELETE /tickets/:id`)

1. **Cliente** solicita o cancelamento da inscrição via `DELETE /tickets/:id`.
2. O `tickets-service` verifica se o ingresso existe e se ainda não está cancelado.
3. Atualiza o status do ingresso para `"CANCELLED"`, mantendo o registro no `tickets_db`.
4. **Devolução de Vaga ao Serviço A:**
   * O `tickets-service` envia `PATCH http://events-service:8000/events/{event_id}/release-spot`.
   * O `events-service` incrementa `available_spots = available_spots + 1` no `events_db`. Se o evento estava `"SOLD_OUT"`, volta automaticamente para `"PUBLISHED"`.

## 7. Estrutura de Diretórios Modularizada Esperada

O repositório raiz deve se chamar **`events-tickets-ms/`** e o diretório principal dos serviços deve se chamar **`microservices/`**, seguindo estritamente a organização modular abaixo:

```
events-tickets-ms/
├── docker-compose.yml                        # Orquestração dos 4 contêineres (2 Serviços + 2 Bancos)
├── README.md                                 # Documentação completa, arquitetura e guia de testes
├── docs/                                     # Toda a documentação do projeto
│   ├── prompt.md                             # Este arquivo de contexto arquitetural
│   ├── AGENTS.md                             # Regras para agentes de código
│   ├── arquitetura.md                        # Arquitetura e estado da implementação
│   ├── contratos-api.md                      # Contratos REST, regras e erros
│   └── decisoes.md                           # Decisões que refinam a especificação
└── microservices/
    ├── events-service/                       # CONTÊINER 1: Microsserviço A (Python + FastAPI)
    │   ├── Dockerfile
    │   ├── requirements.txt
    │   ├── requirements-dev.txt              # Dependências de teste (pytest), fora da imagem
    │   ├── tests/                            # Testes das regras de vagas (pytest)
    │   └── app/
    │       ├── main.py                       # Bootstrap FastAPI, Configuração do Swagger UI e Telemetria
    │       ├── core/
    │       │   ├── config.py                 # Variáveis de ambiente (Pydantic Settings)
    │       │   ├── database.py               # Engine, SessionLocal e Base do SQLAlchemy (events_db)
    │       │   └── telemetry.py              # Middleware de logs estruturados e métricas Prometheus
    │       └── modules/
    │           └── events/
    │               ├── router.py             # Endpoints REST (/events) documentados para o Swagger
    │               ├── service.py            # Regras de negócio de Eventos e controle de vagas
    │               ├── repository.py         # Operações de banco de dados (CRUD SQLAlchemy)
    │               ├── models.py             # Model ORM (Tabela events)
    │               └── schemas.py            # Schemas Pydantic v2 com exemplos para o Swagger
    │
    └── tickets-service/                      # CONTÊINER 3: Microsserviço B (Node.js + NestJS + TypeORM)
        ├── Dockerfile
        ├── package.json
        ├── tsconfig.json
        ├── nest-cli.json
        └── src/                              # Testes Jest (*.spec.ts) ficam ao lado do código testado
            ├── main.ts                       # Bootstrap NestJS, ValidationPipe global e SwaggerModule (/docs)
            ├── app.module.ts                 # Módulo Raiz (TypeOrmModule, TicketsModule, MetricsModule, etc.)
            ├── config/
            │   └── typeorm.config.ts         # Configuração de conexão PostgreSQL (tickets_db)
            ├── tickets/                      # Módulo de Domínio de Ingressos/Inscrições
            │   ├── tickets.module.ts
            │   ├── tickets.controller.ts     # Rotas REST CRUD (/tickets) com Decorators @ApiTags, @ApiOperation
            │   ├── tickets.service.ts        # Regras de negócio + integração síncrona com EventsService
            │   ├── entities/
            │   │   └── ticket.entity.ts      # Entidade TypeORM (Tabela tickets) anotada com @ApiProperty
            │   └── dto/
            │       ├── create-ticket.dto.ts  # Validações (class-validator) + @ApiProperty para o Swagger
            │       └── update-ticket.dto.ts  # DTO de atualização e check-in documentado no Swagger
            ├── events-integration/           # Módulo isolado para Comunicação HTTP com o Serviço A
            │   ├── events-integration.module.ts
            │   └── events-client.service.ts  # Cliente HTTP (@nestjs/axios) para consultar/reservar/liberar vagas
            └── metrics/                      # Módulo de Observabilidade e Telemetria
                ├── metrics.module.ts
                ├── metrics.service.ts        # Contadores e histogramas HTTP / Negócio (prom-client)
                ├── metrics.controller.ts     # Exposição de GET /metrics e GET /health
                ├── logging.interceptor.ts    # Interceptor NestJS para logar latência e tráfego HTTP
                └── telemetry.ts              # Logs estruturados e X-Correlation-Id
```

## 8. Plano de Execução Detalhado Passo a Passo (Fases de Desenvolvimento)

Quando eu pedir para você iniciar ou avançar no projeto, siga rigorosamente esta ordem de implementação modular:

### 🔹 FASE 1: Microsserviço A (`microservices/events-service` - Python + FastAPI + PostgreSQL)

Objetivo: Construir o microsserviço completo de gestão de eventos, modularizado, com Swagger enriquecido e telemetria.

* **Passo 1.1 (Dependências e Contêiner):**
  * Criar `requirements.txt` com `fastapi`, `uvicorn[standard]`, `sqlalchemy`, `psycopg2-binary`, `pydantic`, `pydantic-settings`, `prometheus-fastapi-instrumentator`.
  * Criar `Dockerfile` baseado em `python:3.11-slim`, otimizado e expondo a porta `8000`.
* **Passo 1.2 (Core e Banco de Dados):**
  * Criar `app/core/config.py` lendo `DATABASE_URL`, `PORT` e `SERVICE_NAME`.
  * Criar `app/core/database.py` com a configuração do `SQLAlchemy` (`create_engine`, `SessionLocal`, `Base` e dependency `get_db`).
* **Passo 1.3 (Modelagem e Schemas com Exemplos para o Swagger):**
  * Criar `app/modules/events/models.py` definindo a tabela `events` com enums (`EventModality`, `EventStatus`), campos de controle de vagas (`max_capacity`, `available_spots`) e `metadata_info` (JSON).
  * Criar `app/modules/events/schemas.py` com `EventCreate`, `EventUpdate`, `EventResponse`. Adicionar `model_config = ConfigDict(from_attributes=True, json_schema_extra={"example": ...})` em todos os schemas para que o **Swagger UI** preencha exemplos reais automaticamente.
* **Passo 1.4 (Camadas de Repositório e Serviço):**
  * Criar `app/modules/events/repository.py` encapsulando todas as queries SQLAlchemy (`create`, `get_all`, `get_by_id`, `update`, `delete`).
  * Criar `app/modules/events/service.py` implementando as regras de negócio: inicialização de `available_spots`, bloqueio de capacidade negativa, lógica atômica de `reserve_spot` (mudando para `"SOLD_OUT"` ao zerar vagas) e `release_spot` (voltando para `"PUBLISHED"` quando aplicável).
* **Passo 1.5 (Rotas e Documentação Swagger):**
  * Criar `app/modules/events/router.py` expondo `POST /events`, `GET /events`, `GET /events/{id}`, `PUT /events/{id}`, `DELETE /events/{id}`, `PATCH /events/{id}/reserve-spot` e `PATCH /events/{id}/release-spot`.
  * Documentar cada rota com `summary`, `description`, `status_code` e `responses` detalhados para o Swagger.
* **Passo 1.6 (Observabilidade e Bootstrap `main.py`):**
  * Criar `app/core/telemetry.py` com middleware de logs estruturados (exibindo método, rota, status HTTP e tempo de execução em `ms`) e métricas customizadas.
  * Criar `app/main.py` configurando os metadados do OpenAPI/Swagger (`title="events-tickets-ms - Events Microservice API"`, `version="1.0.0"`, `docs_url="/docs"`), criando as tabelas no startup (`Base.metadata.create_all`), expondo `GET /health` e inicializando o `Instrumentator().instrument(app).expose(app, endpoint="/metrics")`.

* **Passo 1.7 (Testes das Regras):**
  * Criar `requirements-dev.txt` e `tests/` com testes `pytest` enxutos de reserva, devolução, transição `SOLD_OUT`/`PUBLISHED` e alteração de capacidade (D4).

### 🔹 FASE 2: Microsserviço B (`microservices/tickets-service` - Node.js + NestJS + TypeORM + PostgreSQL)

Objetivo: Construir o microsserviço de inscrições e emissão de ingressos seguindo a arquitetura modular do NestJS, integrado ao Serviço A e documentado com `@nestjs/swagger`.

* **Passo 2.1 (Configuração do Projeto NestJS e Contêiner):**
  * Criar `package.json` (`name: "tickets-service"`) incluindo `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/typeorm`, `typeorm`, `pg`, `@nestjs/axios`, `axios`, `@nestjs/swagger`, `class-validator`, `class-transformer`, `prom-client`.
  * Criar `tsconfig.json`, `nest-cli.json` e `Dockerfile` multi-stage ou otimizado em `node:20-alpine` expondo a porta `3000`.
* **Passo 2.2 (Configuração do Banco de Dados TypeORM):**
  * Criar `src/config/typeorm.config.ts` lendo `DATABASE_URL` (ou host/port/user/pass/db do `tickets-db`), com `synchronize: true` e `autoLoadEntities: true` para criar a tabela automaticamente ao subir o contêiner.
* **Passo 2.3 (Entidade e DTOs Documentados com `@nestjs/swagger`):**
  * Criar `src/tickets/entities/ticket.entity.ts` com a entidade `Ticket` mapeada pelo TypeORM e anotada com `@ApiProperty()` para exibição do schema no Swagger.
  * Criar `src/tickets/dto/create-ticket.dto.ts` e `src/tickets/dto/update-ticket.dto.ts` usando validações do `class-validator` (`@IsUUID()`, `@IsNotEmpty()`, `@IsEmail()`, `@IsOptional()`, `@IsEnum()`) e `@ApiProperty({ description: '...', example: '...' })` em cada campo.
* **Passo 2.4 (Módulo de Integração HTTP Síncrona - `events-integration/`):**
  * Criar `src/events-integration/events-integration.module.ts` (importando `HttpModule` do `@nestjs/axios`).
  * Criar `src/events-integration/events-client.service.ts` implementando 3 métodos claros e logados no console:
    1. `getEventById(eventId: string)`: Consulta `GET http://events-service:8000/events/{id}`.
    2. `reserveSpot(eventId: string)`: Envia `PATCH http://events-service:8000/events/{id}/reserve-spot`.
    3. `releaseSpot(eventId: string)`: Envia `PATCH http://events-service:8000/events/{id}/release-spot`.
* **Passo 2.5 (Módulo de Domínio de Ingressos - `tickets/`):**
  * Criar `src/tickets/tickets.service.ts` implementando o CRUD completo, geração automática do código `EVT-2026-XXXXXX`, salvamento do `event_snapshot` e orquestração com `EventsClientService` na criação (`POST`) e no cancelamento (`DELETE`).
  * Criar `src/tickets/tickets.controller.ts` com todas as rotas CRUD anotadas com `@ApiTags('Tickets (Inscrições e Ingressos)')`, `@ApiOperation()`, `@ApiParam()`, `@ApiQuery()` e `@ApiResponse()` (`201`, `200`, `400`, `404`, `409`).
  * Criar `src/tickets/tickets.module.ts`.
* **Passo 2.6 (Módulo de Observabilidade e Bootstrap `main.ts`):**
  * Criar `src/metrics/` (`metrics.module.ts`, `metrics.service.ts`, `metrics.controller.ts` e `logging.interceptor.ts`) expondo `GET /metrics` (com métricas padrão do Node.js + contador de ingressos emitidos/cancelados) e `GET /health`.
  * Criar `src/app.module.ts` e `src/main.ts` ativando `ValidationPipe` global, CORS e configurando o **Swagger UI** na rota `/docs` (`title: "events-tickets-ms - Tickets Microservice API"`) via `DocumentBuilder` e `SwaggerModule.setup('docs', app, document)`.

* **Passo 2.7 (Testes das Regras):**
  * Criar testes Jest (`*.spec.ts`) dos fluxos de emissão e cancelamento, com `EventsClientService` simulado, cobrindo validações, duplicidade e compensações (D4).

### 🔹 FASE 3: Orquestração dos 4 Contêineres (`docker-compose.yml`)

Objetivo: Configurar a infraestrutura Docker enxuta, resiliente e isolada com exatamente **4 contêineres**.

* **Passo 3.1 (Bancos de Dados Isolados - Database per Service):**
  * Configurar o serviço `events-db` (imagem `postgres:16-alpine`, banco `events_db`, porta `5433:5432`, volume persistente `events_pgdata` e `healthcheck` com `pg_isready`).
  * Configurar o serviço `tickets-db` (imagem `postgres:16-alpine`, banco `tickets_db`, porta `5434:5432`, volume persistente `tickets_pgdata` e `healthcheck` com `pg_isready`).
* **Passo 3.2 (Microsserviços e Dependências de Inicialização):**
  * Configurar o serviço `events-service` apontando para `./microservices/events-service`, porta `8000:8000`, conectado ao `events-db` via `depends_on: { events-db: { condition: service_healthy } }`.
  * Configurar o serviço `tickets-service` apontando para `./microservices/tickets-service`, porta `3000:3000`, passando `EVENTS_SERVICE_URL=http://events-service:8000`, conectado ao `tickets-db` (`service_healthy`) e ao `events-service`.
* **Passo 3.3 (Rede Interna):**
  * Conectar os 4 contêineres na rede bridge dedicada `events-tickets-network` para resolução automática de DNS por nome de serviço (`events-service`, `events-db`, `tickets-service`, `tickets-db`).

### 🔹 FASE 4: Documentação (`README.md`) e Roteiro Prático de Apresentação

Objetivo: Entregar a documentação exigida no edital do trabalho para nota máxima na apresentação.

* **Passo 4.1 (Contextualização e Arquitetura):**
  * Explicar o domínio do **`events-tickets-ms`**, justificativa da separação dos dois microsserviços e diagrama da arquitetura dos 4 contêineres.
* **Passo 4.2 (Guia "Clean Machine"):**
  * Passo a passo de comandos (`git clone`, `cd events-tickets-ms`, `docker compose up --build -d`, verificação de logs e status dos 4 contêineres).
* **Passo 4.3 (Links do Swagger e Telemetria):**
  * Tabela rápida de acesso:
    * Swagger Eventos (FastAPI): `http://localhost:8000/docs`
    * Métricas Eventos: `http://localhost:8000/metrics`
    * Swagger Ingressos (NestJS): `http://localhost:3000/docs`
    * Métricas Ingressos: `http://localhost:3000/metrics`
* **Passo 4.4 (Roteiro de Demonstração Ao Vivo):**
  * Sequência exata de testes (via Swagger UI ou `curl`) demonstrando:
    1. Criação de um evento com `max_capacity: 2`.
    2. Emissão de 2 ingressos no `tickets-service` e verificação em tempo real do `available_spots` caindo para `0` e o status mudando para `"SOLD_OUT"` no `events-service`.
    3. Tentativa de emissão de um 3º ingresso sendo barrada com `409 Conflict (Event is sold out)`.
    4. Realização de Check-in (`PUT /tickets/:id`).
    5. Cancelamento de um ingresso (`DELETE /tickets/:id`) devolvendo a vaga automaticamente ao `events-service` (`available_spots: 1`, status `"PUBLISHED"`).
    6. Visualização da coleta de telemetria em `/metrics` e nos logs dos contêineres.

## 9. Adequação ao Edital (Fases 5 a 7)

O edital do trabalho (`trabalho_cd.pdf`) pontua itens que a especificação original não previa. **Esta seção prevalece sobre as seções anteriores** quanto a número de contêineres, portas expostas e URLs do Swagger.

### Pontuação do edital

| Item | Pontos | Atendido por |
|---|---|---|
| Heterogeneidade e CRUDs | 2,0 | Fases 1 e 2 |
| Banco por serviço | 1,0 | Fases 1 a 3 |
| Conteinerização e orquestração | 1,0 | Fase 3 |
| API Gateway | 1,0 | Fase 5 |
| Observabilidade com ferramentas especializadas | 1,0 | Fase 6 |
| Mensageria assíncrona (bônus) | +1,0 | Fase 7 |
| Apresentação síncrona, de até 30 min | 4,0 | Até 21/11; a nota do código depende dela |

A apresentação deve conter a contextualização do problema, os detalhes da arquitetura e a demonstração prática: build a partir do repositório em máquina limpa, rotas, persistência e coleta de telemetria.

### 🔹 FASE 5: API Gateway (`gateway/nginx.conf`)

Contêiner `api-gateway` (NGINX) como única porta de entrada, em `8080`. Serviços e bancos ficam sem porta no host. O gateway usa lista de rotas permitidas e não expõe `reserve-spot` nem `release-spot` (D13, D14).

### 🔹 FASE 6: Observabilidade

Contêineres `prometheus` e `grafana`, com coleta das métricas dos dois serviços e painel já configurado no repositório, sem passo manual. Ambos são acessados pelo gateway, em `/prometheus/` e `/grafana/` (D15).

### 🔹 FASE 7: Mensageria Assíncrona

Contêiner `rabbitmq`. Cancelar ou remover um evento publica uma mensagem, e o `tickets-service` cancela os ingressos do evento. A publicação passa por uma outbox gravada na transação do evento (D16), e um evento cancelado não pode ser reaberto (D17). A comunicação HTTP síncrona de reserva e devolução de vagas permanece.