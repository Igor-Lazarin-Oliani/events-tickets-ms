# AGENTS.md — instruções para agentes de código

`events-tickets-ms`: plataforma distribuída de gestão de eventos e emissão unificada de inscrições/ingressos, com registro de atividades. Trabalho Prático de Sistemas Distribuídos (UFMS), avaliado em máquina limpa com `git clone` e `docker compose up --build`.

Dois microsserviços: `events-tickets-service` (eventos, vagas e ingressos, NestJS) e `logs-service` (registro de atividades, Python). Toda a comunicação distribuída é entre os dois: RabbitMQ para gravar atividades, HTTP para consultar o histórico.

**Leia primeiro:** [prompt.md](prompt.md), a especificação completa. Este arquivo traz só as regras.

| Preciso de... | Veja |
|---|---|
| requisitos, modelo de dados, fases de desenvolvimento | [prompt.md](prompt.md) |
| topologia, variáveis, o que já está implementado | [arquitetura.md](arquitetura.md) |
| endpoints, regras de negócio, mensagens, erros | [contratos-api.md](contratos-api.md) (também o Swagger em `/docs/events-tickets` e `/docs/logs`) |
| por que algo foi decidido assim | [decisoes.md](decisoes.md) |
| explicação geral e roteiro da aula | [guia-da-implementacao.md](guia-da-implementacao.md) e [roteiro-apresentacao.md](roteiro-apresentacao.md) |

Se [decisoes.md](decisoes.md) e [prompt.md](prompt.md) divergirem, vale a decisão registrada.

## Comandos de desenvolvimento

```sh
# subir tudo, como na avaliação
docker compose up --build -d
docker compose ps
docker compose logs -f events-tickets-service logs-service

# recriar os bancos do zero (apaga os dados)
docker compose down -v

# testes
cd microservices/events-tickets-service && npm ci && npm test              # Jest, sem banco
cd microservices/logs-service && pip install -r requirements-dev.txt && pytest   # Python 3.11; SQLite em memória
```

| Recurso | Endereço |
|---|---|
| Aplicação web | http://localhost:8080/ (redireciona para `/app/`) |
| Swagger de eventos e ingressos | http://localhost:8080/docs/events-tickets |
| Métricas de eventos e ingressos | http://localhost:8080/metrics/events-tickets |
| Swagger de logs | http://localhost:8080/docs/logs |
| Métricas de logs | http://localhost:8080/metrics/logs |
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
    ├── events-tickets-service/    # Node.js 20 + NestJS + TypeORM (porta 3000)
    └── logs-service/              # Python 3.11 + FastAPI + SQLAlchemy (porta 8000)
```

A árvore completa está na [seção 7 do prompt.md](prompt.md#7-estrutura-de-diretórios-modularizada-esperada).

<a id="nunca-viole"></a>

## Nunca viole

1. **NUNCA faça `git commit` nem `git push`.** Ao concluir uma entrega, apenas informe a frase de commit sugerida.
2. **Só os 8 contêineres previstos:** `api-gateway`, `events-tickets-db`, `events-tickets-service`, `logs-db`, `logs-service`, `rabbitmq`, `prometheus` e `grafana`. Nada além disso sem pedido do autor.
   **O edital (`trabalho_cd.pdf`) define a nota:** confira-o antes de fechar uma entrega.
3. **Database per Service.** Cada serviço acessa só o próprio banco. O `logs-service` nunca lê o `events_tickets_db`, e vice-versa; as atividades chegam pelo RabbitMQ, e o histórico sai por HTTP.
4. **Vagas só mudam por `UPDATE` condicional.** Só a reserva, a devolução e a alteração de capacidade mudam `available_spots`, sempre dentro da transação da operação que as causou.
5. **Máquina limpa.** Nada de passo manual, `.env` obrigatório ou dependência instalada no host: o `docker compose up --build` precisa bastar.
6. **Toda escrita é atômica com suas atividades.** Mudança em eventos ou ingressos e as mensagens da outbox entram na mesma transação; nunca publique no RabbitMQ direto de um endpoint (D20).
7. **O `logs-service` nunca bloqueia a venda.** O serviço principal não depende dele para subir nem para escrever; só as rotas `/history` podem responder `503` (D21).
8. **Registro de atividade é imutável.** No `logs-service`, só `status` e `notes` mudam; `DELETE` arquiva (D19).
9. **Swagger completo nas duas APIs.** Endpoint novo ou alterado sai com resumo, exemplos e códigos de resposta em `/docs/events-tickets` ou `/docs/logs`.

<a id="armadilhas"></a>

## Armadilhas

- **Reserva e devolução precisam ser atômicas.** Use um único `UPDATE` condicional, nunca ler, calcular e salvar. A consulta prévia no `POST /tickets` só melhora a mensagem; se o `UPDATE` não mudar linha, responda `409`.
- **Erro dentro de transação do PostgreSQL invalida a transação.** Para tentar outro `ticket_code` após colisão, use `manager.transaction(...)` aninhado, que cria um savepoint. Sem isso, a segunda tentativa falha com "current transaction is aborted".
- **Alteração de capacidade e cancelamento de evento concorrem com reservas.** `PUT` e `DELETE /events/{id}` leem a linha com `SELECT ... FOR UPDATE` antes de recalcular ou de cancelar os ingressos (D22).
- **Duplicidade é garantida no banco.** Quem barra requisições simultâneas é o índice único parcial em `(event_id, participant_document)` para status diferente de `CANCELLED`. A violação desfaz a transação inteira, inclusive a vaga.
- **`tickets.event_id` não tem chave estrangeira.** O ingresso precisa sobreviver à remoção do evento, com o `event_snapshot`.
- **`GET /tickets/:id` e `/tickets/:id/history` aceitam UUID ou `ticket_code`.** Não aplique `ParseUUIDPipe` nessas rotas.
- **`synchronize` e `create_all` não servem de migração segura.** Mudou o modelo? Rode `docker compose down -v`. Este projeto não usa migrações (D8).
- **`depends_on` com `service_healthy` exige `healthcheck`.** A imagem `python:3.11-slim` não tem `curl`; o `logs-service` usa `python -c` com `urllib`.
- **Dentro da rede Docker, use nome de serviço e porta interna:** `logs-service:8000` e `events-tickets-db:5432`. Só o `api-gateway` publica porta no host (`8080`); para inspecionar um banco, use `docker compose exec`.
- **Gateway usa lista de rotas permitidas.** Rota nova precisa de `location` em `gateway/nginx.conf`, senão responde `404`.
- **A aplicação web não tem build nem dependência externa (D24).** `frontend/` é servido como está pelo `api-gateway`; nada de framework, `npm` ou CDN, porque a avaliação pode acontecer sem internet boa.
- **A aplicação web não decide regra de negócio.** Ela só chama rotas públicas e exibe as respostas; vagas, duplicidade e transições ficam nos serviços.
- **O `nginx.conf` não carrega `mime.types` no `http`.** O padrão do servidor é `application/json`; o `location /app/` inclui `mime.types` para servir HTML, CSS e JS com o tipo certo.
- **Textos da API entram na página como texto, nunca como HTML.** Use o `h()` de `frontend/js/util.js`, que cria nós com `textContent`.
- **`proxy_pass` do gateway usa variável e `resolver` do Docker.** Sem isso, o NGINX guarda o IP antigo quando um serviço reinicia.
- **`npm ci` no Dockerfile exige `package-lock.json` versionado.**
- **Rótulo de métrica usa o padrão da rota** (`/tickets/:id`), nunca a URL real, para não explodir a cardinalidade.
- **Testes do `logs-service` usam SQLite em memória; os do `events-tickets-service` simulam o banco.** Concorrência, `FOR UPDATE`, índice parcial e savepoints só se confirmam com PostgreSQL real, em contêiner.
- **Healthcheck do PostgreSQL usa `pg_isready -h localhost`.** Sem `-h`, o teste pode passar no servidor temporário de inicialização da imagem.
- **`SOLD_OUT` responde `409`, nunca `400`.** Na emissão, ele é verificado antes da regra de status geral (D11).
- **`correlationMiddleware` fica no `app.use` antes do `listen`.** O contexto do `AsyncLocalStorage` precisa cobrir toda a requisição até a outbox e o `LogsClientService`.
- **`@IsOptional` aceita `null`.** Em coluna obrigatória use `IfPresent` (`common/validation.ts`), senão o `null` só falha no banco, com `500`.
- **Validação responde `400` no NestJS e `422` no FastAPI** (D23). Documente o código certo em cada Swagger.
- **OpenAPI fica em `/docs/events-tickets/openapi.json` e `/docs/logs/openapi.json`,** servidas sob o caminho público e sem `servers`, para o "Try it out" usar o gateway (D14).
- **Prometheus e Grafana rodam sob prefixo.** A API do Prometheus fica em `/prometheus/api/...`, inclusive na rede interna.
- **Rótulos HTTP diferem entre os serviços.** No `events-tickets-service`: `route` e `status="201"`; no `logs-service`: `handler` e `status="2xx"`. Filtre erros com `status=~"[45].."` e use `job` para separar os serviços.
- **Contadores zeram quando o serviço reinicia.** Os dados de negócio continuam no banco.
- **Painel é arquivo.** Edite `observability/grafana/dashboards/events-tickets.json`: alterações pela interface não são salvas.
- **Publicação usa `mandatory` e canal de confirmação.** Mensagem devolvida pelo broker (fila ainda não criada) mantém o lote pendente. O `logs-service` é quem declara a fila `logs.activity`.
- **O consumidor precisa ser idempotente.** A entrega é "ao menos uma vez": o `message_id` único descarta repetições. Confirme (`ack`) só depois de gravar; mensagem inválida vai para a DLQ, nunca volta para a fila.
- **`amqplib` derruba o processo em evento `error` sem ouvinte.** Mantenha os ouvintes na conexão e no canal do `OutboxPublisher`.
- **`BlockingConnection` do `pika` não é thread-safe.** O consumidor roda em thread própria; pare-o com `add_callback_threadsafe`.
- **Falha do broker não pode afetar a API síncrona.** Publicador e consumidor conectam em segundo plano, com novas tentativas.
- **O `rabbitmq` precisa de `hostname` fixo.** Os dados ficam em pasta com o nome do nó; sem isso, filas e mensagens somem ao recriar o contêiner.
- **`events_tickets` no lugar de `guest`.** O usuário `guest` só aceita conexões locais do próprio contêiner.
- **Toda chamada ao `logs-service` tem timeout.** Sem resposta vira `503`, nunca requisição pendurada.
- **Nunca logue nem publique `participant_name`, `participant_email` ou `participant_document`:** os logs são exibidos ao vivo, e as mensagens de atividade ficam guardadas no `logs-service`.

<a id="convencoes"></a>

## Convenções

- **Idioma:** documentação, comentários e frases de commit em português. Identificadores, rotas, campos, ações das mensagens e mensagens de erro da API em inglês.
- **Campos JSON em `snake_case` nos dois serviços**, inclusive no NestJS (`ticket_code`, `event_id`).
- **Camadas:** rotas/controllers não contêm regra de negócio, e só repositórios acessam o banco. No `events-tickets-service`, os repositórios recebem o `EntityManager` da transação. A chamada HTTP ao `logs-service` fica só em `logs-integration/`.
- **Ações das mensagens:** `<entidade>.<verbo no particípio>`, como `ticket.issued` e `event.spot_reserved`.
- **Tags de log:** `[TICKET ISSUED]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]`, `[ACTIVITY MESSAGE PUBLISHED]`, `[ACTIVITY LOGGED]`, `[HTTP SYNC REQUEST]`, `[TELEMETRY]`.
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
