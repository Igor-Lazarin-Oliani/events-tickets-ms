# Guia da implementação

Explicação do `events-tickets-ms` para estudo pessoal: o que foi construído, como funciona e por quê. A especificação formal está em [prompt.md](prompt.md), os contratos em [contratos-api.md](contratos-api.md) e o passo a passo da aula em [roteiro-apresentacao.md](roteiro-apresentacao.md).

## 1. O sistema em um minuto

É uma plataforma genérica de eventos e ingressos. Serve para simpósio, show, corrida ou campeonato, porque nada no código depende do tipo de evento. Inscrição e ingresso são a mesma coisa: ao se inscrever, a pessoa recebe um ingresso com código único e controle de presença. Tudo o que acontece fica registrado e pode ser consultado como histórico.

São dois microsserviços em tecnologias diferentes, cada um com seu banco:

- **`events-tickets-service`** (TypeScript/NestJS): cuida dos eventos, das vagas e dos ingressos.
- **`logs-service`** (Python/FastAPI): guarda o registro de atividades (o que aconteceu, com quem e quando) e permite fazer a triagem desses registros.

Eles conversam de duas formas:

- **RabbitMQ assíncrono:** cada mudança em eventos e ingressos vira uma mensagem que o `logs-service` grava. O serviço principal não espera por ele.
- **HTTP síncrono:** para mostrar o histórico de um evento ou ingresso, o serviço principal consulta o `logs-service`.

Na frente de tudo há um **API Gateway NGINX**, a única porta aberta (8080). **Prometheus** e **Grafana** coletam e exibem as métricas.

## 2. Por que essa divisão

Esta é a pergunta mais provável da banca, então vale saber de cor.

**Eventos e ingressos juntos.** A regra mais importante do domínio é não vender mais ingressos que vagas, e ela envolve as duas entidades ao mesmo tempo. Na versão 1 do projeto, eram dois serviços: para emitir um ingresso, o serviço de ingressos pedia a vaga ao de eventos por HTTP e, se depois não conseguisse salvar, precisava devolvê-la (compensação). Isso trazia problemas reais: um timeout deixava a dúvida se a vaga tinha sido reservada, e o processo podia morrer entre a reserva e o salvamento. No mesmo banco, tudo vira uma transação: ou acontece inteiro, ou nada acontece.

**Logs separados.** O registro de atividades tem características diferentes:

- só acrescenta dados, nunca altera o que aconteceu;
- pode crescer muito e ter outra política de retenção;
- não pode derrubar a venda se cair.

Por isso ele recebe as atividades de forma assíncrona e tem seu próprio banco. Se ficar fora do ar, vendas e inscrições continuam, e as mensagens esperam.

**Cuidado com a confusão:** o `logs-service` não é a observabilidade do sistema. Ele é um serviço de negócio (auditoria). A observabilidade técnica (métricas, painéis, logs dos contêineres) é feita por Prometheus e Grafana, e é isso que atende o item de telemetria do edital.

## 3. Os 8 contêineres

| Contêiner | Tecnologia | Função | Porta interna |
|---|---|---|---|
| `api-gateway` | NGINX 1.27 | Entrada única, publicada no host em `8080` | 80 |
| `events-tickets-service` | Node.js 20, NestJS, TypeORM | Eventos, vagas e ingressos | 3000 |
| `events-tickets-db` | PostgreSQL 16 | Banco exclusivo do serviço principal | 5432 |
| `logs-service` | Python 3.11, FastAPI, SQLAlchemy 2 | Registro de atividades | 8000 |
| `logs-db` | PostgreSQL 16 | Banco exclusivo dos logs | 5432 |
| `rabbitmq` | RabbitMQ 3.13 | Mensageria assíncrona | 5672 e 15672 |
| `prometheus` | Prometheus 2.55 | Coleta de métricas | 9090 |
| `grafana` | Grafana 11.4 | Painéis | 3000 |

Todos estão na rede interna `events-tickets-network`, onde se encontram pelo nome (`http://logs-service:8000`). Só o gateway é acessível de fora.

## 4. Onde fica cada coisa

```
events-tickets-ms/
├── docker-compose.yml                Sobe os 8 contêineres
├── frontend/                         Aplicação web, servida pelo gateway em /app/
├── gateway/nginx.conf                Rotas do API Gateway
├── messaging/rabbitmq.conf           Prefixo /rabbitmq da interface web
├── observability/
│   ├── prometheus/prometheus.yml     O que coletar e com que frequência
│   └── grafana/                      Fonte de dados e painel prontos
├── docs/                             Documentação
└── microservices/
    ├── events-tickets-service/src/
    │   ├── main.ts                   Monta a aplicação e o Swagger
    │   ├── database/                 Módulo com os repositórios das três tabelas
    │   ├── events/                   Controller, regras, repositório, entidade e DTOs de eventos
    │   ├── tickets/                  Controller, regras, repositório, entidade e DTOs de ingressos
    │   ├── outbox/                   Tabela outbox_messages e publicador do RabbitMQ
    │   ├── logs-integration/         Cliente HTTP que consulta o histórico
    │   ├── metrics/                  Métricas, /health, logs e correlação
    │   └── common/                   Erro padrão, validações e erros do PostgreSQL
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

## 5. `events-tickets-service`: eventos

### Tabela `events`

Os campos principais são `title`, `category`, `modality`, `location`, `start_at`, `end_at`, `max_capacity`, `available_spots`, `status` e `metadata_info`. Este último é um JSON livre, que deixa o evento genérico (palestrante, carga horária, classificação).

Status possíveis: `PUBLISHED`, `SOLD_OUT`, `CANCELLED` e `FINISHED`.

### Regras que você precisa saber explicar

**Reserva de vaga atômica.** É o ponto mais importante do sistema. Um único comando faz tudo:

```sql
UPDATE events
SET available_spots = available_spots - 1,
    status = CASE WHEN available_spots = 1 THEN 'SOLD_OUT' ELSE status END
WHERE id = :id AND status = 'PUBLISHED' AND available_spots > 0;
```

Se o código lesse o valor, subtraísse e salvasse, duas requisições simultâneas poderiam ver "1 vaga" e vender a mesma vaga. Com o `UPDATE` condicional, o banco serializa as escritas, e só uma consegue. No teste com 30 inscrições simultâneas para 5 vagas, foram emitidos exatamente 5 ingressos, e 25 receberam `409`.

**Devolução de vaga.** Mesma técnica, com o limite `available_spots < max_capacity`. Um evento `SOLD_OUT` volta a `PUBLISHED`; `CANCELLED` e `FINISHED` não mudam.

**Mudança de capacidade (D2).** Preserva as vagas ocupadas: `available_spots = nova capacidade - ocupadas`. Reduzir abaixo das ocupadas responde `409`. O `PUT` trava a linha com `SELECT ... FOR UPDATE`, para não concorrer com reservas.

**Evento cancelado é definitivo (D17).** Tentar mudar para outro status responde `409`. Os ingressos são cancelados sem devolver vagas; se o evento pudesse reabrir, essas vagas ficariam presas.

**Cancelar ou remover evento (D22).** Na mesma transação: trava o evento, cancela todos os ingressos ativos com um único `UPDATE ... RETURNING` e grava as atividades. Quando a resposta chega ao cliente, os ingressos já estão cancelados. Na versão 1, isso era assíncrono e tinha uma pequena janela de corrida; travar o evento antes de cancelar os ingressos a eliminou.

**Datas com fuso (D10).** `start_at` e `end_at` exigem fuso, como `-04:00` ou `Z`; sem isso, a resposta é `400`.

## 6. `events-tickets-service`: ingressos

### Tabela `tickets`

Campos: `ticket_code`, `event_id`, `event_snapshot`, `participant_name`, `participant_email`, `participant_document`, `modality_tier` e `status` (`CONFIRMED`, `CHECKED_IN` ou `CANCELLED`).

- **`event_id` não é chave estrangeira,** mesmo estando no mesmo banco. O ingresso precisa continuar existindo se o evento for removido.
- **`event_snapshot`** copia título, categoria, modalidade, local e data no momento da inscrição. Assim, o ingresso se mostra mesmo que o evento deixe de existir.
- **`ticket_code`** tem o formato `EVT-2026-XXXXXX`, gerado aleatoriamente. Em caso de colisão, tenta outro, até 5 vezes.

### Emissão: `POST /tickets`

1. Valida o corpo. Campo desconhecido responde `400`.
2. Busca o evento. Se não existir, `404`.
3. Verifica se o evento aceita inscrições. Evento que já terminou (`end_at` no passado) responde `400 Event has already ended` (D25); `SOLD_OUT` ou sem vagas responde `409`; `CANCELLED` ou `FINISHED` responde `400`.
4. Verifica se o documento já tem ingresso ativo no evento (`409`).
5. **Abre uma transação** e, dentro dela:
   - reserva a vaga com o `UPDATE` condicional, que também exige `end_at > now()` e devolve a linha com `RETURNING` (se outra pessoa levou a última, ou o evento fechou ou terminou nesse meio-tempo, `409`);
   - salva o ingresso como `CONFIRMED`;
   - grava as atividades `ticket.issued` e `event.spot_reserved` na outbox.
6. Faz o commit. Se qualquer passo falhar, o rollback desfaz tudo, inclusive a vaga.

**Savepoint na geração do código.** No PostgreSQL, um erro dentro da transação a invalida. Se o `ticket_code` colidir, a nova tentativa roda dentro de um *savepoint*: só o `INSERT` é desfeito, e a reserva da vaga continua valendo.

**Por que `SOLD_OUT` é verificado antes (D11)?** Senão, ele cairia na regra "status diferente de `PUBLISHED`" e responderia `400`, mas o correto para evento esgotado é `409`. O fim do evento vem antes de tudo (D25): um evento encerrado e esgotado responde `400`, porque o motivo real é o fim.

**Por que vale o fim, e não o início?** Um simpósio de vários dias aceita inscrições enquanto acontece. Depois do `end_at`, não há mais o que frequentar.

**Duplicidade (D3).** O passo 4 é só para dar uma resposta rápida. Quem garante de verdade é um índice único parcial:

```sql
CREATE UNIQUE INDEX uq_tickets_active_event_participant
ON tickets (event_id, participant_document)
WHERE status <> 'CANCELLED';
```

Duas requisições simultâneas podem passar pelo passo 4, mas o banco só aceita uma. A outra recebe `409`, e o rollback devolve a vaga. No teste com 10 inscrições simultâneas do mesmo documento, 1 foi emitida e as vagas das outras 9 voltaram.

### Cancelamento: `DELETE /tickets/{id}` (D1)

Na mesma transação:

1. Muda o status para `CANCELLED`, com a condição de o status ainda ser o que foi lido. Isso impede que dois cancelamentos simultâneos devolvam a vaga duas vezes.
2. Devolve a vaga com o `UPDATE` condicional.
3. Grava `ticket.cancelled` e `event.spot_released`.

O registro nunca é apagado (soft delete). Se o evento não existir mais, o cancelamento vale do mesmo jeito.

### Atualização e check-in: `PUT /tickets/{id}` (D12)

Altera só os campos enviados. Enviar `{"status": "CHECKED_IN"}` faz o check-in, aceito apenas a partir de `CONFIRMED`. Não dá para cancelar por aqui nem editar ingresso cancelado.

`GET /tickets/{id}` e `GET /tickets/{id}/history` aceitam o UUID ou o `ticket_code`.

## 7. `logs-service`

### Tabela `activity_logs`

| Campo | Para quê |
|---|---|
| `action` | O que aconteceu, como `ticket.issued` ou `incident.reported` |
| `entity_type`, `entity_id` | Sobre o quê (evento ou ingresso) |
| `level` | `INFO`, `WARNING` ou `ERROR` |
| `message`, `data` | Descrição e detalhes, sem dados pessoais |
| `source` | `events-tickets-service` ou `manual` |
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

| | RabbitMQ assíncrono | HTTP síncrono |
|---|---|---|
| Usado em | Gravar cada atividade no `logs-service` | Consultar o histórico (`/history`) |
| Por quê | Quem vende não pode esperar o registro, nem falhar se ele cair | O cliente pediu o histórico e precisa da resposta agora |
| Se o outro lado cair | A mensagem espera na outbox ou na fila e é entregue depois | Só a rota de histórico responde `503`; o resto funciona |
| Acoplamento | O serviço principal não sabe quem consome | O serviço principal conhece o endereço do `logs-service` |

### O caminho da mensagem

1. Uma operação muda eventos ou ingressos, por exemplo `POST /tickets`.
2. Na **mesma transação**, as mensagens entram em `outbox_messages`.
3. A API responde na hora.
4. A cada segundo, o `OutboxPublisher` conta as pendentes, conecta ao broker e só então abre a transação que trava um lote de até 50 (`FOR UPDATE SKIP LOCKED`). Publica em `events-tickets.exchange`, com a ação como routing key. Se o lote veio cheio, o próximo sai em seguida, sem esperar o segundo (D28).
5. O RabbitMQ confirma o recebimento (*publisher confirms*), e só então as linhas são marcadas como publicadas.
6. A mensagem vai para a fila `logs.activity`, ligada a `event.*` e `ticket.*`.
7. O `logs-service` grava e confirma.

**Por que outbox?** Publicar direto depois do commit cria um problema de escrita dupla: se o processo cair entre as duas operações, ou o broker estiver fora, o ingresso existe e o registro se perde. Com a outbox, a mensagem é gravada junto com a mudança: ou as duas acontecem, ou nenhuma.

**Por que `mandatory`?** Se o `logs-service` ainda não criou a fila (por exemplo, numa máquina limpa em que o serviço principal subiu primeiro), o broker descartaria a mensagem em silêncio. Com `mandatory`, ele a devolve, e o lote continua pendente até a fila existir.

**Dados pessoais.** As mensagens nunca levam nome, e-mail ou documento do participante. Quando o participante muda um dado, a mensagem `ticket.updated` diz só quais campos mudaram.

### O caminho do histórico

1. `GET /tickets/{id}/history` chega ao `events-tickets-service`.
2. O serviço confirma que o ingresso existe (`404` se não).
3. Chama `GET http://logs-service:8000/logs?entity_type=ticket&entity_id=...&order=asc`, com timeout de 3 s e o mesmo `X-Correlation-Id`.
4. Devolve `{ entity_type, entity_id, entries }`. Se o `logs-service` não responder, `503 Logs service unavailable`.

O histórico de um evento inclui `event.spot_reserved` e `event.spot_released`, com as vagas livres e o status em cada momento. É uma boa forma de mostrar o evento esgotando e reabrindo.

## 9. API Gateway

O arquivo `gateway/nginx.conf` funciona como lista de permissões: o que não está listado responde `404 Route not found`.

| Endereço | Destino |
|---|---|
| `/events`, `/events/{id}`, `/events/{id}/history` | `events-tickets-service` |
| `/tickets`, `/tickets/{id}`, `/tickets/{id}/history` | `events-tickets-service` |
| `/logs`, `/logs/{id}` | `logs-service` |
| `/docs/events-tickets`, `/docs/logs` | Swagger de cada serviço |
| `/health/events-tickets`, `/health/logs` | Saúde de cada serviço |
| `/metrics/events-tickets`, `/metrics/logs` | Métricas de cada serviço |
| `/grafana/` | Grafana |
| `/prometheus/` | Prometheus |
| `/rabbitmq/` | Interface do RabbitMQ |
| `/gateway/health` | Saúde do gateway |
| `/app/` (e `/`, que redireciona) | Aplicação web, servida pelo próprio gateway |

Detalhes úteis:

- **DNS em tempo de requisição:** os destinos ficam em variáveis, e o NGINX usa o DNS do Docker. Por isso, um serviço reiniciado com outro IP volta a ser encontrado.
- **Serviço fora do ar:** o gateway responde `503 Service unavailable`.
- **Swagger (D14):** cada serviço serve o Swagger no caminho público, para os dois não colidirem e o "Try it out" funcionar pelo gateway.
- **Aplicação web (D24):** arquivos estáticos de `frontend/`, sem build. Como estão na mesma origem da API, não há CORS, e a página entra pela porta 8080 como qualquer outro cliente. Ela não tem regra de negócio: chama as rotas públicas e desenha o caminho de cada chamada. A parte síncrona acompanha a resposta HTTP. A assíncrona só aparece quando o registro com o mesmo `X-Correlation-Id` chega ao `logs-service`. A saúde de cada contêiner vem de `/health/*`, da API do RabbitMQ e do Prometheus.

## 10. Observabilidade

### Três formas de observar

- **Métricas:** cada serviço expõe `/metrics`. O Prometheus coleta a cada 5 s, pela rede interna.
- **Painéis:** o Grafana lê o Prometheus e abre direto no painel "Visão Geral", sem login, somente leitura.
- **Logs estruturados:** cada linha tem uma etiqueta e um JSON.

### Métricas que valem citar

| Métrica | Serviço | Significado |
|---|---|---|
| `up` | Ambos | O Prometheus alcança o serviço? |
| `http_requests_total` | Ambos | Requisições por rota e status |
| `http_request_duration_*` | Ambos | Latência |
| `tickets_issued_total`, `tickets_cancelled_total` | Principal | Ingressos emitidos e cancelados |
| `events_spot_operations_total` | Principal | Reservas e devoluções, por resultado |
| `outbox_messages_published_total` | Principal | Mensagens confirmadas pelo RabbitMQ |
| `outbox_messages_pending` | Principal | Total de mensagens aguardando publicação, contado na tabela a cada ciclo |
| `logs_messages_consumed_total` | Logs | Mensagens consumidas, por resultado (`processed`, `duplicate`, `rejected`, `retried`) |
| `logs_entries_created_total` | Logs | Registros gravados, por origem (`rabbitmq` ou `api`) |

Os contadores ficam na memória do processo e **zeram quando o serviço reinicia**. Os dados de negócio continuam no banco.

### Rastreamento entre serviços

O cabeçalho `X-Correlation-Id` é criado no gateway, se não vier na requisição, e repassado aos serviços. Ele também vai em cada mensagem do RabbitMQ e fica gravado no registro do `logs-service`. Assim, um único comando mostra a operação inteira:

```sh
docker compose logs api-gateway events-tickets-service logs-service | grep <id>
```

E, pelo lado do negócio: `GET /logs?correlation_id=<id>`.

Etiquetas principais: `[GATEWAY]`, `[TELEMETRY]`, `[EVENT CREATED]`, `[TICKET ISSUED]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]`, `[TICKET CANCELLED]`, `[EVENT CANCELLED]`, `[ACTIVITY MESSAGE PUBLISHED]`, `[ACTIVITY LOGGED]`, `[HTTP SYNC REQUEST]` e `[HTTP SYNC RESPONSE]`.

E-mail e documento nunca vão para os logs nem para as mensagens.

## 11. Docker Compose

Ordem de subida, controlada por `depends_on` com `service_healthy`:

```
events-tickets-db, logs-db, rabbitmq
  → events-tickets-service e logs-service (em paralelo)
    → api-gateway e prometheus (só esperam o events-tickets-service)
      → grafana
```

- **Independência:** nada depende do `logs-service` para subir: nem o serviço principal, nem o gateway, nem o Prometheus (D27). Se ele falhar, a venda segue, e só as rotas de logs e de histórico respondem `503`.
- **Reinício automático:** todos os contêineres usam `restart: unless-stopped`. Um processo que cai volta sozinho; `docker compose stop` mantém parado, como nos experimentos de falha.
- **Healthchecks:** cada contêiner informa quando está pronto de verdade, não só iniciado.
- **Volumes:** `events_tickets_pgdata`, `logs_pgdata`, `rabbitmq_data` e `prometheus_data` mantêm os dados.
- **Sem `.env`:** os valores estão no `docker-compose.yml`, para bastar `docker compose up --build`.
- **Tabelas:** os serviços as criam ao subir, sem ferramenta de migração (D8). Mudou o modelo? Use `docker compose down -v`.
- **Retentativas:** além da ordem de subida, os serviços tentam reconectar ao banco e ao broker.

## 12. O que acontece quando algo falha

| Falha | Comportamento |
|---|---|
| Erro ao salvar o ingresso | `500`, e o rollback desfaz a reserva |
| Inscrição em evento encerrado ou inexistente | `400 Event has already ended` ou `404 Event not found`, sem consumir vaga |
| Processo de um serviço cai | O Docker o reinicia sozinho (`restart: unless-stopped`) |
| Muitas mensagens acumuladas na outbox | Os lotes de 50 saem um atrás do outro, sem esperar 1 s entre eles |
| Duas inscrições iguais ao mesmo tempo | Uma é emitida; a outra recebe `409`, e a vaga volta |
| Duas pessoas pela última vaga | Uma é emitida; a outra recebe `409` |
| Dois cancelamentos iguais ao mesmo tempo | Um funciona; a vaga volta uma única vez |
| Emissão durante o cancelamento do evento | Espera o lock: ou recebe `409`, ou é cancelada junto |
| `logs-service` fora | A API principal segue; o histórico responde `503`; as mensagens esperam na fila |
| RabbitMQ fora | A API principal segue; as mensagens esperam na outbox |
| Fila ainda não criada | O broker devolve a mensagem, que fica pendente até a fila existir |
| Mensagem duplicada | O `message_id` único impede o registro repetido |
| Mensagem inválida | Vai para a fila de mensagens mortas |
| `docker compose down` sem `-v` | Bancos e filas continuam nos volumes |

## 13. Decisões de projeto

Detalhes em [decisoes.md](decisoes.md).

| Decisão | Resumo | Status |
|---|---|---|
| D1 | Cancelar ingresso mantém o registro | Confirmada |
| D2 | Mudar a capacidade preserva as vagas ocupadas | Confirmada |
| D3 | Uma inscrição ativa por documento em cada evento | Confirmada |
| D4 | Testes das regras principais | Confirmada |
| D5 | Regras de transição de ingressos (compensação substituída pela D18) | Provisória |
| D6 | Remoção de evento com ingressos | Substituída pela D22 |
| D7 | Rastreamento por `X-Correlation-Id` | Provisória |
| D8 | Sem ferramenta de migração | Provisória |
| D9 | `README.md` na raiz | Provisória |
| D10 | Datas com fuso e `PUT` parcial em eventos | Provisória |
| D11 | Evento esgotado responde `409` | Provisória |
| D12 | `PUT` de ingresso parcial e estrito | Provisória |
| D13 | NGINX como única entrada | Confirmada |
| D14 | Swagger, saúde e métricas sob caminhos do gateway | Confirmada |
| D15 | Prometheus e Grafana | Ferramentas confirmadas; acesso provisório |
| D16 | RabbitMQ e outbox | Destino e conteúdo substituídos pela D20 |
| D17 | Evento cancelado não reabre | Provisória |
| D18 | Eventos e ingressos em um serviço; logs em outro | Confirmada |
| D19 | CRUD de logs: fato imutável, triagem e arquivamento | Confirmada |
| D20 | Toda mudança gera atividade pela outbox | Provisória |
| D21 | Histórico por HTTP síncrono | Confirmada |
| D22 | Cancelar ou remover evento cancela ingressos na mesma transação | Confirmada |
| D23 | Validação responde `400` no serviço principal | Provisória |
| D24 | Aplicação web estática servida pelo gateway | Confirmada |
| D25 | Evento encerrado não aceita inscrições | Regra confirmada |
| D26 | Listagens e históricos paginados, com o total | Provisória |
| D27 | Reinício automático e subida sem depender do `logs-service` | Provisória |
| D28 | Publicador da outbox sem gargalo | Provisória |

## 14. Testes

| Onde | Ferramenta | Cobre |
|---|---|---|
| `events-tickets-service/src/**/*.spec.ts` | Jest | Emissão (inclusive evento encerrado), cancelamento, cascata de evento, capacidade, paginação, DTOs, outbox (lotes, métrica e conexão fora da transação) e cliente HTTP do histórico |
| `logs-service/tests/` | `pytest` | CRUD, imutabilidade, arquivamento, filtros, Swagger, métricas e consumidor |

Eles usam simulações (Jest) e SQLite em memória (`pytest`), então rodam sem Docker. Por isso **não provam concorrência**: isso foi validado com os contêineres e o PostgreSQL reais (30 inscrições para 5 vagas, 10 inscrições simultâneas do mesmo documento, broker fora, `logs-service` fora e fila ainda não criada).

```sh
cd microservices/events-tickets-service && npm ci && npm test
cd microservices/logs-service && pip install -r requirements-dev.txt && pytest
```

## 15. Limitações conhecidas

Fale delas com tranquilidade: são escolhas de escopo.

- **Sem autenticação:** qualquer pessoa com acesso à API pode criar, cancelar e consultar dados, incluindo e-mail e documento, e pode arquivar registros. A autenticação ficou fora do escopo.
- **Histórico com cerca de 1 s de atraso:** o tempo de a outbox publicar e o `logs-service` gravar. Com o broker ou o `logs-service` fora, o atraso dura até eles voltarem; nada se perde.
- **Uma instância de cada serviço**, sem escala horizontal configurada.
- **Sem migrações** (D8). As listagens são paginadas (D26), mas a aplicação web mostra só a primeira página de cada uma, com um aviso quando há mais.
- **Credenciais fixas** no `docker-compose.yml`, aceitáveis só em ambiente local.
- **Métricas do gateway** não vão para o Prometheus; o NGINX aparece só nos logs.

## 16. Conceitos para a defesa

| Conceito | Em uma frase | Onde aparece |
|---|---|---|
| Database per Service | Cada serviço tem seu banco, e ninguém acessa o banco do outro | `events-tickets-db` e `logs-db` |
| Fronteira de contexto | O que precisa ser consistente junto fica no mesmo serviço | Eventos e ingressos juntos (D18) |
| API Gateway | Porta única que esconde a topologia interna | NGINX |
| Heterogeneidade | Serviços em tecnologias diferentes, conversando por padrões comuns | TypeScript e Python, via JSON |
| Transação local | Várias escritas que acontecem inteiras ou não acontecem | Reserva + emissão + outbox |
| Consistência eventual | Os dados ficam corretos pouco depois, não no mesmo instante | Histórico no `logs-service` |
| Padrão Outbox | Grava a mensagem na mesma transação do dado | `outbox_messages` |
| Entrega ao menos uma vez | A mensagem pode repetir, mas não se perde | RabbitMQ com confirmações |
| Idempotência | Repetir a operação não muda o resultado | `message_id` único no `logs-service` |
| Dead Letter Queue | Fila separada para mensagens que não podem ser processadas | `logs.activity.dlq` |
| Controle de concorrência | O banco impede duas escritas conflitantes | `UPDATE` condicional, índice único e `FOR UPDATE` |
| Isolamento de falhas | A queda de um serviço não derruba o outro | `logs-service` fora não impede vendas |
| Rastreamento distribuído | Um identificador acompanha a operação entre serviços | `X-Correlation-Id` |
| Topic exchange | Encaminha mensagens de acordo com a routing key | `events-tickets.exchange`, `event.*` e `ticket.*` |

## 17. Comandos úteis

```sh
docker compose up --build -d                    # constrói e sobe
docker compose ps                               # estado dos contêineres
docker compose logs -f events-tickets-service   # logs de um serviço
docker compose restart logs-service             # reinicia um serviço
docker compose down                             # derruba e mantém os dados
docker compose down -v                          # derruba e apaga os dados

# Inspecionar os bancos
docker compose exec events-tickets-db psql -U events_tickets_user -d events_tickets_db -c 'select title, available_spots, status from events;'
docker compose exec events-tickets-db psql -U events_tickets_user -d events_tickets_db -c 'select ticket_code, status from tickets;'
docker compose exec logs-db psql -U logs_user -d logs_db -c 'select occurred_at, action, level, status from activity_logs order by occurred_at;'

# Ver mensagens que aguardam publicação
docker compose exec events-tickets-db psql -U events_tickets_user -d events_tickets_db -c 'select routing_key, created_at from outbox_messages where published_at is null;'
```

| Recurso | Endereço | Acesso |
|---|---|---|
| Swagger de eventos e ingressos | http://localhost:8080/docs/events-tickets | Livre |
| Swagger de logs | http://localhost:8080/docs/logs | Livre |
| Grafana | http://localhost:8080/grafana/ | Sem login para ver; `admin` / `admin` para editar |
| Prometheus | http://localhost:8080/prometheus/targets | Livre |
| RabbitMQ | http://localhost:8080/rabbitmq/ | `events_tickets` / `events_tickets_pass` |
