# events-tickets-ms

Plataforma distribuída de gestão de eventos e emissão unificada de inscrições e ingressos, desenvolvida como Trabalho Prático da disciplina de Sistemas Distribuídos (UFMS).

O sistema é genérico: atende de simpósios acadêmicos e workshops online a shows, corridas de rua e campeonatos de e-sports. Inscrição e ingresso são a mesma entidade: ao se inscrever, o participante recebe um ingresso digital com código único e controle de presença (check-in).

> **Projeto em desenvolvimento.** Os dois microsserviços estão prontos, mas o `docker-compose.yml` ainda não existe. Veja o [estado atual](#estado-atual).

## Estado atual

| Fase | Entrega | Estado |
|---|---|---|
| 1 | `events-service` | Concluída |
| 2 | `tickets-service` | Concluída |
| 3 | `docker-compose.yml` com os 4 contêineres | Pendente |
| 4 | Guia final de execução e roteiro de demonstração | Pendente |

Os dois serviços já foram testados juntos em PostgreSQL 16. Os `Dockerfile`s estão escritos, mas as imagens ainda não foram construídas.

## Arquitetura

O ambiente final terá exatamente 4 contêineres: dois microsserviços em tecnologias diferentes, cada um com seu próprio banco de dados.

```mermaid
flowchart TB
    cliente["Swagger UI / curl / Postman"]
    subgraph rede["Rede Docker: events-tickets-network"]
        events["events-service<br/>FastAPI :8000"]
        tickets["tickets-service<br/>NestJS :3000"]
        eventsdb[("events-db<br/>events_db")]
        ticketsdb[("tickets-db<br/>tickets_db")]
    end
    cliente --> events
    cliente --> tickets
    tickets -->|"HTTP REST síncrono"| events
    events --> eventsdb
    tickets --> ticketsdb
```

| Componente | Tecnologia | Responsabilidade |
|---|---|---|
| `events-service` | Python 3.11, FastAPI, SQLAlchemy 2, Pydantic v2 | Catálogo de eventos e controle de vagas |
| `tickets-service` | Node.js 20, NestJS, TypeORM | Inscrições, ingressos e check-in |
| `events-db` | PostgreSQL 16 | Banco exclusivo do `events-service` |
| `tickets-db` | PostgreSQL 16 | Banco exclusivo do `tickets-service` |

### Por que dois serviços

- O `events-service` é a fonte da verdade sobre a capacidade dos eventos e não conhece os ingressos.
- O `tickets-service` guarda apenas uma referência ao evento e uma cópia dos dados capturados na inscrição (`event_snapshot`), o que evita consultas entre bancos.
- Somente o `tickets-service` chama o outro serviço, e sempre por HTTP.

## Principais fluxos

**Emissão de ingresso (`POST /tickets`):** o `tickets-service` valida o evento, verifica se o participante já está inscrito, reserva a vaga no `events-service` e salva o ingresso. Se o salvamento falhar, a vaga é devolvida.

**Cancelamento (`DELETE /tickets/:id`):** o ingresso passa para `CANCELLED`, o registro é mantido e a vaga volta ao evento. Se o `events-service` estiver indisponível, o ingresso retorna ao status anterior e a API responde `503`.

**Regras principais:**

- A reserva de vagas é atômica, e requisições simultâneas não vendem mais vagas do que existem.
- O evento passa para `SOLD_OUT` ao esgotar e volta para `PUBLISHED` quando uma vaga é devolvida.
- Cada documento pode ter apenas uma inscrição ativa por evento.
- Ao alterar a capacidade de um evento, as vagas já ocupadas são preservadas.

## Endpoints

### `events-service` (porta 8000)

| Método e rota | Descrição |
|---|---|
| `POST /events` | Cria um evento |
| `GET /events` | Lista os eventos (filtros: `category`, `status`) |
| `GET /events/{id}` | Busca um evento |
| `PUT /events/{id}` | Atualiza um evento |
| `DELETE /events/{id}` | Remove um evento |
| `PATCH /events/{id}/reserve-spot` | Reserva uma vaga (integração) |
| `PATCH /events/{id}/release-spot` | Devolve uma vaga (integração) |

### `tickets-service` (porta 3000)

| Método e rota | Descrição |
|---|---|
| `POST /tickets` | Realiza a inscrição e emite o ingresso |
| `GET /tickets` | Lista os ingressos (filtros: `event_id`, `participant_email`, `status`) |
| `GET /tickets/:id` | Consulta por UUID ou `ticket_code` |
| `PUT /tickets/:id` | Atualiza o ingresso ou realiza o check-in |
| `DELETE /tickets/:id` | Cancela o ingresso e devolve a vaga |

### Documentação e telemetria

Disponíveis nos dois serviços, com o serviço em execução:

| Recurso | Eventos | Ingressos |
|---|---|---|
| Swagger UI | http://localhost:8000/docs | http://localhost:3000/docs |
| Métricas Prometheus | http://localhost:8000/metrics | http://localhost:3000/metrics |
| Saúde | http://localhost:8000/health | http://localhost:3000/health |

Os logs são estruturados, com marcadores como `[HTTP SYNC REQUEST]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]` e `[TELEMETRY]`. O cabeçalho `X-Correlation-Id` liga os logs dos dois serviços em uma mesma operação.

## Como executar

A execução completa com `docker compose up --build` chega na Fase 3. Enquanto isso, é possível rodar os serviços diretamente, com Python 3.11, Node.js 20 e PostgreSQL disponíveis, e os bancos `events_db` e `tickets_db` já criados. As tabelas são criadas na subida.

**`events-service`:**

```sh
cd microservices/events-service
pip install -r requirements.txt
export DATABASE_URL="postgresql+psycopg2://USUARIO:SENHA@localhost:5432/events_db"
uvicorn app.main:app --port 8000
```

**`tickets-service`**, em outro terminal:

```sh
cd microservices/tickets-service
npm ci
npm run build
export DATABASE_URL="postgresql://USUARIO:SENHA@localhost:5432/tickets_db"
export EVENTS_SERVICE_URL="http://localhost:8000"
npm start
```

No PowerShell, troque `export NOME="valor"` por `$env:NOME = "valor"`.

## Testes

Os testes automatizados não precisam de banco de dados nem de Docker.

```sh
# events-service
cd microservices/events-service
pip install -r requirements-dev.txt
pytest

# tickets-service
cd microservices/tickets-service
npm ci
npm test
```

## Estrutura do repositório

```
events-tickets-ms/
├── README.md
├── docs/                     # Documentação do projeto
└── microservices/
    ├── events-service/       # Python + FastAPI
    └── tickets-service/      # Node.js + NestJS
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/prompt.md](docs/prompt.md) | Especificação completa e fases do projeto |
| [docs/arquitetura.md](docs/arquitetura.md) | Topologia, configuração e observabilidade |
| [docs/contratos-api.md](docs/contratos-api.md) | Contratos, regras de negócio e erros |
| [docs/decisoes.md](docs/decisoes.md) | Decisões de projeto e justificativas |
| [docs/AGENTS.md](docs/AGENTS.md) | Regras para agentes de código |
