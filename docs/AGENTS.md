# AGENTS.md — instruções para agentes de código

`events-tickets-ms`: plataforma distribuída de gestão de eventos e emissão unificada de inscrições/ingressos, com registro de atividades. Trabalho Prático de Sistemas Distribuídos (UFMS), avaliado em máquina limpa com `git clone` e `docker compose up --build`.

Três microsserviços, cada um com seu banco: `events-service` (eventos e vagas, NestJS em JavaScript), `tickets-service` (ingressos e check-in, NestJS em TypeScript) e `logs-service` (registro de atividades, Python). O `tickets-service` reserva vagas no `events-service` por HTTP; vagas devolvidas, eventos encerrados e atividades viajam pelo RabbitMQ; o histórico é consultado no `logs-service` por HTTP.

**Leia primeiro:** [prompt.md](prompt.md), a especificação completa. Este arquivo traz só as regras.

| Preciso de... | Veja |
|---|---|
| requisitos, modelo de dados, fases de desenvolvimento | [prompt.md](prompt.md) |
| topologia, variáveis, o que já está implementado | [arquitetura.md](arquitetura.md) |
| endpoints, regras de negócio, mensagens, erros | [contratos-api.md](contratos-api.md) (também o Swagger em `/docs/events`, `/docs/tickets` e `/docs/logs`) |
| por que algo foi decidido assim | [decisoes.md](decisoes.md) |
| explicação geral e roteiro da aula | [guia-da-implementacao.md](guia-da-implementacao.md) e [roteiro-apresentacao.md](roteiro-apresentacao.md) |

Se [decisoes.md](decisoes.md) e [prompt.md](prompt.md) divergirem, vale a decisão registrada.

## Comandos de desenvolvimento

```sh
# subir tudo, como na avaliação
docker compose up --build -d
docker compose ps
docker compose logs -f events-service tickets-service logs-service

# recriar os bancos do zero (apaga os dados)
docker compose down -v

# testes
cd microservices/events-service && npm ci && npm test       # Jest + Babel, sem banco
cd microservices/tickets-service && npm ci && npm test      # Jest + ts-jest, sem banco
cd microservices/logs-service && pip install -r requirements-dev.txt && pytest   # Python 3.11; SQLite em memória
```

| Recurso | Endereço |
|---|---|
| Aplicação web | http://localhost:8080/ (redireciona para `/app/`) |
| Swagger de eventos, ingressos e logs | http://localhost:8080/docs/events · `/docs/tickets` · `/docs/logs` |
| Métricas | http://localhost:8080/metrics/events · `/metrics/tickets` · `/metrics/logs` |
| Painel Grafana | http://localhost:8080/grafana/ |
| Prometheus | http://localhost:8080/prometheus/ |
| RabbitMQ | http://localhost:8080/rabbitmq/ (`events_tickets` / `events_tickets_pass`) |

## Mapa do repositório

```
/
├── docker-compose.yml · README.md
├── docs/                          # toda a documentação, inclusive este arquivo
├── frontend/                      # aplicação web estática, servida pelo api-gateway em /app/
├── gateway/                       # configuração do NGINX
├── messaging/                     # configuração do RabbitMQ
├── observability/                 # configuração do Prometheus e do Grafana
└── microservices/
    ├── events-service/            # Node.js 20 + NestJS em JavaScript + TypeORM (porta 3001)
    ├── tickets-service/           # Node.js 20 + NestJS em TypeScript + TypeORM (porta 3002)
    └── logs-service/              # Python 3.11 + FastAPI + SQLAlchemy (porta 8000)
```

A árvore completa está na [seção 7 do prompt.md](prompt.md#7-estrutura-de-diretórios-modularizada-esperada).

<a id="nunca-viole"></a>

## Nunca viole

1. **NUNCA faça `git commit` nem `git push`.** Ao concluir uma entrega, apenas informe a frase de commit sugerida.
2. **Só os 10 contêineres previstos:** `api-gateway`, `events-db`, `events-service`, `tickets-db`, `tickets-service`, `logs-db`, `logs-service`, `rabbitmq`, `prometheus` e `grafana`. Nada além disso sem pedido do autor.
   **O edital (`trabalho_cd.pdf`) define a nota:** confira-o antes de fechar uma entrega.
3. **Database per Service.** Cada serviço acessa só o próprio banco. O `tickets-service` nunca lê o `events_db`: obtém o evento na resposta da reserva. O `logs-service` não lê os outros bancos; as atividades chegam pelo RabbitMQ, e o histórico sai por HTTP.
4. **Vagas só mudam no `events-service`, por `UPDATE` condicional.** Só a reserva, a devolução e a alteração de capacidade mudam `available_spots`, sempre na transação que grava a reserva, a devolução ou a mudança.
5. **Máquina limpa.** Nada de passo manual, `.env` obrigatório ou dependência instalada no host: o `docker compose up --build` precisa bastar.
6. **Toda escrita é atômica com suas mensagens.** A mudança e as mensagens da outbox entram na mesma transação; nunca publique no RabbitMQ direto de um endpoint ou de um consumidor (D20).
7. **O `logs-service` nunca bloqueia a venda.** Ninguém depende dele para subir nem para escrever; só as rotas `/history` podem responder `503` (D21, D27).
8. **Registro de atividade é imutável.** No `logs-service`, só `status` e `notes` mudam; `DELETE` arquiva (D19).
9. **Reserva e devolução são idempotentes pelo `ticket_id`.** Toda reserva grava uma linha em `spot_reservations`; toda devolução passa por essa linha. Nunca devolva vaga sem ela (D30, D31).
10. **Swagger completo nas três APIs.** Endpoint novo ou alterado sai com resumo, exemplos e códigos de resposta em `/docs/events`, `/docs/tickets` ou `/docs/logs`.

<a id="armadilhas"></a>

## Armadilhas

- **Reserva e devolução precisam ser atômicas.** Use um único `UPDATE` condicional, nunca ler, calcular e salvar. A consulta prévia na reserva só melhora a mensagem; se o `UPDATE` não mudar linha, responda `409`.
- **O `id` do ingresso nasce antes da reserva.** O `tickets-service` gera o UUID, reserva com ele e salva o ingresso com ele (`@PrimaryColumn`). Gerar outro `id` ao salvar quebra a devolução da vaga.
- **Sem resposta definitiva do `events-service`, peça a devolução.** Timeout, `5xx` ou serviço fora do ar viram `503 Events service unavailable` **e** `spot.release_requested`; a devolução de uma reserva que não existe só grava a linha `RELEASED` (D30).
- **Falha depois da reserva também compensa.** Qualquer erro no salvamento do ingresso grava `spot.release_requested` com `reason: issue_failed`, fora da transação que falhou.
- **Devolução sem reserva grava `RELEASED`.** É o que recusa uma reserva atrasada do mesmo `ticket_id`; não troque por "ignorar" (D31).
- **Emissão e cascata usam o mesmo lock consultivo.** `pg_advisory_xact_lock(hashtextextended(event_id, 0))` no início das duas transações, e `closed_events` conferido dentro da transação da emissão (D32).
- **Cascata não devolve vagas.** O consumidor de `event.cancelled`/`event.deleted` cancela os ingressos e não publica `spot.release_requested`.
- **Erro dentro de transação do PostgreSQL invalida a transação.** Para tentar outro `ticket_code` após colisão, use `manager.transaction(...)` aninhado, que cria um savepoint. Sem isso, a segunda tentativa falha com "current transaction is aborted".
- **Alteração de capacidade e cancelamento de evento concorrem com reservas.** `PUT` e `DELETE /events/{id}` leem a linha com `SELECT ... FOR UPDATE` antes de recalcular ou de fechar o evento (D22, D33).
- **Duplicidade é garantida no banco.** Quem barra requisições simultâneas é o índice único parcial em `(event_id, participant_document)` para status diferente de `CANCELLED`. A violação desfaz a transação do ingresso, e a vaga é devolvida pela compensação.
- **`tickets.event_id` não tem chave estrangeira.** O evento está em outro banco, e o ingresso precisa sobreviver à remoção dele, com o `event_snapshot`.
- **`GET /tickets/:id` e `/tickets/:id/history` aceitam UUID ou `ticket_code`.** Não aplique `ParseUUIDPipe` nessas rotas.
- **`synchronize` e `create_all` não servem de migração segura.** Mudou o modelo? Rode `docker compose down -v`. Este projeto não usa migrações (D8). Os volumes `events_pgdata` e `tickets_pgdata` têm o mesmo nome dos da versão 1, com outro esquema (D36).
- **`depends_on` com `service_healthy` exige `healthcheck`.** A imagem `python:3.11-slim` não tem `curl`; o `logs-service` usa `python -c` com `urllib`.
- **Dentro da rede Docker, use nome de serviço e porta interna:** `events-service:3001`, `tickets-service:3002`, `logs-service:8000` e `<banco>:5432`. Só o `api-gateway` publica porta no host (`8080`); para inspecionar um banco, use `docker compose exec`.
- **Gateway usa lista de rotas permitidas.** Rota nova precisa de `location` em `gateway/nginx.conf`, senão responde `404`. A `reserve-spot` fica de fora de propósito.
- **A aplicação web não tem build nem dependência externa (D24).** `frontend/` é servido como está pelo `api-gateway`; nada de framework, `npm` ou CDN, porque a avaliação pode acontecer sem internet boa.
- **A aplicação web não decide regra de negócio.** Ela só chama rotas públicas e exibe as respostas; vagas, duplicidade e transições ficam nos serviços.
- **O `nginx.conf` não carrega `mime.types` no `http`.** O padrão do servidor é `application/json`; o `location /app/` inclui `mime.types` para servir HTML, CSS e JS com o tipo certo.
- **Textos da API entram na página como texto, nunca como HTML.** Use o `h()` de `frontend/js/util.js`, que cria nós com `textContent`.
- **`proxy_pass` do gateway usa variável e `resolver` do Docker.** Sem isso, o NGINX guarda o IP antigo quando um serviço reinicia.
- **`npm ci` no Dockerfile exige `package-lock.json` versionado.** Instalando no Windows, o `postinstall` do `@scarf/scarf` pode ser barrado; use `npm install --ignore-scripts` (o lockfile não muda).
- **Rótulo de métrica usa o padrão da rota** (`/tickets/:id`), nunca a URL real, para não explodir a cardinalidade.
- **Testes dos serviços NestJS simulam o banco; os do `logs-service` usam SQLite em memória.** Concorrência, `FOR UPDATE`, lock consultivo, índice parcial e savepoints só se confirmam com PostgreSQL real, em contêiner.
- **Healthcheck do PostgreSQL usa `pg_isready -h localhost`.** Sem `-h`, o teste pode passar no servidor temporário de inicialização da imagem.
- **`SOLD_OUT` responde `409`, nunca `400`.** Na reserva, ele é verificado antes da regra de status geral (D11).
- **`correlationMiddleware` fica no `app.use` antes do `listen`.** O contexto do `AsyncLocalStorage` precisa cobrir toda a requisição até a outbox e os clientes HTTP. Consumidores rodam com `runWithCorrelationId` da mensagem.
- **`@IsOptional` aceita `null`.** Em coluna obrigatória use `IfPresent` (`common/validation`), senão o `null` só falha no banco, com `500`.
- **Validação responde `400` nos serviços NestJS e `422` no FastAPI** (D23). Documente o código certo em cada Swagger.
- **OpenAPI fica em `/docs/{events,tickets,logs}/openapi.json`,** servida sob o caminho público e sem `servers`, para o "Try it out" usar o gateway (D14).
- **Prometheus e Grafana rodam sob prefixo.** A API do Prometheus fica em `/prometheus/api/...`, inclusive na rede interna.
- **Rótulos HTTP diferem entre os serviços.** Nos serviços NestJS: `route` e `status="201"`; no `logs-service`: `handler` e `status="2xx"`. Filtre erros com `status=~"[45].."` e use `job` para separar os serviços.
- **Contadores zeram quando o serviço reinicia.** Os dados de negócio continuam no banco.
- **Painel é arquivo.** Edite `observability/grafana/dashboards/events-tickets.json`: alterações pela interface não são salvas.
- **Uma fila por exchange e routing key (D34).** Não ligue duas filas à mesma routing key de uma exchange: com `mandatory`, a mensagem que chega a uma só não é devolvida, e a outra fila a perde. Cada consumidor declara a própria fila; o publicador só declara as exchanges.
- **Mensagem devolvida fica pendente sozinha.** O lote marca como publicadas só as confirmadas e não devolvidas (D34).
- **O consumidor precisa ser idempotente.** A entrega é "ao menos uma vez": `message_id` único no `logs-service`, reserva por `ticket_id` no `events-service` e `closed_events` + `UPDATE` só de ingressos ativos no `tickets-service`. Confirme (`ack`) só depois de gravar; mensagem inválida vai para a DLQ, nunca volta para a fila.
- **`amqplib` derruba o processo em evento `error` sem ouvinte.** Mantenha os ouvintes na conexão e no canal dos publicadores e consumidores.
- **Reconexão de consumidor `amqplib` só depois de consumir.** O `close` de uma conexão que falhou na subida não pode abrir um segundo laço de reconexão.
- **`BlockingConnection` do `pika` não é thread-safe.** O consumidor roda em thread própria; pare-o com `add_callback_threadsafe`.
- **Falha do broker não pode afetar a API síncrona.** Publicadores e consumidores conectam em segundo plano, com novas tentativas.
- **O `rabbitmq` precisa de `hostname` fixo.** Os dados ficam em pasta com o nome do nó; sem isso, filas e mensagens somem ao recriar o contêiner.
- **`events_tickets` no lugar de `guest`.** O usuário `guest` só aceita conexões locais do próprio contêiner.
- **Toda chamada HTTP entre serviços tem timeout.** Sem resposta vira `503`, nunca requisição pendurada.
- **Evento encerrado não aceita inscrição (D25).** A regra fica na consulta prévia da reserva (`400 Event has already ended`) e no `UPDATE` condicional (`"end_at" > now()`), que responde `409` se o evento terminar no meio. Mexeu na reserva? Mantenha as duas.
- **Datas de exemplo e de teste precisam estar no futuro.** Swagger, README e roteiro usam 2027; as fixtures usam `FUTURE_YEAR` (`testing/fakes`). Uma data fixa que vence quebra a demonstração e os testes.
- **Listagens são paginadas (D26).** `limit` de 1 a 500 e `offset`, com o total no cabeçalho `X-Total-Count`; o corpo continua sendo uma lista. Para contar, use o `X-Total-Count` (com `limit=1`), nunca o tamanho da lista.
- **Paginação estável precisa de desempate.** Ordene por `created_at` e `id`, senão itens criados no mesmo instante se repetem ou somem entre páginas.
- **Histórico paginado.** O `total` vem do `X-Total-Count` do `logs-service`; se o `GET /logs` mudar, mantenha o cabeçalho.
- **Rede fora da transação na outbox (D28).** Conecte ao broker antes de abrir a transação que trava as mensagens; dentro dela, só o envio do lote e a confirmação.
- **Lote cheio publica o próximo em seguida.** O `runCycle` devolve `0` de espera quando o lote veio com `BATCH_SIZE` mensagens; não volte a esperar o intervalo com acúmulo.
- **`outbox_messages_pending` é o acúmulo total**, contado com `COUNT` a cada ciclo, e não o tamanho do lote.
- **`restart: unless-stopped` em todos os contêineres (D27).** `docker compose stop` mantém parado, como nos experimentos de falha. Contêineres no ar voltam quando o Docker reinicia: encerre com `docker compose down`.
- **Nenhum serviço depende de outro para subir (D27, D36).** Não acrescente `depends_on` entre serviços; o gateway e o Prometheus esperam só o `events-service` e o `tickets-service`.
- **Nunca logue nem publique `participant_name`, `participant_email` ou `participant_document`:** os logs são exibidos ao vivo, e as mensagens ficam guardadas.

### JavaScript no `events-service` (D35)

- **Sem tipos, sem injeção automática.** Toda classe com dependências usa `@Dependencies(...)`, na ordem do construtor; repositórios do TypeORM entram por `getRepositoryToken(Entidade)`.
- **Sem decorators de parâmetro.** Use `@Bind(Param('id', ParseUUIDPipe), ValidBody(Dto))` no método.
- **Corpo e query string sempre por `ValidBody(Dto)` e `ValidQuery(Dto)`.** `@Body()` sozinho não valida nada: o `ValidationPipe` não sabe o DTO.
- **Todo `@ApiProperty` declara `type` (ou `enum`).** Sem isso, o Swagger falha na subida com "circular dependency". O `src/openapi.spec.js` pega o erro sem Docker.
- **Tabelas são `EntitySchema`, e as linhas são objetos simples.** Não há classe de entidade; o formato das respostas no Swagger fica em `EventResponseDto`.
- **O Babel lê `babel.config.json` na raiz do serviço.** O Jest usa `roots: ["<rootDir>/src"]`; trocar para `rootDir: "src"` faz o Babel não achar a configuração.

<a id="convencoes"></a>

## Convenções

- **Idioma:** documentação, comentários e frases de commit em português. Identificadores, rotas, campos, ações das mensagens e mensagens de erro da API em inglês.
- **Campos JSON em `snake_case` nos três serviços**, inclusive no NestJS (`ticket_code`, `event_id`).
- **Camadas:** rotas/controllers não contêm regra de negócio, e só repositórios acessam o banco. Nos serviços NestJS, os repositórios recebem o `EntityManager` da transação. Chamadas HTTP a outro serviço ficam só em `events-integration/` e `logs-integration/`.
- **Ações e tipos das mensagens:** `<entidade>.<verbo no particípio>`, como `ticket.issued`, `event.spot_reserved` e `spot.release_requested`.
- **Tags de log:** `[TICKET ISSUED]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]`, `[COMPENSATION QUEUED]`, `[TICKETS CANCELLED BY EVENT]`, `[ACTIVITY MESSAGE PUBLISHED]`, `[INTEGRATION MESSAGE PUBLISHED]`, `[ACTIVITY LOGGED]`, `[HTTP SYNC REQUEST]`, `[TELEMETRY]`.
- **Frase de commit:** `tipo: descrição em português` (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`).

## Conduta

- Siga a ordem das fases do [prompt.md](prompt.md) e só inicie ou avance quando o autor pedir.
- Ao concluir cada fase, pare e aguarde autorização. Informe o que foi validado, o que não foi e a frase de commit.
- Diante de ambiguidade, **pergunte**; não chute. Não altere a stack nem as decisões registradas sem pedido explícito.

## Manutenção da documentação

- Mudou contrato, mensagem ou fluxo: atualize [contratos-api.md](contratos-api.md) na mesma entrega.
- Concluiu uma fase ou mudou a estrutura: atualize [arquitetura.md](arquitetura.md).
- Decisão nova: registre em [decisoes.md](decisoes.md) e ajuste o [prompt.md](prompt.md) se a especificação mudou.
- Armadilha nova ou comando novo: registre neste arquivo, em forma de regra curta.
