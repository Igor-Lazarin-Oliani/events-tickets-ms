# Guia da implementação

Explicação do `events-tickets-ms` para estudo pessoal: o que foi construído, como funciona e por quê. A especificação formal está em [prompt.md](prompt.md), os contratos em [contratos-api.md](contratos-api.md) e o passo a passo da aula em [roteiro-apresentacao.md](roteiro-apresentacao.md).

## 1. O sistema em um minuto

É uma plataforma genérica de eventos e ingressos. Serve para simpósio, show, corrida ou campeonato, porque nada no código depende do tipo de evento. Inscrição e ingresso são a mesma coisa: ao se inscrever, a pessoa recebe um ingresso com código único e controle de presença.

São dois microsserviços em tecnologias diferentes, cada um com seu banco:

- **`events-service`** (Python/FastAPI): cuida dos eventos e é a autoridade sobre as vagas.
- **`tickets-service`** (TypeScript/NestJS): cuida das inscrições e dos ingressos.

Eles conversam de duas formas:

- **HTTP síncrono:** o `tickets-service` pergunta sobre o evento, reserva e devolve vagas. Precisa ser síncrono porque a pessoa está esperando a resposta.
- **RabbitMQ assíncrono:** quando um evento é cancelado ou removido, o `events-service` publica uma mensagem, e o `tickets-service` cancela os ingressos em segundo plano.

Na frente de tudo há um **API Gateway NGINX**, a única porta aberta (8080). **Prometheus** e **Grafana** coletam e exibem as métricas.

## 2. Os 8 contêineres

| Contêiner | Tecnologia | Função | Porta interna |
|---|---|---|---|
| `api-gateway` | NGINX 1.27 | Entrada única, publicada no host em `8080` | 80 |
| `events-service` | Python 3.11, FastAPI, SQLAlchemy 2 | Eventos e vagas | 8000 |
| `events-db` | PostgreSQL 16 | Banco exclusivo de eventos | 5432 |
| `tickets-service` | Node.js 20, NestJS, TypeORM | Ingressos e check-in | 3000 |
| `tickets-db` | PostgreSQL 16 | Banco exclusivo de ingressos | 5432 |
| `rabbitmq` | RabbitMQ 3.13 | Mensageria assíncrona | 5672 e 15672 |
| `prometheus` | Prometheus 2.55 | Coleta de métricas | 9090 |
| `grafana` | Grafana 11.4 | Painéis | 3000 |

Todos estão na rede interna `events-tickets-network`, onde se encontram pelo nome (`http://events-service:8000`). Só o gateway é acessível de fora.

## 3. Onde fica cada coisa

```
events-tickets-ms/
├── docker-compose.yml            Sobe os 8 contêineres
├── gateway/nginx.conf            Rotas do API Gateway
├── messaging/rabbitmq.conf       Prefixo /rabbitmq da interface web
├── observability/
│   ├── prometheus/prometheus.yml O que coletar e com que frequência
│   └── grafana/                  Fonte de dados e painel prontos
├── docs/                         Documentação
└── microservices/
    ├── events-service/app/
    │   ├── main.py               Monta a aplicação, /health e /metrics
    │   ├── core/
    │   │   ├── config.py         Variáveis de ambiente
    │   │   ├── database.py       Conexão com o banco
    │   │   └── telemetry.py      Logs, correlação e métricas próprias
    │   └── modules/events/
    │       ├── router.py         Rotas e documentação do Swagger
    │       ├── service.py        Regras de negócio
    │       ├── repository.py     Consultas ao banco
    │       ├── models.py         Tabelas events e outbox_messages
    │       ├── schemas.py        Validação de entrada e saída
    │       └── outbox.py         Publicação no RabbitMQ
    └── tickets-service/src/
        ├── main.ts               Monta a aplicação e o Swagger
        ├── tickets/              Controller, regras, entidade e DTOs
        ├── events-integration/   Cliente HTTP para o events-service
        ├── events-messaging/     Consumidor do RabbitMQ
        └── metrics/              Métricas, /health, logs e correlação
```

A organização é em camadas: a rota recebe, o serviço decide e o repositório acessa o banco. Nenhuma regra de negócio fica na rota.

## 4. `events-service`

### Tabela `events`

Os campos principais são `title`, `category`, `modality`, `location`, `start_at`, `end_at`, `max_capacity`, `available_spots`, `status` e `metadata_info`. Este último é um JSON livre, que deixa o evento genérico (palestrante, carga horária, classificação).

Status possíveis: `PUBLISHED`, `SOLD_OUT`, `CANCELLED` e `FINISHED`.

### Regras que você precisa saber explicar

**Reserva de vaga atômica.** É o ponto mais importante do serviço. Um único comando faz tudo:

```sql
UPDATE events
SET available_spots = available_spots - 1,
    status = CASE WHEN available_spots = 1 THEN 'SOLD_OUT' ELSE status END
WHERE id = :id AND status = 'PUBLISHED' AND available_spots > 0;
```

Se o código lesse o valor, subtraísse e salvasse, duas requisições simultâneas poderiam ver "1 vaga" e vender a mesma vaga. Com o `UPDATE` condicional, o banco serializa as escritas, e só uma consegue. Se nenhuma linha mudar, a API responde `404` ou `409`. O teste com 30 inscrições simultâneas para 5 vagas emitiu exatamente 5 ingressos.

**Devolução de vaga.** Mesma técnica, com o limite `available_spots < max_capacity`. Um evento `SOLD_OUT` volta a `PUBLISHED`. `CANCELLED` e `FINISHED` não mudam.

**Mudança de capacidade (D2).** Preserva as vagas ocupadas: `available_spots = nova capacidade - ocupadas`. Reduzir abaixo das ocupadas responde `409`. O `PUT` trava a linha com `SELECT ... FOR UPDATE`, para não concorrer com reservas.

**Evento cancelado é definitivo (D17).** Tentar mudar para outro status responde `409`. Se pudesse reabrir, as vagas dos ingressos cancelados ficariam presas, e uma mensagem atrasada poderia cancelar ingressos novos.

**Datas com fuso (D10).** `start_at` e `end_at` exigem fuso, como `-04:00` ou `Z`; sem isso, a resposta é `422`.

### Rotas

| Rota | Função | Pública? |
|---|---|---|
| `POST /events` | Cria (`available_spots = max_capacity`, `PUBLISHED`) | Sim |
| `GET /events` | Lista (filtros `category` e `status`) | Sim |
| `GET /events/{id}` | Detalha | Sim |
| `PUT /events/{id}` | Atualiza só os campos enviados | Sim |
| `DELETE /events/{id}` | Remove | Sim |
| `PATCH /events/{id}/reserve-spot` | Reserva vaga | Não, interna |
| `PATCH /events/{id}/release-spot` | Devolve vaga | Não, interna |

## 5. `tickets-service`

### Tabela `tickets`

Campos: `ticket_code`, `event_id`, `event_snapshot`, `participant_name`, `participant_email`, `participant_document`, `modality_tier` e `status` (`CONFIRMED`, `CHECKED_IN` ou `CANCELLED`).

- **`event_id` não é chave estrangeira.** O evento fica em outro banco, então a referência é lógica.
- **`event_snapshot`** copia título, categoria, modalidade, local e data no momento da inscrição. Assim, o ingresso se mostra sem consultar outro serviço, mesmo que o evento seja removido.
- **`ticket_code`** tem o formato `EVT-2026-XXXXXX`, gerado aleatoriamente. Em caso de colisão, tenta outro, até 5 vezes.

### Emissão: `POST /tickets`

1. Valida o corpo. Campo desconhecido responde `400`.
2. Busca o evento no `events-service`. Se não existir, `404`.
3. Verifica se o evento aceita inscrições. `SOLD_OUT` ou sem vagas responde `409`; `CANCELLED` ou `FINISHED` responde `400`.
4. Verifica se o documento já tem ingresso ativo no evento (`409`).
5. Reserva a vaga no `events-service`. Se outra pessoa levou a última, `409`.
6. Salva o ingresso como `CONFIRMED`.
7. Se salvar falhar, **devolve a vaga**. Isso é a compensação.

**Por que `SOLD_OUT` é verificado antes (D11)?** Na especificação original, ele cairia na regra "status diferente de `PUBLISHED`" e responderia `400`, mas o correto para evento esgotado é `409`.

**Duplicidade (D3).** O passo 4 é só para dar uma resposta rápida. Quem garante de verdade é um índice único parcial no banco:

```sql
CREATE UNIQUE INDEX uq_tickets_active_event_participant
ON tickets (event_id, participant_document)
WHERE status <> 'CANCELLED';
```

Duas requisições simultâneas podem passar pelo passo 4, mas o banco só aceita uma. A outra recebe `409`, e sua vaga é devolvida. Como o índice ignora cancelados, quem cancelou pode se inscrever de novo.

### Cancelamento: `DELETE /tickets/:id` (D1)

1. Muda o status para `CANCELLED`, com a condição de o status ainda ser o que foi lido. Isso impede que dois cancelamentos simultâneos devolvam a vaga duas vezes.
2. Chama `release-spot`.
3. Se o evento não existir mais, mantém o cancelamento.
4. Se o `events-service` falhar, **restaura o status anterior** e responde `503`.

O registro nunca é apagado (soft delete).

### Atualização e check-in: `PUT /tickets/:id` (D12)

Altera só os campos enviados. Enviar `{"status": "CHECKED_IN"}` faz o check-in, aceito apenas a partir de `CONFIRMED`. Não dá para cancelar por aqui nem editar ingresso cancelado.

`GET /tickets/:id` aceita o UUID ou o `ticket_code`.

## 6. Síncrono x assíncrono

| | HTTP síncrono | RabbitMQ assíncrono |
|---|---|---|
| Usado em | Validar evento, reservar e devolver vaga | Cancelar ingressos de evento cancelado ou removido |
| Por quê | O cliente precisa da resposta agora | Pode haver muitos ingressos, e quem cancelou não precisa esperar |
| Se o outro lado cair | Falha na hora, com `503` | A mensagem espera e é entregue depois |
| Acoplamento | O `tickets-service` conhece o `events-service` | O `events-service` não sabe quem consome |

### O caminho da mensagem

1. `PUT /events/{id}` com `CANCELLED`, ou `DELETE /events/{id}`.
2. Na **mesma transação**, o evento muda e uma linha entra em `outbox_messages`.
3. A API responde na hora.
4. Uma thread do `events-service` verifica a outbox a cada segundo e publica as mensagens pendentes em `events.exchange`.
5. O RabbitMQ confirma o recebimento (*publisher confirms*), e só então a linha é marcada como publicada.
6. A mensagem vai para a fila `tickets.event-updates`.
7. O `tickets-service` cancela os ingressos ativos do evento e confirma (`ack`) depois de gravar.

**Por que outbox?** Publicar direto depois do commit cria um problema de escrita dupla: se o processo cair entre as duas operações, ou o broker estiver fora, o evento fica cancelado e a mensagem se perde. Com a outbox, a mensagem é gravada junto com a mudança: ou as duas acontecem, ou nenhuma.

**Por que o consumidor é idempotente?** A entrega é "ao menos uma vez", então a mesma mensagem pode chegar duas vezes. Como o comando é "cancele os ingressos ainda ativos", repetir não muda nada.

**Por que não devolve vagas?** O evento não aceita mais inscrições, então não há o que devolver.

**Mensagens inválidas** vão para a fila `tickets.event-updates.dlq`. **Falhas temporárias**, como banco fora do ar, voltam para a fila após 5 s.

Filas e mensagens são duráveis, e o RabbitMQ tem volume e `hostname` fixo, por isso sobrevivem a reinícios.

## 7. API Gateway

O arquivo `gateway/nginx.conf` funciona como lista de permissões: o que não está listado responde `404 Route not found`.

| Endereço | Destino |
|---|---|
| `/events`, `/events/{id}` | `events-service` |
| `/tickets`, `/tickets/{id}` | `tickets-service` |
| `/docs/events`, `/docs/tickets` | Swagger de cada serviço |
| `/health/events`, `/health/tickets` | Saúde de cada serviço |
| `/metrics/events`, `/metrics/tickets` | Métricas de cada serviço |
| `/grafana/` | Grafana |
| `/prometheus/` | Prometheus |
| `/rabbitmq/` | Interface do RabbitMQ |
| `/gateway/health` | Saúde do gateway |

Detalhes úteis:

- **Rotas internas protegidas (D13):** `reserve-spot` e `release-spot` não existem para quem vem de fora. O `tickets-service` as alcança pela rede Docker, sem passar pelo gateway.
- **DNS em tempo de requisição:** os destinos ficam em variáveis, e o NGINX usa o DNS do Docker. Por isso, um serviço reiniciado com outro IP volta a ser encontrado.
- **Serviço fora do ar:** o gateway responde `503 Service unavailable`.
- **Swagger (D14):** cada serviço serve o Swagger no caminho público, como `/docs/events`, para os dois não colidirem e o "Try it out" funcionar pelo gateway. No Swagger, as rotas internas, `/health` e `/metrics` aparecem documentadas, mas respondem `404` pelo gateway.

## 8. Observabilidade

### Três formas de observar

- **Métricas:** cada serviço expõe `/metrics`. O Prometheus coleta a cada 5 s, pela rede interna.
- **Painéis:** o Grafana lê o Prometheus e abre direto no painel "Visão Geral", sem login, somente leitura.
- **Logs estruturados:** cada linha tem uma etiqueta e um JSON.

### Métricas que valem citar

| Métrica | Significado |
|---|---|
| `up` | O Prometheus alcança o serviço? |
| `http_requests_total` | Requisições por rota e status |
| `http_request_duration_*` | Latência |
| `tickets_issued_total`, `tickets_cancelled_total` | Ingressos emitidos e cancelados |
| `events_spot_operations_total` | Reservas e devoluções, por resultado |
| `events_messages_published_total` | Mensagens confirmadas pelo RabbitMQ |
| `tickets_event_messages_consumed_total` | Mensagens consumidas, por resultado |
| `events_outbox_pending` | Mensagens aguardando publicação |

Os contadores ficam na memória do processo e **zeram quando o serviço reinicia**. Os dados de negócio continuam no banco.

### Rastreamento entre serviços

O cabeçalho `X-Correlation-Id` é criado no gateway, se não vier na requisição, e repassado aos serviços. Também é gravado na mensagem do RabbitMQ. Assim, um único comando mostra a operação inteira:

```sh
docker compose logs api-gateway events-service tickets-service | grep <id>
```

Etiquetas principais: `[GATEWAY]`, `[TELEMETRY]`, `[HTTP SYNC REQUEST]`, `[HTTP SYNC RESPONSE]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]`, `[TICKET ISSUED]`, `[TICKET CANCELLED]`, `[COMPENSATION APPLIED]`, `[EVENT MESSAGE QUEUED]`, `[EVENT MESSAGE PUBLISHED]`, `[EVENT MESSAGE RECEIVED]` e `[TICKETS CANCELLED BY EVENT]`.

E-mail e documento nunca vão para os logs.

## 9. Docker Compose

Ordem de subida, controlada por `depends_on` com `service_healthy`:

```
events-db, tickets-db, rabbitmq
  → events-service
    → tickets-service
      → api-gateway e prometheus
        → grafana
```

- **Healthchecks:** cada contêiner informa quando está pronto de verdade, não só iniciado.
- **Volumes:** `events_pgdata`, `tickets_pgdata`, `rabbitmq_data` e `prometheus_data` mantêm os dados.
- **Sem `.env`:** os valores estão no `docker-compose.yml`, para bastar `docker compose up --build`.
- **Tabelas:** os serviços as criam ao subir, sem ferramenta de migração (D8). Mudou o modelo? Use `docker compose down -v`.
- **Retentativas:** além da ordem de subida, os serviços tentam reconectar ao banco e ao broker.

## 10. O que acontece quando algo falha

| Falha | Comportamento |
|---|---|
| `events-service` fora, ao emitir ingresso | `503`, sem criar ingresso |
| `events-service` fora, ao cancelar ingresso | `503`, e o ingresso volta ao status anterior |
| `events-service` fora, ao acessar `/events` pelo gateway | `503 Service unavailable` |
| Erro ao salvar o ingresso | `500`, e a vaga é devolvida |
| Duas inscrições iguais ao mesmo tempo | Uma é emitida; a outra recebe `409`, e a vaga volta |
| Duas pessoas pela última vaga | Uma é emitida; a outra recebe `409` |
| Dois cancelamentos iguais ao mesmo tempo | Um funciona; a vaga volta uma única vez |
| RabbitMQ fora | A API síncrona segue; a mensagem aguarda na outbox |
| `tickets-service` fora | A mensagem aguarda na fila |
| Mensagem duplicada | Sem efeito adicional |
| Mensagem inválida | Vai para a fila de mensagens mortas |
| `docker compose down` sem `-v` | Bancos e filas continuam nos volumes |

## 11. Decisões de projeto

Detalhes em [decisoes.md](decisoes.md).

| Decisão | Resumo | Status |
|---|---|---|
| D1 | Cancelar ingresso mantém o registro | Confirmada |
| D2 | Mudar a capacidade preserva as vagas ocupadas | Confirmada |
| D3 | Uma inscrição ativa por documento em cada evento | Confirmada |
| D4 | Testes das regras principais | Confirmada |
| D5 | Regras de transição e compensação de ingressos | Provisória |
| D6 | Evento com ingressos pode ser removido | Provisória |
| D7 | Rastreamento por `X-Correlation-Id` | Provisória |
| D8 | Sem ferramenta de migração | Provisória |
| D9 | `README.md` na raiz | Provisória |
| D10 | Datas com fuso e `PUT` parcial em eventos | Provisória |
| D11 | Evento esgotado responde `409` | Provisória |
| D12 | `PUT` de ingresso parcial e estrito | Provisória |
| D13 | NGINX como única entrada | Confirmada |
| D14 | Swagger, saúde e métricas sob caminhos do gateway | Confirmada |
| D15 | Prometheus e Grafana | Ferramentas confirmadas; acesso provisório |
| D16 | RabbitMQ e outbox | RabbitMQ confirmado; outbox provisória |
| D17 | Evento cancelado não reabre | Provisória |

## 12. Testes

| Onde | Ferramenta | Cobre |
|---|---|---|
| `events-service/tests/` | `pytest` | Vagas, status, capacidade, Swagger, métricas e outbox |
| `tickets-service/src/**/*.spec.ts` | Jest | Emissão, cancelamento, compensações, DTOs, cliente HTTP e consumidor |

Eles usam SQLite em memória (`pytest`) e simulações (Jest), então rodam sem Docker. Por isso **não provam concorrência**: isso foi validado separadamente, com os contêineres e PostgreSQL reais, por scripts temporários que não fazem parte do repositório.

```sh
cd microservices/events-service && pip install -r requirements-dev.txt && pytest
cd microservices/tickets-service && npm ci && npm test
```

## 13. Limitações conhecidas

Fale delas com tranquilidade: são escolhas de escopo.

- **Sem autenticação:** qualquer pessoa com acesso à API pode criar, cancelar e consultar dados, incluindo e-mail e documento. A autenticação ficou fora do escopo.
- **Timeout entre serviços:** se `reserve-spot` ou `release-spot` esgotar o tempo, o `tickets-service` não sabe se a operação foi aplicada. Uma vaga pode ficar presa ou ser devolvida a mais. A correção seria uma chave de idempotência.
- **Janela de corrida:** um ingresso cuja reserva terminou antes do cancelamento do evento, mas salvo depois de a mensagem ser processada, pode ficar ativo. A janela é de milissegundos.
- **Uma instância de cada serviço**, sem escala horizontal configurada.
- **Sem migrações** e **sem paginação** nas listagens.
- **Credenciais fixas** no `docker-compose.yml`, aceitáveis só em ambiente local.
- **Métricas do gateway** não vão para o Prometheus; o NGINX aparece só nos logs.

## 14. Conceitos para a defesa

| Conceito | Em uma frase | Onde aparece |
|---|---|---|
| Database per Service | Cada serviço tem seu banco, e ninguém acessa o banco do outro | `events-db` e `tickets-db` |
| API Gateway | Porta única que esconde a topologia interna | NGINX |
| Heterogeneidade | Serviços em tecnologias diferentes, conversando por padrões comuns | Python e TypeScript, via JSON |
| Saga e compensação | Sem transação distribuída, cada falha desfaz o passo anterior | Devolver vaga, restaurar status |
| Consistência eventual | Os dados ficam corretos pouco depois, não no mesmo instante | Ingressos após cancelar evento |
| Padrão Outbox | Grava a mensagem na mesma transação do dado | `outbox_messages` |
| Entrega ao menos uma vez | A mensagem pode repetir, mas não se perde | RabbitMQ com confirmações |
| Idempotência | Repetir a operação não muda o resultado | `cancelAllForEvent` |
| Dead Letter Queue | Fila separada para mensagens que não podem ser processadas | `tickets.event-updates.dlq` |
| Controle de concorrência | O banco impede duas escritas conflitantes | `UPDATE` condicional e índice único |
| Rastreamento distribuído | Um identificador acompanha a operação entre serviços | `X-Correlation-Id` |
| Topic exchange | Encaminha mensagens de acordo com a routing key | `events.exchange` |

## 15. Comandos úteis

```sh
docker compose up --build -d             # constrói e sobe
docker compose ps                        # estado dos contêineres
docker compose logs -f tickets-service   # logs de um serviço
docker compose restart events-service    # reinicia um serviço
docker compose down                      # derruba e mantém os dados
docker compose down -v                   # derruba e apaga os dados

# Inspecionar os bancos
docker compose exec events-db psql -U events_user -d events_db -c 'select title, available_spots, status from events;'
docker compose exec tickets-db psql -U tickets_user -d tickets_db -c 'select ticket_code, status from tickets;'

# Ver mensagens que aguardam publicação
docker compose exec events-db psql -U events_user -d events_db -c 'select routing_key, created_at from outbox_messages where published_at is null;'
```

| Recurso | Endereço | Acesso |
|---|---|---|
| Swagger de eventos | http://localhost:8080/docs/events | Livre |
| Swagger de ingressos | http://localhost:8080/docs/tickets | Livre |
| Grafana | http://localhost:8080/grafana/ | Sem login para ver; `admin` / `admin` para editar |
| Prometheus | http://localhost:8080/prometheus/targets | Livre |
| RabbitMQ | http://localhost:8080/rabbitmq/ | `events_tickets` / `events_tickets_pass` |
