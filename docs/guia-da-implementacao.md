# Guia da implementação

Explicação do `events-tickets-ms` para estudo pessoal: o que foi construído, como funciona e por quê. A especificação formal está em [prompt.md](prompt.md), os contratos em [contratos-api.md](contratos-api.md) e o passo a passo da aula em [roteiro-apresentacao.md](roteiro-apresentacao.md).

## 1. O sistema em um minuto

É uma plataforma genérica de eventos e ingressos. Serve para simpósio, show, corrida ou campeonato, porque nada no código depende do tipo de evento. Inscrição e ingresso são a mesma coisa: ao se inscrever, a pessoa recebe um ingresso com código único e controle de presença. Tudo o que acontece fica registrado e pode ser consultado como histórico.

São três microsserviços em tecnologias diferentes, cada um com seu banco:

- **`events-service`** (JavaScript/NestJS): cuida dos eventos e das vagas. É o único que mexe em `available_spots`.
- **`tickets-service`** (TypeScript/NestJS): cuida das inscrições, dos ingressos e do check-in.
- **`logs-service`** (Python/FastAPI): guarda o registro de atividades (o que aconteceu e quando) e permite fazer a triagem desses registros.

Eles conversam de duas formas:

- **HTTP síncrono:** para emitir um ingresso, o `tickets-service` pede a vaga ao `events-service`; para mostrar um histórico, cada serviço consulta o `logs-service`.
- **RabbitMQ assíncrono:** a devolução de vagas (ingresso cancelado), o cancelamento dos ingressos de um evento cancelado e o registro de cada atividade.

Na frente de tudo há um **API Gateway NGINX**, a única porta aberta (8080). **Prometheus** e **Grafana** coletam e exibem as métricas.

## 2. Por que essa divisão

Esta é a pergunta mais provável da banca, então vale saber de cor.

**Eventos e ingressos separados.** O evento e suas vagas têm um dono, o `events-service`; os ingressos e os participantes têm outro, o `tickets-service`. Cada um tem seu banco e pode evoluir, escalar e falhar sozinho: o cadastro de eventos não depende da venda, e a venda continua consultável mesmo com o `events-service` fora. A regra mais importante do domínio, não vender mais ingressos que vagas, passa a envolver dois bancos, e a solução é o assunto central da apresentação (seção 6).

O projeto já passou por outras divisões, e isso ajuda a explicar a escolha:

| Versão | Divisão | O que ensinou |
|---|---|---|
| 1 | Eventos (Python) + ingressos (NestJS) | A reserva por HTTP tinha um problema: um timeout deixava a dúvida se a vaga tinha sido reservada |
| 2 | Eventos e ingressos juntos + logs | Uma transação local resolvia tudo, mas a comunicação entre serviços ficava só com os logs |
| 3 (atual) | Eventos + ingressos + logs, três bancos | Separados de novo, com a reserva idempotente que resolve o problema da versão 1 |

**Logs separados.** O registro de atividades tem características diferentes:

- só acrescenta dados, nunca altera o que aconteceu;
- pode crescer muito e ter outra política de retenção;
- não pode derrubar a venda se cair.

Por isso ele recebe as atividades de forma assíncrona e tem seu próprio banco. Se ficar fora do ar, vendas e inscrições continuam, e as mensagens esperam.

**Cuidado com a confusão:** o `logs-service` não é a observabilidade do sistema. Ele é um serviço de negócio (auditoria). A observabilidade técnica (métricas, painéis, logs dos contêineres) é feita por Prometheus e Grafana, e é isso que atende o item de telemetria do edital.

## 3. Os 10 contêineres

| Contêiner | Tecnologia | Função | Porta interna |
|---|---|---|---|
| `api-gateway` | NGINX 1.27 | Entrada única, publicada no host em `8080` | 80 |
| `events-service` | Node.js 20, NestJS em JavaScript, TypeORM | Eventos e vagas | 3001 |
| `events-db` | PostgreSQL 16 | Banco exclusivo do `events-service` | 5432 |
| `tickets-service` | Node.js 20, NestJS em TypeScript, TypeORM | Ingressos e check-in | 3002 |
| `tickets-db` | PostgreSQL 16 | Banco exclusivo do `tickets-service` | 5432 |
| `logs-service` | Python 3.11, FastAPI, SQLAlchemy 2 | Registro de atividades | 8000 |
| `logs-db` | PostgreSQL 16 | Banco exclusivo dos logs | 5432 |
| `rabbitmq` | RabbitMQ 3.13 | Mensageria assíncrona | 5672 e 15672 |
| `prometheus` | Prometheus 2.55 | Coleta de métricas | 9090 |
| `grafana` | Grafana 11.4 | Painéis | 3000 |

Todos estão na rede interna `events-tickets-network`, onde se encontram pelo nome (`http://events-service:3001`). Só o gateway é acessível de fora.

## 4. Onde fica cada coisa

```
events-tickets-ms/
├── docker-compose.yml                Sobe os 10 contêineres
├── frontend/                         Aplicação web, servida pelo gateway em /app/
├── gateway/nginx.conf                Rotas do API Gateway
├── messaging/rabbitmq.conf           Prefixo /rabbitmq da interface web
├── observability/
│   ├── prometheus/prometheus.yml     O que coletar e com que frequência
│   └── grafana/                      Fonte de dados e painel prontos
├── docs/                             Documentação
└── microservices/
    ├── events-service/               JavaScript, transpilado pelo Babel
    │   ├── babel.config.json         Decorators em JavaScript
    │   └── src/
    │       ├── main.js               Monta a aplicação e o Swagger
    │       ├── events/               Controller, regras, repositórios, EntitySchema e DTOs
    │       ├── spot-releases/        Consumidor da fila events.spot-releases (devoluções)
    │       ├── outbox/               Tabela outbox_messages e publicador do RabbitMQ
    │       ├── logs-integration/     Cliente HTTP que consulta o histórico
    │       ├── metrics/              Métricas, /health, logs e correlação
    │       └── common/               Erro padrão, paginação e validação explícita
    ├── tickets-service/src/
    │   ├── main.ts                   Monta a aplicação e o Swagger
    │   ├── tickets/                  Controller, regras, repositórios, entidades e DTOs
    │   ├── events-integration/       Cliente HTTP da reserva de vaga
    │   ├── event-updates/            Consumidor da fila tickets.event-updates (cascata)
    │   ├── outbox/                   Tabela outbox_messages e publicador do RabbitMQ
    │   ├── logs-integration/         Cliente HTTP que consulta o histórico
    │   ├── metrics/                  Métricas, /health, logs e correlação
    │   └── common/                   Erro padrão, paginação, validações e erros do PostgreSQL
    └── logs-service/app/
        ├── main.py                   Monta a aplicação, /health, /metrics e o consumidor
        ├── core/                     Configuração, banco, logs e métricas
        └── modules/logs/
            ├── router.py             Rotas e documentação do Swagger
            ├── service.py            Regras (imutabilidade, triagem, arquivamento)
            ├── repository.py         Consultas ao banco
            ├── models.py             Tabela activity_logs
            ├── schemas.py            Validação de entrada e saída
            └── consumer.py           Consumidor da fila logs.activity
```

A organização é em camadas: a rota recebe, o serviço decide e o repositório acessa o banco. Nenhuma regra de negócio fica na rota.

## 5. `events-service`: eventos e vagas

### Tabelas

- **`events`:** `title`, `category`, `modality`, `location`, `start_at`, `end_at`, `max_capacity`, `available_spots`, `status` e `metadata_info`. Este último é um JSON livre, que deixa o evento genérico (palestrante, carga horária, classificação). Status possíveis: `PUBLISHED`, `SOLD_OUT`, `CANCELLED` e `FINISHED`.
- **`spot_reservations`:** uma linha por vaga reservada, com o `ticket_id` como chave primária e o status `RESERVED` ou `RELEASED`. É o que torna a reserva e a devolução idempotentes.
- **`outbox_messages`:** mensagens a publicar no RabbitMQ.

### Regras que você precisa saber explicar

**Reserva de vaga atômica.** É o ponto mais importante do sistema. Um único comando faz tudo:

```sql
UPDATE events
SET available_spots = available_spots - 1,
    status = CASE WHEN available_spots = 1 THEN 'SOLD_OUT' ELSE status END
WHERE id = :id AND status = 'PUBLISHED' AND available_spots > 0 AND end_at > now()
RETURNING *;
```

Se o código lesse o valor, subtraísse e salvasse, duas requisições simultâneas poderiam ver "1 vaga" e vender a mesma vaga. Com o `UPDATE` condicional, o banco serializa as escritas, e só uma consegue. No teste com 20 inscrições simultâneas para 5 vagas, foram emitidos exatamente 5 ingressos, e 15 receberam `409`.

**Reserva idempotente (D30).** Na mesma transação do `UPDATE`, o `events-service` grava a linha em `spot_reservations` com o `ticket_id` que o `tickets-service` mandou. Se a mesma reserva chegar de novo (o `tickets-service` repetiu depois de um timeout, por exemplo), ela já existe, e o serviço devolve o evento sem reservar outra vaga. Duas chamadas simultâneas com o mesmo `ticket_id` esbarram na chave primária: a segunda transação é desfeita, o decremento volta, e vale a reserva da primeira.

**Devolução de vaga (D31).** Chega pela fila `events.spot-releases`. Na mesma transação: trava a reserva do `ticket_id`, marca `RELEASED`, devolve a vaga (limite `available_spots < max_capacity`; `SOLD_OUT` volta a `PUBLISHED`) e grava `event.spot_released`. Se a reserva já está `RELEASED`, é uma entrega repetida, e nada muda. Se a reserva não existe, grava a linha já `RELEASED`: assim, uma reserva atrasada com o mesmo `ticket_id` é recusada, em vez de prender uma vaga.

**Mudança de capacidade (D2).** Preserva as vagas ocupadas: `available_spots = nova capacidade - ocupadas`. Reduzir abaixo das ocupadas responde `409`. O `PUT` trava a linha com `SELECT ... FOR UPDATE`, para não concorrer com reservas.

**Evento cancelado é definitivo (D17).** Tentar mudar para outro status responde `409`. Os ingressos são cancelados sem devolver vagas; se o evento pudesse reabrir, essas vagas ficariam presas.

**Cancelar ou remover evento (D33).** Na mesma transação: trava o evento, aplica a mudança e grava a atividade e o aviso para o `tickets-service`. A resposta sai na hora; os ingressos são cancelados pelo `tickets-service` cerca de 1 s depois.

**Datas com fuso (D10).** `start_at` e `end_at` exigem fuso, como `-04:00` ou `Z`; sem isso, a resposta é `400`.

### NestJS em JavaScript (D35)

NestJS e TypeORM foram feitos para TypeScript, que fornece os decorators e os tipos usados pela injeção de dependências e pela validação. Sem TypeScript:

| Em TypeScript | No `events-service` (JavaScript) |
|---|---|
| Decorators nativos do compilador | Babel com `@babel/plugin-proposal-decorators` (modo `legacy`) |
| O construtor declara os tipos, e o Nest injeta | `@Dependencies(EventsRepository, ...)` na classe |
| `@Body() dto: CreateEventDto` | `@Bind(ValidBody(CreateEventDto))`, porque não há decorator de parâmetro nem tipo |
| `ValidationPipe` global descobre o DTO pelo tipo | `ValidBody(Dto)` e `ValidQuery(Dto)` criam o pipe com `expectedType` |
| Entidade com `@Entity` e `@Column` | `EntitySchema`, e as linhas são objetos simples |
| Swagger infere os tipos | Todo `@ApiProperty` declara `type`; o teste `openapi.spec.js` garante |

É uma boa história para a banca: a mesma arquitetura (NestJS + TypeORM) em duas linguagens, com o que muda quando não há sistema de tipos.

## 6. `tickets-service`: ingressos

### Tabelas

- **`tickets`:** `id` (gerado pelo serviço antes da reserva), `ticket_code`, `event_id`, `event_snapshot`, `participant_name`, `participant_email`, `participant_document`, `modality_tier` e `status` (`CONFIRMED`, `CHECKED_IN` ou `CANCELLED`).
- **`closed_events`:** eventos que o `events-service` avisou terem sido cancelados ou removidos (D32).
- **`outbox_messages`:** mensagens a publicar no RabbitMQ.

Detalhes:

- **`event_id` não é chave estrangeira:** o evento está em outro banco, e o ingresso precisa continuar existindo se o evento for removido.
- **`event_snapshot`** copia título, categoria, modalidade, local e data no momento da inscrição, a partir da resposta da reserva. Assim, o ingresso se mostra mesmo que o evento deixe de existir, e o `tickets-service` nunca lê o banco de eventos.
- **`ticket_code`** tem o formato `EVT-2026-XXXXXX`, gerado aleatoriamente. Em caso de colisão, tenta outro, até 5 vezes.

### Emissão: `POST /tickets` (D30)

1. Valida o corpo. Campo desconhecido responde `400`.
2. Se o evento está em `closed_events`, responde `400 Event is not open for registrations`, sem chamar o `events-service`.
3. Se o documento já tem ingresso ativo no evento, responde `409`.
4. **Gera o `id` do ingresso** (UUID).
5. **Reserva a vaga:** `PATCH /events/{id}/reserve-spot` no `events-service`, com o `ticket_id`, timeout de 3 s e o `X-Correlation-Id`. As recusas (`404`, `400 Event has already ended`, `409 Event is sold out`, `400 Event is not open for registrations`) voltam ao cliente iguais.
6. **Abre uma transação local** e, dentro dela:
   - trava o evento com um lock consultivo (seção 6, "a janela da cascata");
   - confere de novo `closed_events`;
   - salva o ingresso como `CONFIRMED`, com o `id` do passo 4;
   - grava `ticket.issued` na outbox.
7. Faz o commit e responde `201`.

**E se algo der errado depois da reserva?** É a compensação:

| Situação | O que o `tickets-service` faz |
|---|---|
| O salvamento falha (inscrição simultânea com o mesmo documento, evento encerrado no meio, erro do banco) | Grava `spot.release_requested` (`issue_failed`) na outbox e responde `409` ou `500` |
| O `events-service` não responde (timeout, `5xx`, fora do ar) | A reserva pode ter acontecido ou não: grava a devolução do mesmo jeito e responde `503` |

Como a devolução é feita pelo `ticket_id`, ela é segura nos dois casos: desfaz a reserva se ela aconteceu, e não muda nada se não aconteceu. Era exatamente o problema da versão 1: lá, um timeout deixava a vaga em estado desconhecido.

**Savepoint na geração do código.** No PostgreSQL, um erro dentro da transação a invalida. Se o `ticket_code` colidir, a nova tentativa roda dentro de um *savepoint*: só o `INSERT` é desfeito.

**Duplicidade (D3).** O passo 3 é só para dar uma resposta rápida e não reservar à toa. Quem garante de verdade é um índice único parcial:

```sql
CREATE UNIQUE INDEX uq_tickets_active_event_participant
ON tickets (event_id, participant_document)
WHERE status <> 'CANCELLED';
```

Duas requisições simultâneas podem passar pelo passo 3 e reservar duas vagas, mas o banco só aceita um ingresso. A outra recebe `409`, e a vaga dela é devolvida pela compensação.

### A janela da cascata (D32)

O cancelamento em cascata é assíncrono, então existe uma corrida possível: uma emissão reservou a vaga um instante antes de o evento ser cancelado, e o aviso chega ao `tickets-service` antes de ela salvar o ingresso. Sem cuidado, o ingresso seria salvo depois de os outros terem sido cancelados, e ficaria `CONFIRMED` num evento cancelado.

A solução usa duas peças:

- a tabela `closed_events`, gravada pelo consumidor do aviso;
- um lock consultivo do PostgreSQL por evento (`pg_advisory_xact_lock`), pego no início das duas transações, a da emissão e a da cascata.

Com o lock, uma transação espera a outra: ou o ingresso é salvo antes e é cancelado junto com os outros, ou a emissão encontra o evento em `closed_events` e desiste, devolvendo a vaga. O lock é "consultivo" porque o evento não tem linha no banco de ingressos para ser travada com `FOR UPDATE`.

### Cancelamento: `DELETE /tickets/{id}` (D1, D31)

Na mesma transação:

1. Muda o status para `CANCELLED`, com a condição de o status ainda ser o que foi lido. Isso impede que dois cancelamentos simultâneos peçam a devolução duas vezes.
2. Grava `ticket.cancelled` e o pedido `spot.release_requested` (`ticket_cancelled`) na outbox.

A resposta sai na hora, e a vaga volta cerca de 1 s depois, quando o `events-service` consome o pedido. O registro nunca é apagado (soft delete). Se o `events-service` ou o RabbitMQ estiverem fora do ar, o cancelamento funciona do mesmo jeito, e a devolução espera.

### Cascata: aviso de evento cancelado ou removido (D33)

O consumidor da fila `tickets.event-updates`, numa transação com o lock consultivo, registra o evento em `closed_events`, cancela os ingressos ativos com um único `UPDATE ... RETURNING` e grava um `ticket.cancelled` por ingresso, com `reason` `event_cancelled` ou `event_deleted`. Não pede devolução de vagas. Um aviso repetido não encontra ingressos ativos e não grava nada.

### Atualização e check-in: `PUT /tickets/{id}` (D12)

Altera só os campos enviados. Enviar `{"status": "CHECKED_IN"}` faz o check-in, aceito apenas a partir de `CONFIRMED`. Não dá para cancelar por aqui nem editar ingresso cancelado. Não depende do `events-service`.

`GET /tickets/{id}` e `GET /tickets/{id}/history` aceitam o UUID ou o `ticket_code`.

## 7. `logs-service`

### Tabela `activity_logs`

| Campo | Para quê |
|---|---|
| `action` | O que aconteceu, como `ticket.issued` ou `incident.reported` |
| `entity_type`, `entity_id` | Sobre o quê (evento ou ingresso) |
| `level` | `INFO`, `WARNING` ou `ERROR` |
| `message`, `data` | Descrição e detalhes, sem dados pessoais |
| `source` | `events-service`, `tickets-service` ou `manual` |
| `correlation_id` | Liga o registro à requisição que o causou |
| `occurred_at` | Quando aconteceu |
| `message_id` | Identificador da mensagem do RabbitMQ, único |
| `status`, `notes` | Triagem: `NEW`, `REVIEWED`, `RESOLVED` e anotações |
| `archived_at` | Preenchido quando o registro é arquivado |

### O CRUD e por que ele faz sentido (D19)

Um log descreve um fato que já aconteceu, então não faz sentido reescrevê-lo. O CRUD separa o fato da triagem:

| Operação | Rota | O que faz |
|---|---|---|
| Create | `POST /logs` | Registra algo que não veio do sistema, como "projetor com defeito, palestra atrasou". Os automáticos chegam pelo RabbitMQ |
| Read | `GET /logs`, `GET /logs/{id}` | Filtra por entidade, ação, nível, status, origem e `correlation_id`, com ordem e paginação |
| Update | `PUT /logs/{id}` | Muda só `status` e `notes`. Tentar mudar o fato responde `422` |
| Delete | `DELETE /logs/{id}` | Arquiva: o registro sai das listagens e do histórico, mas continua no banco |

**Por que arquivar, e não apagar?** Por dois motivos. Em auditoria, apagar de verdade é exceção. E o `message_id` precisa continuar no banco: como a entrega é "ao menos uma vez", uma mensagem pode chegar de novo, e com o registro apagado ela seria gravada outra vez.

### O consumidor

Uma thread do `logs-service` consome a fila `logs.activity`:

1. Valida a mensagem. Se for inválida, ou se a routing key não bater com a ação, manda para a fila `logs.activity.dlq`.
2. Grava o registro. Se o `message_id` já existir, é uma entrega repetida, e nada é gravado.
3. Confirma (`ack`) só depois de gravar.
4. Se o banco falhar, espera 5 s e devolve a mensagem à fila.

O consumidor conecta em segundo plano, com novas tentativas, então a API HTTP do `logs-service` sobe mesmo com o broker fora.

## 8. Síncrono x assíncrono

| Comunicação | Estilo | Por quê | Se o outro lado cair |
|---|---|---|---|
| Reserva de vaga (`tickets` → `events`) | HTTP | O cliente precisa saber na hora se conseguiu o ingresso | Só a emissão responde `503`, e a reserva incerta é devolvida |
| Histórico (`events`/`tickets` → `logs`) | HTTP | O cliente pediu o histórico e precisa da resposta agora | Só a rota de histórico responde `503` |
| Devolução de vaga (`tickets` → `events`) | RabbitMQ | Não precisa de resposta, precisa acontecer | O pedido espera na fila |
| Cascata de evento (`events` → `tickets`) | RabbitMQ | O evento não deve depender do serviço de ingressos para ser cancelado | O aviso espera na fila |
| Atividades (`events`/`tickets` → `logs`) | RabbitMQ | Quem vende não pode esperar o registro, nem falhar se ele cair | As mensagens esperam na fila |

### As três exchanges (D34)

| Exchange | Quem publica | Fila | Quem consome |
|---|---|---|---|
| `activities.exchange` | `events-service` e `tickets-service` | `logs.activity` (`event.*`, `ticket.*`) | `logs-service` |
| `events.exchange` | `events-service` | `tickets.event-updates` (`event.cancelled`, `event.deleted`) | `tickets-service` |
| `tickets.exchange` | `tickets-service` | `events.spot-releases` (`spot.release_requested`) | `events-service` |

Por que não uma exchange só? Por causa do `mandatory`: o broker devolve a mensagem que não chega a nenhuma fila, e é assim que o publicador sabe que o consumidor ainda não criou a fila. Se uma routing key tivesse duas filas e só uma existisse, a mensagem não voltaria, e a outra fila a perderia. Com uma fila por exchange e routing key, a devolução é sempre um aviso confiável.

### O caminho da mensagem

1. Uma operação muda dados, por exemplo `DELETE /tickets/{id}`.
2. Na **mesma transação**, as mensagens entram em `outbox_messages`, cada uma com sua exchange.
3. A API responde na hora.
4. A cada segundo, o publicador conta as pendentes, conecta ao broker e só então abre a transação que trava um lote de até 50 (`FOR UPDATE SKIP LOCKED`). Publica cada uma na sua exchange, com a ação como routing key. Se o lote veio cheio, o próximo sai em seguida (D28).
5. O RabbitMQ confirma o recebimento (*publisher confirms*), e só então as linhas são marcadas como publicadas. Uma mensagem devolvida por falta de fila fica pendente sozinha, sem segurar as outras (D34).
6. O consumidor grava e confirma (`ack`).

**Por que outbox?** Publicar direto depois do commit cria um problema de escrita dupla: se o processo cair entre as duas operações, ou o broker estiver fora, o dado muda e a mensagem se perde. Com a outbox, a mensagem é gravada junto com a mudança: ou as duas acontecem, ou nenhuma. Na versão 3, isso vale também para a devolução de vagas: o ingresso cancelado e o pedido de devolução nascem juntos.

**Dados pessoais.** As mensagens nunca levam nome, e-mail ou documento do participante. Quando o participante muda um dado, a mensagem `ticket.updated` diz só quais campos mudaram.

### O caminho do histórico

1. `GET /tickets/{id}/history` chega ao `tickets-service` (ou `GET /events/{id}/history`, ao `events-service`).
2. O serviço confirma que a entidade existe (`404` se não).
3. Chama `GET http://logs-service:8000/logs?entity_type=...&entity_id=...&order=asc`, com timeout de 3 s e o mesmo `X-Correlation-Id`.
4. Devolve `{ entity_type, entity_id, total, limit, offset, entries }`. Se o `logs-service` não responder, `503 Logs service unavailable`.

O histórico de um evento inclui `event.spot_reserved` e `event.spot_released`, com as vagas livres e o status em cada momento. É uma boa forma de mostrar o evento esgotando e reabrindo.

## 9. API Gateway

O arquivo `gateway/nginx.conf` funciona como lista de permissões: o que não está listado responde `404 Route not found`.

| Endereço | Destino |
|---|---|
| `/events`, `/events/{id}`, `/events/{id}/history` | `events-service` |
| `/tickets`, `/tickets/{id}`, `/tickets/{id}/history` | `tickets-service` |
| `/logs`, `/logs/{id}` | `logs-service` |
| `/docs/events`, `/docs/tickets`, `/docs/logs` | Swagger de cada serviço |
| `/health/events`, `/health/tickets`, `/health/logs` | Saúde de cada serviço |
| `/metrics/events`, `/metrics/tickets`, `/metrics/logs` | Métricas de cada serviço |
| `/grafana/` | Grafana |
| `/prometheus/` | Prometheus |
| `/rabbitmq/` | Interface do RabbitMQ |
| `/gateway/health` | Saúde do gateway |
| `/app/` (e `/`, que redireciona) | Aplicação web, servida pelo próprio gateway |

Detalhes úteis:

- **Rota interna fora da lista:** `PATCH /events/{id}/reserve-spot` responde `404` pelo gateway. Só o `tickets-service` a chama, pela rede interna.
- **DNS em tempo de requisição:** os destinos ficam em variáveis, e o NGINX usa o DNS do Docker. Por isso, um serviço reiniciado com outro IP volta a ser encontrado.
- **Serviço fora do ar:** o gateway responde `503 Service unavailable`.
- **Swagger (D14):** cada serviço serve o Swagger no caminho público, para os três não colidirem e o "Try it out" funcionar pelo gateway.
- **Aplicação web (D24):** arquivos estáticos de `frontend/`, sem build. Como estão na mesma origem da API, não há CORS, e a página entra pela porta 8080 como qualquer outro cliente. Ela não tem regra de negócio: chama as rotas públicas e desenha o caminho de cada chamada. A parte síncrona acompanha a resposta HTTP, inclusive a reserva no `events-service`. A assíncrona só aparece quando o registro com o mesmo `X-Correlation-Id` chega ao `logs-service`, e o caminho desenhado vem do próprio registro: devolução passa pelo `events-service`, cascata passa pelo `tickets-service`.

## 10. Observabilidade

### Três formas de observar

- **Métricas:** cada serviço expõe `/metrics`. O Prometheus coleta a cada 5 s, pela rede interna.
- **Painéis:** o Grafana lê o Prometheus e abre direto no painel "Visão Geral", sem login, somente leitura.
- **Logs estruturados:** cada linha tem uma etiqueta e um JSON.

### Métricas que valem citar

| Métrica | Serviço | Significado |
|---|---|---|
| `up` | Todos | O Prometheus alcança o serviço? |
| `http_requests_total` | Todos | Requisições por rota e status |
| `http_request_duration_*` | Todos | Latência |
| `events_spot_operations_total` | Eventos | Reservas (`success`, `replayed`, `conflict`, `rejected`) e devoluções (`success`, `duplicate`, `not_reserved`, `at_capacity`, `event_missing`) |
| `tickets_issued_total`, `tickets_cancelled_total` | Ingressos | Ingressos emitidos e cancelados |
| `tickets_spot_reservations_total` | Ingressos | Reservas pedidas ao `events-service`: `reserved`, `rejected`, `unavailable` |
| `tickets_compensations_total` | Ingressos | Devoluções pedidas por falha depois da reserva: `queued` ou `failed` |
| `outbox_messages_published_total` | Eventos e ingressos | Mensagens confirmadas pelo RabbitMQ, por exchange e routing key |
| `outbox_messages_pending` | Eventos e ingressos | Total de mensagens aguardando publicação, contado na tabela a cada ciclo |
| `integration_messages_consumed_total` | Eventos e ingressos | Devoluções e avisos consumidos, por resultado |
| `logs_messages_consumed_total` | Logs | Mensagens consumidas, por resultado (`processed`, `duplicate`, `rejected`, `retried`) |
| `logs_entries_created_total` | Logs | Registros gravados, por origem (`rabbitmq` ou `api`) |

Os contadores ficam na memória do processo e **zeram quando o serviço reinicia**. Os dados de negócio continuam no banco.

### Rastreamento entre serviços

O cabeçalho `X-Correlation-Id` é criado no gateway, se não vier na requisição, e repassado aos serviços. O `tickets-service` o repassa na reserva ao `events-service`, e todos o gravam em cada mensagem do RabbitMQ. O consumidor de uma mensagem continua com o mesmo identificador: o `event.spot_released` de uma devolução e os `ticket.cancelled` de uma cascata levam o identificador da operação que os causou. Assim, um único comando mostra a operação inteira:

```sh
docker compose logs api-gateway events-service tickets-service logs-service | grep <id>
```

E, pelo lado do negócio: `GET /logs?correlation_id=<id>`.

Etiquetas principais: `[GATEWAY]`, `[TELEMETRY]`, `[EVENT CREATED]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]`, `[TICKET ISSUED]`, `[TICKET CANCELLED]`, `[COMPENSATION QUEUED]`, `[TICKETS CANCELLED BY EVENT]`, `[EVENT CANCELLED]`, `[ACTIVITY MESSAGE PUBLISHED]`, `[INTEGRATION MESSAGE PUBLISHED]`, `[ACTIVITY LOGGED]`, `[HTTP SYNC REQUEST]` e `[HTTP SYNC RESPONSE]`.

E-mail e documento nunca vão para os logs nem para as mensagens.

## 11. Docker Compose

Ordem de subida, controlada por `depends_on` com `service_healthy`:

```
events-db, tickets-db, logs-db, rabbitmq
  → events-service, tickets-service e logs-service (em paralelo)
    → api-gateway e prometheus (esperam o events-service e o tickets-service)
      → grafana
```

- **Independência:** nenhum serviço depende de outro para subir (D27, D36). Se o `logs-service` falhar, a venda segue; se o `events-service` falhar, só a emissão para.
- **Reinício automático:** todos os contêineres usam `restart: unless-stopped`. Um processo que cai volta sozinho; `docker compose stop` mantém parado, como nos experimentos de falha.
- **Healthchecks:** cada contêiner informa quando está pronto de verdade, não só iniciado.
- **Volumes:** `events_pgdata`, `tickets_pgdata`, `logs_pgdata`, `rabbitmq_data` e `prometheus_data` mantêm os dados.
- **Sem `.env`:** os valores estão no `docker-compose.yml`, para bastar `docker compose up --build`.
- **Tabelas:** os serviços as criam ao subir, sem ferramenta de migração (D8). Mudou o modelo, ou rodou uma versão anterior na mesma máquina? Use `docker compose down -v`.
- **Build do JavaScript:** o Dockerfile do `events-service` roda o Babel (`npm run build`) e copia só o `dist/` e as dependências de produção.

## 12. O que acontece quando algo falha

| Falha | Comportamento |
|---|---|
| `events-service` fora | A emissão responde `503`, e a reserva incerta é devolvida; consultas, check-in e cancelamentos de ingressos seguem |
| `tickets-service` fora | Eventos funcionam; os avisos de evento cancelado esperam na fila |
| `logs-service` fora | Vendas seguem; o histórico responde `503`; as atividades esperam na fila |
| RabbitMQ fora | As APIs seguem; as mensagens esperam nas outbox |
| Timeout na reserva | `503`, e a devolução pelo `ticket_id` desfaz a reserva, se ela aconteceu |
| Erro ao salvar o ingresso depois da reserva | `409` ou `500`, e a vaga é devolvida pela compensação |
| Reserva repetida com o mesmo `ticket_id` | Devolve a mesma vaga, sem reservar outra |
| Devolução repetida | Não muda as vagas |
| Inscrição em evento encerrado ou inexistente | `400 Event has already ended` ou `404 Event not found`, sem consumir vaga |
| Duas inscrições iguais ao mesmo tempo | Uma é emitida; a outra recebe `409`, e a vaga dela volta |
| Duas pessoas pela última vaga | Uma é emitida; a outra recebe `409` |
| Dois cancelamentos iguais ao mesmo tempo | Um funciona; a vaga volta uma única vez |
| Emissão durante o cancelamento do evento | O lock consultivo ordena: ou o ingresso é cancelado junto, ou a emissão desiste e devolve a vaga |
| Fila ainda não criada | O broker devolve a mensagem, que fica pendente sozinha até a fila existir |
| Mensagem duplicada | Cada consumidor a reconhece e não repete o efeito |
| Mensagem inválida | Vai para a fila de mensagens mortas |
| Processo de um serviço cai | O Docker o reinicia sozinho (`restart: unless-stopped`) |
| `docker compose down` sem `-v` | Bancos e filas continuam nos volumes |

## 13. Decisões de projeto

Detalhes em [decisoes.md](decisoes.md).

| Decisão | Resumo | Status |
|---|---|---|
| D1 | Cancelar ingresso mantém o registro | Confirmada |
| D2 | Mudar a capacidade preserva as vagas ocupadas | Confirmada |
| D3 | Uma inscrição ativa por documento em cada evento | Confirmada |
| D4 | Testes das regras principais | Confirmada |
| D5 | Regras de transição de ingressos (compensação refeita na D30 e na D31) | Provisória |
| D6 | Remoção de evento com ingressos | Substituída pela D22, e esta pela D33 |
| D7 | Rastreamento por `X-Correlation-Id` | Provisória |
| D8 | Sem ferramenta de migração | Provisória |
| D9 | `README.md` na raiz | Provisória |
| D10 | Datas com fuso e `PUT` parcial em eventos | Provisória |
| D11 | Evento esgotado responde `409` | Provisória |
| D12 | `PUT` de ingresso parcial e estrito | Provisória |
| D13 | NGINX como única entrada | Confirmada |
| D14 | Swagger, saúde e métricas sob caminhos do gateway | Confirmada |
| D15 | Prometheus e Grafana | Ferramentas confirmadas; acesso provisório |
| D16 | RabbitMQ e outbox | Confirmada; conteúdo ampliado nas versões 2 e 3 |
| D17 | Evento cancelado não reabre | Provisória |
| D18 | Eventos e ingressos em um serviço (versão 2) | Substituída pela D29 |
| D19 | CRUD de logs: fato imutável, triagem e arquivamento | Confirmada |
| D20 | Toda mudança gera atividade pela outbox | Provisória |
| D21 | Histórico por HTTP síncrono | Confirmada |
| D22 | Cascata de evento na mesma transação (versão 2) | Substituída pela D33 |
| D23 | Validação responde `400` nos serviços NestJS | Provisória |
| D24 | Aplicação web estática servida pelo gateway | Confirmada |
| D25 | Evento encerrado não aceita inscrições | Regra confirmada |
| D26 | Listagens e históricos paginados, com o total | Provisória |
| D27 | Reinício automático e subida sem depender do `logs-service` | Provisória |
| D28 | Publicador da outbox sem gargalo | Provisória |
| D29 | Três microsserviços e três bancos | Confirmada |
| D30 | Reserva por HTTP síncrono e idempotente, com compensação | Confirmada |
| D31 | Devolução de vaga assíncrona pela outbox | Confirmada |
| D32 | Eventos encerrados no `tickets-service`, com lock consultivo | Provisória |
| D33 | Cascata de evento assíncrona | Confirmada |
| D34 | Uma exchange por finalidade e publicação mensagem a mensagem | Provisória |
| D35 | `events-service` em JavaScript com NestJS e TypeORM | Confirmada (stack); detalhes provisórios |
| D36 | Portas, caminhos e ordem de subida da versão 3 | Provisória |

## 14. Testes

| Onde | Ferramenta | Cobre |
|---|---|---|
| `events-service/src/**/*.spec.js` | Jest + Babel | Criação, capacidade, cancelamento e remoção com aviso, reserva (idempotência, corrida, recusas), devolução (repetida, sem reserva, evento removido), DTOs e `ValidBody`, outbox, consumidor de devoluções, cliente do histórico e documento OpenAPI |
| `tickets-service/src/**/*.spec.ts` | Jest + ts-jest | Emissão com reserva remota, recusas, compensação (falha, timeout, duplicidade, evento encerrado), cancelamento com pedido de devolução, cascata, DTOs, cliente HTTP da reserva, consumidor da cascata, outbox e cliente do histórico |
| `logs-service/tests/` | `pytest` | CRUD, imutabilidade, arquivamento, filtros, Swagger, métricas e consumidor |

Eles usam simulações (Jest) e SQLite em memória (`pytest`), então rodam sem Docker. Por isso **não provam concorrência nem a comunicação real**: isso foi validado com os contêineres e o PostgreSQL reais (20 inscrições para 5 vagas, cancelamento repetido, cascata, `events-service` fora durante emissão e cancelamento, `logs-service` fora e RabbitMQ fora com cancelamentos pendentes).

```sh
cd microservices/events-service && npm ci && npm test
cd microservices/tickets-service && npm ci && npm test
cd microservices/logs-service && pip install -r requirements-dev.txt && pytest
```

## 15. Limitações conhecidas

Fale delas com tranquilidade: são escolhas de escopo.

- **Sem autenticação:** qualquer pessoa com acesso à API pode criar, cancelar e consultar dados, incluindo e-mail e documento, e pode arquivar registros. A rota interna de reserva só é protegida por estar fora do gateway.
- **Consistência eventual entre serviços:** a vaga de um ingresso cancelado e o cancelamento dos ingressos de um evento chegam cerca de 1 s depois da resposta; o histórico também. Com o broker ou um consumidor fora, o atraso dura até eles voltarem; nada se perde.
- **Vaga presa em falha dupla:** se o banco de ingressos cair exatamente entre a reserva e o salvamento, nem a compensação pode ser gravada; o log `[COMPENSATION FAILED]` traz o `ticket_id` para conciliar.
- **Uma instância de cada serviço**, sem escala horizontal configurada.
- **Sem migrações** (D8). As listagens são paginadas (D26), mas a aplicação web mostra só a primeira página de cada uma, com um aviso quando há mais.
- **Credenciais fixas** no `docker-compose.yml`, aceitáveis só em ambiente local.
- **Métricas do gateway** não vão para o Prometheus; o NGINX aparece só nos logs.

## 16. Conceitos para a defesa

| Conceito | Em uma frase | Onde aparece |
|---|---|---|
| Database per Service | Cada serviço tem seu banco, e ninguém acessa o banco do outro | `events-db`, `tickets-db` e `logs-db` |
| API Gateway | Porta única que esconde a topologia interna | NGINX |
| Heterogeneidade | Serviços em tecnologias diferentes, conversando por padrões comuns | JavaScript, TypeScript e Python, via JSON |
| Saga com compensação | Uma operação que atravessa serviços é desfeita por ações de compensação, e não por rollback | Reserva + salvamento do ingresso, com devolução se falhar |
| Idempotência | Repetir a operação não muda o resultado | Reserva e devolução pelo `ticket_id`; `message_id` no `logs-service` |
| Transação local | Várias escritas que acontecem inteiras ou não acontecem | Ingresso + outbox; reserva + registro + outbox |
| Consistência eventual | Os dados ficam corretos pouco depois, não no mesmo instante | Devolução de vaga, cascata e histórico |
| Padrão Outbox | Grava a mensagem na mesma transação do dado | `outbox_messages` nos dois serviços NestJS |
| Entrega ao menos uma vez | A mensagem pode repetir, mas não se perde | RabbitMQ com confirmações |
| Dead Letter Queue | Fila separada para mensagens que não podem ser processadas | `<fila>.dlq` |
| Controle de concorrência | O banco impede duas escritas conflitantes | `UPDATE` condicional, índice único, `FOR UPDATE` e lock consultivo |
| Isolamento de falhas | A queda de um serviço não derruba os outros | `events-service` fora só para a emissão |
| Rastreamento distribuído | Um identificador acompanha a operação entre serviços | `X-Correlation-Id`, inclusive nas mensagens |
| Topic exchange | Encaminha mensagens de acordo com a routing key | `activities.exchange`, `events.exchange` e `tickets.exchange` |

## 17. Comandos úteis

```sh
docker compose up --build -d                    # constrói e sobe
docker compose ps                               # estado dos contêineres
docker compose logs -f tickets-service          # logs de um serviço
docker compose restart logs-service             # reinicia um serviço
docker compose down                             # derruba e mantém os dados
docker compose down -v                          # derruba e apaga os dados

# Inspecionar os bancos
docker compose exec events-db psql -U events_user -d events_db -c 'select title, available_spots, status from events;'
docker compose exec events-db psql -U events_user -d events_db -c 'select ticket_id, status from spot_reservations;'
docker compose exec tickets-db psql -U tickets_user -d tickets_db -c 'select ticket_code, status from tickets;'
docker compose exec tickets-db psql -U tickets_user -d tickets_db -c 'select * from closed_events;'
docker compose exec logs-db psql -U logs_user -d logs_db -c 'select occurred_at, source, action, level, status from activity_logs order by occurred_at;'

# Ver mensagens que aguardam publicação
docker compose exec events-db psql -U events_user -d events_db -c 'select exchange, routing_key, created_at from outbox_messages where published_at is null;'
docker compose exec tickets-db psql -U tickets_user -d tickets_db -c 'select exchange, routing_key, created_at from outbox_messages where published_at is null;'
```

| Recurso | Endereço | Acesso |
|---|---|---|
| Swagger de eventos | http://localhost:8080/docs/events | Livre |
| Swagger de ingressos | http://localhost:8080/docs/tickets | Livre |
| Swagger de logs | http://localhost:8080/docs/logs | Livre |
| Grafana | http://localhost:8080/grafana/ | Sem login para ver; `admin` / `admin` para editar |
| Prometheus | http://localhost:8080/prometheus/targets | Livre |
| RabbitMQ | http://localhost:8080/rabbitmq/ | `events_tickets` / `events_tickets_pass` |
