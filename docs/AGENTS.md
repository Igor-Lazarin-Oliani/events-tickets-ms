# AGENTS.md — instruções para agentes de código

`events-tickets-ms`: plataforma distribuída de gestão de eventos e emissão unificada de inscrições/ingressos. Trabalho Prático de Sistemas Distribuídos (UFMS), avaliado em máquina limpa com `git clone` e `docker compose up --build`.

**Leia primeiro:** [prompt.md](prompt.md), a especificação completa. Este arquivo traz só as regras.

| Preciso de... | Veja |
|---|---|
| requisitos, modelo de dados, fases de desenvolvimento | [prompt.md](prompt.md) |
| topologia, variáveis, o que já está implementado | [arquitetura.md](arquitetura.md) |
| endpoints, regras de negócio, erros | [contratos-api.md](contratos-api.md) (depois da implementação, também o Swagger em `/docs/events` e `/docs/tickets`) |
| por que algo foi decidido assim | [decisoes.md](decisoes.md) |
| explicação geral e roteiro da aula | [guia-da-implementacao.md](guia-da-implementacao.md) e [roteiro-apresentacao.md](roteiro-apresentacao.md) |

Se [decisoes.md](decisoes.md) e [prompt.md](prompt.md) divergirem, vale a decisão registrada.

## Comandos de desenvolvimento

```sh
# subir tudo, como na avaliação
docker compose up --build -d
docker compose ps
docker compose logs -f events-service tickets-service

# recriar os bancos do zero (apaga os dados)
docker compose down -v

# testes
cd microservices/events-service && pip install -r requirements-dev.txt && pytest   # Python 3.11; usa SQLite em memória
cd microservices/tickets-service && npm ci && npm test
```

| Recurso | Endereço |
|---|---|
| Swagger de eventos | http://localhost:8080/docs/events |
| Métricas de eventos | http://localhost:8080/metrics/events |
| Swagger de ingressos | http://localhost:8080/docs/tickets |
| Métricas de ingressos | http://localhost:8080/metrics/tickets |
| Painel Grafana | http://localhost:8080/grafana/ |
| Prometheus | http://localhost:8080/prometheus/ |
| RabbitMQ | http://localhost:8080/rabbitmq/ (`events_tickets` / `events_tickets_pass`) |

## Mapa do repositório

```
/
├── docker-compose.yml · README.md
├── docs/                     # toda a documentação, inclusive este arquivo
├── gateway/                  # configuração do NGINX
├── messaging/                # configuração do RabbitMQ
├── observability/            # configuração do Prometheus e do Grafana
└── microservices/
    ├── events-service/       # Python 3.11 + FastAPI + SQLAlchemy (porta 8000)
    └── tickets-service/      # Node.js 20 + NestJS + TypeORM (porta 3000)
```

A árvore completa está na [seção 7 do prompt.md](prompt.md#7-estrutura-de-diretórios-modularizada-esperada).

<a id="nunca-viole"></a>

## Nunca viole

1. **NUNCA faça `git commit` nem `git push`.** Ao concluir uma entrega, apenas informe a frase de commit sugerida.
2. **Só os contêineres previstos:** o núcleo `events-db`, `events-service`, `tickets-db` e `tickets-service`, mais `api-gateway` e os das fases 5 a 7 ([seção 9 do prompt.md](prompt.md#9-adequação-ao-edital-fases-5-a-7)). Nada além disso sem pedido do autor.
   **O edital (`trabalho_cd.pdf`) define a nota:** confira-o antes de fechar uma entrega.
3. **Database per Service.** Cada serviço acessa só o próprio banco. O `tickets-service` nunca lê o `events_db`, e vice-versa; os dados de evento chegam por HTTP e ficam em `event_snapshot`.
4. **`events-service` é a verdade sobre vagas.** Só `reserve-spot`, `release-spot` e a alteração de capacidade mudam `available_spots`.
5. **Máquina limpa.** Nada de passo manual, `.env` obrigatório ou dependência instalada no host: o `docker compose up --build` precisa bastar.
6. **Toda vaga reservada tem caminho de volta.** Falha depois de `reserve-spot` chama `release-spot`; falha de `release-spot` no cancelamento restaura o ingresso ([fluxos](contratos-api.md#fluxos-entre-servicos)).
7. **Swagger completo nas duas APIs.** Endpoint novo ou alterado sai com resumo, exemplos e códigos de resposta em `/docs/events` ou `/docs/tickets`.

<a id="armadilhas"></a>

## Armadilhas

- **Reserva e devolução precisam ser atômicas.** Use um único `UPDATE` condicional no banco, nunca ler, calcular e salvar. A consulta prévia do `tickets-service` não garante a vaga: o `409` de `reserve-spot` precisa ser repassado ao cliente.
- **Alteração de capacidade concorre com reservas.** O `PUT /events/{id}` lê a linha com `SELECT ... FOR UPDATE` antes de recalcular.
- **Duplicidade é garantida no banco.** A consulta prévia melhora a mensagem, mas quem barra requisições simultâneas é o índice único parcial em `(event_id, participant_document)` para status diferente de `CANCELLED`. Violação no `save` também devolve a vaga.
- **`GET /tickets/:id` aceita UUID ou `ticket_code`.** Não aplique `ParseUUIDPipe` nessa rota.
- **Nome `metadata` é reservado** no declarative do SQLAlchemy; por isso o campo é `metadata_info`.
- **`create_all` e `synchronize` não servem de migração segura.** Mudou o modelo? Rode `docker compose down -v`. Este projeto não usa migrações (D8).
- **`depends_on` com `service_healthy` exige `healthcheck`,** inclusive no `events-service`. A imagem `python:3.11-slim` não tem `curl`; use `python -c` com `urllib`.
- **Dentro da rede Docker, use nome de serviço e porta interna:** `events-service:8000` e `events-db:5432`. Só o `api-gateway` publica porta no host (`8080`); para inspecionar um banco, use `docker compose exec`.
- **Gateway usa lista de rotas permitidas.** Rota nova precisa de `location` em `gateway/nginx.conf`, senão responde `404`. Nunca abra `reserve-spot` ou `release-spot` (D13).
- **`proxy_pass` do gateway usa variável e `resolver` do Docker.** Sem isso, o NGINX guarda o IP antigo quando um serviço reinicia.
- **`npm ci` no Dockerfile exige `package-lock.json` versionado.**
- **Rótulo de métrica usa o padrão da rota** (`/tickets/:id`), nunca a URL real, para não explodir a cardinalidade.
- **Testes do `events-service` usam SQLite em memória.** Não provam concorrência nem `FOR UPDATE`; isso só se confirma no PostgreSQL. Evite SQL que não exista nos dois, como `RETURNING` em SQLite antigo.
- **Healthcheck do PostgreSQL usa `pg_isready -h localhost`.** Sem `-h`, o teste pode passar no servidor temporário de inicialização da imagem. O `init_db` ainda tenta reconectar por 30 s.
- **`SOLD_OUT` responde `409`, nunca `400`.** Em `assertEventOpen`, ele é verificado antes da regra de status geral (D11).
- **`correlationMiddleware` fica no `app.use` antes do `listen`.** O contexto do `AsyncLocalStorage` precisa cobrir toda a requisição até o `EventsClientService`.
- **`@IsOptional` aceita `null`.** Em coluna obrigatória use `IfPresent`, como no `UpdateTicketDto`, senão o `null` só falha no banco, com `500`.
- **Testes Jest simulam o banco e o Serviço A.** Índice único, condições do `UPDATE` e concorrência só se confirmam com PostgreSQL real.
- **OpenAPI fica em `/docs/events/openapi.json` e `/docs/tickets/openapi.json`,** servidas sob o caminho público e sem `servers`, para o "Try it out" usar o gateway (D14).
- **Prometheus e Grafana rodam sob prefixo.** A API do Prometheus fica em `/prometheus/api/...`, inclusive na rede interna; os healthchecks e a fonte de dados do Grafana usam esse caminho.
- **Rótulos HTTP diferem entre os serviços.** No `events-service`: `handler` e `status="2xx"`; no `tickets-service`: `route` e `status="201"`. Filtre erros com `status=~"[45].."` e use `job` para separar os serviços.
- **Contadores zeram quando o serviço reinicia.** Depois de `docker compose down` ou de reiniciar um serviço, os totais do painel recomeçam; os dados de negócio continuam no banco.
- **Painel é arquivo.** Edite `observability/grafana/dashboards/events-tickets.json`: alterações pela interface não são salvas.
- **Nunca publique no RabbitMQ direto de um endpoint.** Grave um `OutboxMessage` na mesma transação da mudança; o `OutboxPublisher` publica depois (D16).
- **O consumidor precisa ser idempotente.** A entrega é "ao menos uma vez". Confirme (`ack`) só depois de gravar; mensagem inválida vai para a DLQ, nunca volta para a fila.
- **`amqplib` derruba o processo em evento `error` sem ouvinte.** Mantenha os ouvintes na conexão e no canal, e o `.catch` no callback de `consume`.
- **Falha do broker não pode afetar a API síncrona.** O `tickets-service` conecta em segundo plano, com novas tentativas.
- **O `rabbitmq` precisa de `hostname` fixo.** Os dados ficam em pasta com o nome do nó; sem isso, filas e mensagens somem ao recriar o contêiner.
- **`events_tickets` no lugar de `guest`.** O usuário `guest` só aceita conexões locais do próprio contêiner.
- **Toda chamada ao `events-service` tem timeout.** Sem resposta vira `503`, nunca requisição pendurada.
- **Nunca logue `participant_document` nem `participant_email`:** os logs são exibidos ao vivo na apresentação.

<a id="convencoes"></a>

## Convenções

- **Idioma:** documentação, comentários e frases de commit em português. Identificadores, rotas, campos e mensagens de erro da API em inglês, como no [prompt.md](prompt.md).
- **Campos JSON em `snake_case` nos dois serviços**, inclusive no NestJS (`ticket_code`, `event_id`).
- **Camadas:** rotas/controllers não contêm regra de negócio, e só repositórios (ou o repositório do TypeORM no service) acessam o banco. Chamadas HTTP ao Serviço A ficam só em `events-integration/`.
- **Tags de log:** `[HTTP SYNC REQUEST]`, `[EVENT SPOT RESERVED]`, `[EVENT SPOT RELEASED]`, `[TELEMETRY]`.
- **Frase de commit:** `tipo: descrição em português` (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`).

## Conduta

- Siga a ordem das fases da [seção 8 do prompt.md](prompt.md#8-plano-de-execução-detalhado-passo-a-passo-fases-de-desenvolvimento) e só inicie ou avance quando o autor pedir.
- Ao concluir cada fase, pare e aguarde autorização. Informe o que foi validado, o que não foi e a frase de commit.
- Diante de ambiguidade, **pergunte**; não chute. Não altere a stack nem as decisões registradas sem pedido explícito.

## Manutenção da documentação

- Mudou contrato ou fluxo: atualize [contratos-api.md](contratos-api.md) na mesma entrega.
- Concluiu uma fase ou mudou a estrutura: atualize [arquitetura.md](arquitetura.md).
- Decisão nova: registre em [decisoes.md](decisoes.md) e ajuste o [prompt.md](prompt.md) se a especificação mudou.
- Armadilha nova ou comando novo: registre neste arquivo, em forma de regra curta.
