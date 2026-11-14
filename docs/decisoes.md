# Decisões do projeto

Decisões que refinam ou completam o [prompt.md](prompt.md). As marcadas como **provisórias** foram adotadas pelo agente onde a especificação era omissa e podem ser revistas pelo autor. Numere novas decisões em sequência e não reaproveite números.

O projeto teve três topologias. Na versão 1, `events-service` (Python) e `tickets-service` (NestJS). Na versão 2 (D18), um único `events-tickets-service` (NestJS) e o `logs-service` (Python). Na **versão 3 (D29), a atual**, três microsserviços com três bancos: `events-service` (JavaScript/NestJS), `tickets-service` (TypeScript/NestJS) e `logs-service` (Python/FastAPI). As decisões das versões anteriores que deixaram de valer estão marcadas como substituídas e foram mantidas como histórico.

## D1 — Cancelamento é soft delete

**Status:** confirmada pelo autor.

`DELETE /tickets/:id` muda o status para `CANCELLED` e mantém o registro. O histórico fica visível na demonstração, e repetir a operação responde `409`, sem devolver a vaga duas vezes.

## D2 — Mudança de capacidade preserva as vagas ocupadas

**Status:** confirmada pelo autor. Substitui o cálculo proporcional da versão original do prompt.

`available_spots = nova capacidade - ocupadas`. Reduzir abaixo das ocupadas responde `409`. O cálculo proporcional deixaria as vagas inconsistentes com os ingressos: 100 vagas com 50 ocupadas, ao dobrar para 200, resultariam em 100 ocupadas para apenas 50 ingressos.

## D3 — Uma inscrição ativa por documento em cada evento

**Status:** confirmada pelo autor.

Não pode haver dois ingressos não cancelados com o mesmo `participant_document` no mesmo evento. Quem cancelou pode se inscrever de novo. A garantia é um índice único parcial na tabela `tickets`, e a demonstração deve usar documentos diferentes.

## D4 — Testes automatizados das regras principais

**Status:** confirmada pelo autor. Atualizada pela D29.

Jest no `events-service` (vagas, reserva idempotente, devolução, cancelamento e remoção de evento, outbox, consumidor da fila `events.spot-releases`, DTOs e documento OpenAPI) e no `tickets-service` (emissão com reserva remota e compensação, cancelamento, cascata, cliente HTTP do `events-service`, consumidor da fila `tickets.event-updates`, outbox e DTOs), e `pytest` no `logs-service` (CRUD, arquivamento e consumidor). As dependências de teste ficam fora das imagens de produção.

## D5 — Regras de transição e compensação de ingressos

**Status:** provisória. Compensação substituída pela D18 e refeita na D30 e na D31.

- O `PUT` não cancela ingressos, e o check-in só parte de `CONFIRMED`. *(continua valendo)*
- ~~Falha do Serviço A na emissão responde `503`, sem criar ingresso.~~ Volta a valer na versão 3, com compensação idempotente (D30).
- ~~Falha de `release-spot` no cancelamento restaura o status anterior e responde `503`.~~ Na versão 3 a devolução é assíncrona e não falha o cancelamento (D31).
- ~~Timeouts podem deixar o resultado da operação remota desconhecido.~~ Resolvido na versão 3: a reserva é registrada pelo `ticket_id`, e a devolução desfaz o resultado, qualquer que tenha sido (D30).

## D6 — Exclusão de evento com ingressos ativos

**Status:** provisória. **Substituída pela D22.**

Era permitida, e os ingressos eram cancelados de forma assíncrona pela mensageria. Agora o cancelamento acontece na mesma transação da remoção.

## D7 — Correlação entre chamadas por cabeçalho

**Status:** provisória. Atualizada pela D29.

O cabeçalho `X-Correlation-Id` liga os logs do gateway e dos três serviços. O `tickets-service` o repassa na reserva de vaga ao `events-service`; os dois o repassam na consulta de histórico ao `logs-service` e o gravam em cada mensagem publicada, inclusive nas mensagens trocadas entre eles. Quem consome uma mensagem continua com o mesmo identificador: os `ticket.cancelled` da cascata e o `event.spot_released` da devolução levam o identificador da operação que os causou. O `logs-service` guarda o valor no registro, o que permite filtrar `GET /logs?correlation_id=`.

## D8 — Sem ferramenta de migração

**Status:** provisória.

As tabelas são criadas por `synchronize: true` (TypeORM) e `create_all` (SQLAlchemy). É adequado para um trabalho prático sem dados a preservar. Mudanças de modelo exigem `docker compose down -v`.

## D9 — `README.md` na raiz

**Status:** provisória.

Toda a documentação fica em `docs/`, exceto o `README.md`, previsto na raiz pelo prompt e exibido pelo GitHub na página do repositório.

## D10 — Datas com fuso e `PUT` parcial em eventos

**Status:** provisória.

`start_at` e `end_at` exigem fuso horário, para que uma data ambígua não seja gravada em horário errado. O `PUT /events/{id}` altera apenas os campos enviados; `null` só é aceito em `description` e `metadata_info`.

## D11 — Evento esgotado responde `409`, e não `400`

**Status:** provisória. Corrige a ordem das validações da versão original do prompt. Atualizada pela D25: o fim do evento é verificado antes de tudo.

Um evento esgotado tem status `SOLD_OUT`. Na ordem original, ele cairia na regra `status !== PUBLISHED` e responderia `400`, mas o roteiro da demonstração exige `409 Event is sold out` no terceiro ingresso. Por isso, `SOLD_OUT` é verificado antes; `CANCELLED` e `FINISHED` continuam respondendo `400`.

## D12 — `PUT /tickets/:id` parcial e estrito

**Status:** provisória.

O `PUT` altera apenas os campos enviados e recusa com `400` campos desconhecidos, `event_id`, `null` e qualquer `status` diferente de `CHECKED_IN`. O `ValidationPipe` global usa `forbidNonWhitelisted`, então o mesmo vale para os outros corpos e filtros do `events-tickets-service`.

## D13 — API Gateway NGINX como única porta de entrada

**Status:** confirmada pelo autor. Atualizada pela D29.

O edital pontua o gateway. O `api-gateway` publica a porta `8080`; serviços e bancos ficam acessíveis só na rede interna. O NGINX usa lista de rotas permitidas, e qualquer caminho fora dela responde `404`. Na versão 3, a rota interna `PATCH /events/{id}/reserve-spot` voltou a existir e fica fora da lista: só o `tickets-service` a chama, pela rede interna (D30). A devolução de vaga não tem rota; chega pelo RabbitMQ (D31).

## D14 — Swagger, saúde e métricas sob caminhos do gateway

**Status:** confirmada pelo autor. Caminhos atualizados pela D29.

Os três serviços têm `/docs`, `/health` e `/metrics`, que colidiriam em uma única porta. O Swagger é servido em `/docs/events`, `/docs/tickets` e `/docs/logs`, diretamente pelos serviços, sem reescrita de URL, o que mantém o "Try it out" funcionando pelo gateway. Saúde e métricas são publicadas em `/health/{events,tickets,logs}` e `/metrics/{events,tickets,logs}`.

## D15 — Prometheus e Grafana provisionados e atrás do gateway

**Status:** confirmada pelo autor (uso das ferramentas). O acesso pelo gateway e o modo anônimo são provisórios.

O edital pede coleta por ferramentas especializadas. O Prometheus coleta `/metrics` dos três serviços a cada 5 s, pela rede interna, e o Grafana já sobe com fonte de dados e painel definidos em arquivos, sem passo manual. Os dois são acessados por `/prometheus/` e `/grafana/`, mantendo a porta única da D13. O Grafana abre sem login, somente leitura, para simplificar a demonstração; editar exige `admin`/`admin`, credencial exclusiva do ambiente local.

O `logs-service` é um serviço de domínio (registro de atividades), e não substitui essa camada: a observabilidade continua sendo Prometheus, Grafana e os logs estruturados dos contêineres.

## D16 — Mensageria com RabbitMQ e outbox

**Status:** confirmada pelo autor (uso do RabbitMQ). **Destino e conteúdo substituídos pela D20; na versão 3, a outbox volta a levar mensagens entre eventos e ingressos (D31, D33).**

A outbox continua: a mensagem é gravada na mesma transação da mudança e publicada depois, com publisher confirms. O que mudou é o que se publica e quem consome: antes, só `event.cancelled` e `event.deleted`, consumidas pelo antigo `tickets-service`; agora, toda atividade de eventos e ingressos, consumida pelo `logs-service`.

## D17 — Evento cancelado não pode ser reaberto

**Status:** provisória.

`CANCELLED` passa a ser um estado final: mudar para outro status responde `409`. Se o evento pudesse ser reaberto, os ingressos cancelados junto com ele deixariam vagas presas, já que o cancelamento em cascata não devolve vagas.

## D18 — Eventos e ingressos em um único microsserviço

**Status:** confirmada pelo autor na versão 2. **Substituída pela D29** (versão 3). Substituiu a topologia `events-service` + `tickets-service` da versão 1.

O antigo `events-service` (Python) e o antigo `tickets-service` (NestJS) viraram um único `events-tickets-service`, em **Node.js 20 + NestJS + TypeORM**, com o banco `events-tickets-db` (tabelas `events`, `tickets` e `outbox_messages`). O segundo microsserviço passou a ser o `logs-service`, em **Python 3.11 + FastAPI + SQLAlchemy**, com o banco `logs-db`.

Justificativa: eventos e ingressos compartilham a regra mais importante do domínio, a de que nunca se vendem mais ingressos que vagas. Juntos, reserva e emissão acontecem em uma transação local, e somem a compensação (D5), as rotas internas de vagas e as limitações de timeout entre serviços. O registro de atividades tem outro padrão de escrita (só acrescenta), outra retenção e não pode derrubar a venda se cair, por isso fica em um serviço separado.

Consequências:

- `reserve-spot` e `release-spot` deixam de ser rotas HTTP e viram operações do repositório de eventos, com o mesmo `UPDATE` condicional.
- `tickets.event_id` continua sem chave estrangeira, e o `event_snapshot` continua sendo gravado, para o ingresso sobreviver à remoção do evento (D22).
- Caminhos públicos novos (D14) e contêineres novos: `events-tickets-db`, `events-tickets-service`, `logs-db` e `logs-service`. O total continua em 8 contêineres.
- Toda a comunicação entre os microsserviços passa a ser entre o `events-tickets-service` e o `logs-service`: assíncrona para gravar (D20) e síncrona para consultar (D21).

## D19 — CRUD do `logs-service`: fatos imutáveis, triagem editável e arquivamento

**Status:** confirmada pelo autor (CRUD completo e `DELETE` como arquivamento). Os campos editáveis são provisórios.

Um registro de atividade descreve algo que já aconteceu, então o conteúdo não pode ser reescrito. O CRUD fica assim:

- **Create:** os registros automáticos chegam pelo RabbitMQ; `POST /logs` cria registros manuais, como uma ocorrência anotada pela organização (`source: manual`).
- **Read:** `GET /logs` com filtros (`entity_type`, `entity_id`, `action`, `level`, `status`, `source`, `correlation_id`), ordem e paginação; `GET /logs/{id}`.
- **Update:** `PUT /logs/{id}` altera só a triagem: `status` (`NEW`, `REVIEWED`, `RESOLVED`) e `notes`. Enviar ação, entidade, mensagem, dados, nível ou data responde `422`.
- **Delete:** `DELETE /logs/{id}` arquiva (preenche `archived_at`). O registro sai das listagens e dos históricos, mas continua acessível por id. Repetir responde `409`, e registro arquivado não pode ser editado (`409`).

O arquivamento, em vez da exclusão física, mantém o `message_id` no banco. Assim, uma reentrega da mesma mensagem pelo RabbitMQ não recria um registro apagado.

## D20 — Toda mudança gera um registro de atividade pela outbox

**Status:** provisória (contrato das mensagens). O uso de RabbitMQ e outbox segue a D16. O desempenho do publicador foi revisto na D28. **Atualizada pela D29 e pela D34:** na versão 3, o `events-service` e o `tickets-service` publicam as atividades, cada um da sua outbox, na exchange `activities.exchange` (antes `events-tickets.exchange`), e `source` é o nome de quem publicou.

Cada operação que altera eventos ou ingressos grava, na mesma transação, uma ou mais mensagens em `outbox_messages`. O publicador do serviço as envia a cada segundo para a exchange de atividades (topic), com a ação como routing key: `event.created`, `event.updated`, `event.cancelled`, `event.deleted`, `event.spot_reserved`, `event.spot_released`, `ticket.issued`, `ticket.updated`, `ticket.checked_in` e `ticket.cancelled`. O `logs-service` consome a fila `logs.activity`, ligada a `event.*` e `ticket.*`.

- As mensagens nunca levam nome, e-mail ou documento do participante; no `ticket.updated`, só o nome dos campos alterados.
- A publicação usa `mandatory`: se o `logs-service` ainda não criou a fila, o broker devolve a mensagem, e o lote continua pendente.
- O publicador mantém a conexão aberta entre os lotes, porque agora há mensagem a cada operação.
- O consumidor grava e só então confirma (`ack`). O `message_id` único descarta entregas repetidas; mensagem inválida vai para `logs.activity.dlq`; falha do banco devolve a mensagem à fila depois de 5 s.

## D21 — Histórico consultado por HTTP síncrono

**Status:** confirmada pelo autor. Na versão 3, o `events-service` atende o histórico de eventos, e o `tickets-service`, o de ingressos (D29).

`GET /events/{id}/history` e `GET /tickets/{id}/history` (UUID ou `ticket_code`) verificam que a entidade existe e chamam `GET /logs?entity_type=&entity_id=&order=asc` no `logs-service`, com timeout de 3 s e o `X-Correlation-Id` repassado. Se o `logs-service` estiver fora do ar ou demorar, só essas rotas respondem `503 Logs service unavailable`; emissão, cancelamento e o resto da API continuam funcionando. O histórico de um evento removido continua disponível diretamente em `GET /logs?entity_type=event&entity_id=`.

## D22 — Cancelar ou remover evento cancela os ingressos na mesma transação

**Status:** confirmada pelo autor na versão 2. **Substituída pela D33** (versão 3): com eventos e ingressos em bancos diferentes, o cancelamento em cascata voltou a ser assíncrono. Substituiu a D6 e o cancelamento assíncrono da D16.

`PUT /events/{id}` com `status: CANCELLED` e `DELETE /events/{id}` travam a linha do evento (`SELECT ... FOR UPDATE`), cancelam os ingressos ativos com um único `UPDATE ... RETURNING` e gravam as mensagens, tudo na mesma transação. Para o cliente, o comportamento é o mesmo de antes, mas sem atraso: a resposta já sai com os ingressos cancelados. As vagas não são devolvidas, porque o evento não aceita mais inscrições. Os ingressos mantêm o `event_snapshot`.

Travar o evento antes de cancelar os ingressos fecha a janela de corrida que existia na versão assíncrona: uma emissão simultânea espera o lock e, depois, ou vê o evento fechado (`409`/`404`), ou já foi gravada e é cancelada junto.

## D23 — Erros de validação respondem `400` nos serviços NestJS

**Status:** provisória. Atualizada pela D29.

Com a D18, as rotas de eventos passaram do FastAPI para o NestJS, cujo `ValidationPipe` responde `400`. Na versão 3, os dois serviços NestJS mantêm a regra: o `events-service` e o `tickets-service` usam `400` para corpo inválido, UUID inválido, data sem fuso e fim antes do início. O `logs-service`, em FastAPI, mantém `422` para dados inválidos.

## D24 — Aplicação web estática servida pelo `api-gateway`

**Status:** confirmada pelo autor.

O edital pede uma "aplicação web", e o Swagger mostra as rotas, mas não a comunicação entre os componentes. A aplicação fica em `frontend/`: HTML, CSS e JavaScript puros, sem framework, build ou CDN. O `api-gateway` serve os arquivos em `/app/`, e `/` redireciona para lá.

- **Sem contêiner novo:** a página não acrescenta contêiner (são 10 na versão 3, D29), e o `docker compose up --build` não ganha etapa de build.
- **Mesma origem da API:** sem CORS, e a própria página entra pela porta 8080, como qualquer cliente.
- **Sem regra de negócio:** a página só chama rotas públicas. Vagas, duplicidade e transições continuam decididas pelos serviços, e a página exibe os erros que eles devolvem.
- **Animação com evidência:** a parte síncrona acompanha a resposta HTTP, e a assíncrona só aparece quando o registro com o `X-Correlation-Id` da operação chega ao `logs-service`. A saúde de cada nó vem de `/health/*`, da API do RabbitMQ e do Prometheus, todos pelo gateway.
- **Credenciais do RabbitMQ na página:** a API de gerenciamento exige login, e a página envia as credenciais do ambiente local, as mesmas do `docker-compose.yml`. Em produção, isso exigiria autenticação própria.

## D25 — Evento encerrado não aceita inscrições

**Status:** confirmada pelo autor (regra). O código `400` e as mensagens são provisórios.

Não é possível se inscrever em evento inexistente nem em evento cujo `end_at` já passou, mesmo que ainda haja vagas e o status continue `PUBLISHED`. Antes, só o status `FINISHED`, alterado à mão, fechava um evento que já tinha acontecido.

- Evento inexistente continua respondendo `404 Event not found`, inclusive se for removido entre a consulta e a reserva.
- Evento encerrado responde `400 Event has already ended`, como os outros eventos fechados (`CANCELLED` e `FINISHED`). Essa verificação vem antes da de `SOLD_OUT` (D11): um evento encerrado e esgotado responde `400`, porque o motivo real é o fim do evento.
- A regra também está no `UPDATE` condicional da reserva (`"end_at" > now()`), como as demais condições de vaga. Se o evento terminar, ou tiver o `end_at` alterado, entre a consulta e a reserva, a resposta é `409 Event has already ended`, do mesmo jeito que outras corridas respondem `409`.
- Vale o fim, e não o início: um evento de vários dias aceita inscrições enquanto acontece.
- Criar ou editar um evento com datas no passado continua permitido, por exemplo para registrar um evento que já aconteceu; ele só não aceita inscrições.
- Os exemplos do Swagger, do README e do roteiro usam datas de 2027, e as fixtures dos testes usam sempre o ano seguinte ao atual, para não vencerem.

## D26 — Listagens e históricos paginados, com o total

**Status:** provisória. Corrige listagens que devolviam a tabela inteira e o histórico cortado sem aviso.

- `GET /events` e `GET /tickets` aceitam `limit` (1 a 500, padrão 100) e `offset`, com os mesmos limites do `GET /logs`, e ordenam por `created_at` decrescente, com o `id` como desempate, para as páginas não repetirem itens.
- As três listagens (`/events`, `/tickets` e `/logs`) devolvem o total que atende aos filtros no cabeçalho `X-Total-Count`. O corpo continua sendo uma lista, então quem já consumia as rotas não precisa mudar.
- `GET /events/{id}/history` e `GET /tickets/{id}/history` aceitam `limit` (1 a 500, padrão 500) e `offset`, repassados ao `logs-service`, e a resposta ganhou `total`, `limit` e `offset`. Antes, o histórico pedia 500 registros em ordem cronológica e perdia os mais recentes, sem aviso, quando havia mais. `total` vem do `X-Total-Count` do `logs-service` e é `null` se ele não vier.
- A aplicação web pede 100 itens, avisa quando há mais e conta os ingressos ativos pelo `X-Total-Count`, e não pelo tamanho da lista.

## D27 — Reinício automático e subida sem depender do `logs-service`

**Status:** provisória. Reforça a D21: o `logs-service` nunca bloqueia a venda. Atualizada pela D36.

- Os contêineres usam `restart: unless-stopped`. Um processo que cai volta sozinho; um `docker compose stop` mantém o contêiner parado, então os experimentos de falha continuam iguais. Contêineres em execução também voltam quando o Docker reinicia, por isso o ambiente deve ser encerrado com `docker compose down`.
- O `api-gateway` e o `prometheus` dependem só dos serviços de venda saudáveis: na versão 3, o `events-service` e o `tickets-service` (D36). Antes, também esperavam o `logs-service`, e uma falha dele na subida deixava o sistema inteiro sem porta de entrada. O NGINX resolve os nomes a cada requisição (D13), então passa a encaminhar para o `logs-service` assim que ele sobe, e o Prometheus o mostra como `DOWN` enquanto isso.

## D28 — Publicador da outbox sem gargalo

**Status:** provisória. Complementa a D20. Atualizada pela D34: o lote marca como publicadas só as mensagens que o broker não devolveu.

- **Lotes em sequência:** o publicador lê até 50 mensagens por vez. Se o lote vier cheio, o próximo sai em seguida, sem esperar o intervalo de 1 s. Antes, a vazão máxima era de 50 mensagens por segundo, e remover um evento com 300 ingressos, ou recuperar o acúmulo depois de uma queda do RabbitMQ, demorava vários segundos.
- **Conexão fora da transação:** o publicador conecta ao broker antes de abrir a transação que trava as mensagens (`FOR UPDATE SKIP LOCKED`). Com o broker fora do ar, a tentativa de conexão (até 3 s) não segura uma conexão do banco nem linhas travadas. Só o envio do lote e a espera pela confirmação acontecem com a transação aberta, porque a mensagem só pode ser marcada como publicada depois da confirmação.
- **Métrica do acúmulo:** `outbox_messages_pending` passa a ser um `COUNT` das mensagens com `published_at` nulo, feito a cada ciclo pelo índice da coluna. Antes, mostrava no máximo o tamanho do lote e voltava a 0 depois de cada lote, mesmo com acúmulo.
- **Reserva e devolução de vaga com `RETURNING`:** o `UPDATE` condicional já devolve a linha atualizada, sem um `SELECT` a mais enquanto o lock da linha do evento está retido. Todas as reservas de um mesmo evento passam por essa linha, então encurtar o tempo do lock aumenta a vazão das vendas concorrentes.

## D29 — Três microsserviços e três bancos

**Status:** confirmada pelo autor. Substitui a D18.

A versão 3 separa de novo eventos e ingressos e mantém o registro de atividades:

| Serviço | Linguagem e stack | Banco | Tabelas |
|---|---|---|---|
| `events-service` | JavaScript, Node.js 20, NestJS, TypeORM | `events-db` (`events_db`) | `events`, `spot_reservations`, `outbox_messages` |
| `tickets-service` | TypeScript, Node.js 20, NestJS, TypeORM | `tickets-db` (`tickets_db`) | `tickets`, `closed_events`, `outbox_messages` |
| `logs-service` | Python 3.11, FastAPI, SQLAlchemy | `logs-db` (`logs_db`) | `activity_logs` |

Justificativa: cada serviço passa a ter uma responsabilidade e um banco próprios, o que evidencia a comunicação entre serviços pedida pelo edital, agora nos dois sentidos e nos dois estilos. Eventos e vagas mudam em ritmos diferentes dos ingressos (cadastro x venda), e o `events-service` é a fonte da verdade sobre as vagas. O preço é que a regra das vagas, antes garantida por uma transação local (D18), agora atravessa dois bancos. A D30 a D33 descrevem como ela continua correta: reserva idempotente, compensação, devolução pela outbox e cancelamento em cascata assíncrono.

Consequências:

- São 10 contêineres: `api-gateway`, `events-db`, `events-service`, `tickets-db`, `tickets-service`, `logs-db`, `logs-service`, `rabbitmq`, `prometheus` e `grafana`.
- Os contratos públicos continuam os mesmos para o cliente, com três diferenças: o `POST /tickets` pode responder `503 Events service unavailable` (D30), a vaga volta ao evento cerca de 1 s depois do `DELETE /tickets/{id}` (D31), e os ingressos de um evento cancelado ou removido são cancelados cerca de 1 s depois da resposta (D33).
- `tickets.event_id` continua sem chave estrangeira, agora porque o evento está em outro banco, e o `event_snapshot` continua sendo gravado.
- A heterogeneidade do edital é atendida por três ecossistemas: JavaScript sem tipos (com Babel), TypeScript e Python.

## D30 — Reserva de vaga por HTTP síncrono e idempotente, com compensação

**Status:** confirmada pelo autor (HTTP síncrono idempotente com compensação). Os detalhes de implementação são provisórios.

O cliente precisa saber na hora se conseguiu o ingresso, então a reserva é síncrona. O `tickets-service`:

1. recusa logo o que dá para decidir sozinho: evento já encerrado na tabela `closed_events` (`400`, D32) e participante já inscrito (`409`, D3);
2. gera o `id` do ingresso antes de reservar;
3. chama `PATCH /events/{id}/reserve-spot` no `events-service`, com `{ "ticket_id": "..." }`, timeout de 3 s e o `X-Correlation-Id`;
4. salva o ingresso com esse `id` em uma transação local, que também grava `ticket.issued` na outbox.

O `events-service` faz a reserva em uma transação: confere o evento (mesmas mensagens de antes: `404`, `400 Event has already ended`, `409 Event is sold out`, `400 Event is not open for registrations`), executa o `UPDATE` condicional com `RETURNING` (D28), grava a reserva em `spot_reservations` com o `ticket_id` como chave primária e grava `event.spot_reserved` na outbox. As recusas chegam ao cliente com o mesmo código e a mesma mensagem.

**Idempotência:** repetir a reserva com o mesmo `ticket_id` devolve o evento sem reservar outra vaga (métrica `replayed`); duas reservas simultâneas com o mesmo `ticket_id` são barradas pela chave primária, e a segunda devolve a reserva já gravada.

**Compensação:** se o ingresso não puder ser salvo depois da reserva (inscrição simultânea com o mesmo documento, evento encerrado no meio, falha do banco), o `tickets-service` grava na outbox o pedido de devolução `spot.release_requested` com `reason: issue_failed` (D31). Se o `events-service` não der resposta definitiva (timeout, `5xx` ou fora do ar), a reserva pode ter acontecido ou não: o `tickets-service` pede a devolução do mesmo jeito e responde `503 Events service unavailable`. Como a devolução é aplicada pelo `ticket_id`, ela desfaz a reserva se houve, e não muda nada se não houve.

**Limitação aceita:** se o próprio `tickets-db` cair entre a reserva e o salvamento, nem a compensação pode ser gravada. O log `[COMPENSATION FAILED]` registra o `ticket_id`, que identifica a reserva presa em `spot_reservations`.

O `tickets-service` não depende do `events-service` para subir: consultas, check-in e cancelamentos continuam funcionando sem ele, e só a emissão responde `503`.

## D31 — Devolução de vaga assíncrona pela outbox

**Status:** confirmada pelo autor.

`DELETE /tickets/{id}` muda o ingresso para `CANCELLED` e grava, na mesma transação do `tickets-db`, a atividade `ticket.cancelled` e o pedido `spot.release_requested` (`reason: ticket_cancelled`), publicado em `tickets.exchange` e consumido pelo `events-service` na fila `events.spot-releases`. A resposta não espera a devolução, e a vaga volta ao evento cerca de 1 s depois.

Ao consumir, o `events-service` trava a reserva do `ticket_id` (`SELECT ... FOR UPDATE`) e, na mesma transação:

- reserva `RESERVED`: marca `RELEASED`, devolve a vaga com o `UPDATE` condicional (`SOLD_OUT` volta a `PUBLISHED`) e grava `event.spot_released`;
- reserva `RELEASED`: entrega repetida, nada muda (`duplicate`);
- sem reserva: grava a linha já `RELEASED` (`not_reserved`), para que uma reserva atrasada com o mesmo `ticket_id`, por exemplo a de um timeout, seja recusada com `409`.

Justificativa: a devolução não precisa de resposta, precisa acontecer. Gravada junto com o cancelamento, ela não se perde se o `events-service` ou o RabbitMQ estiverem fora do ar, e o cancelamento nunca falha por causa deles. Na versão 1, a devolução era síncrona, e a queda do serviço de eventos desfazia o cancelamento.

## D32 — Eventos encerrados registrados no tickets-service, com lock consultivo

**Status:** provisória.

Com a cascata assíncrona (D33), existe uma janela: uma emissão que reservou a vaga antes do cancelamento do evento pode salvar o ingresso depois de o `tickets-service` ter cancelado os outros, e o ingresso ficaria `CONFIRMED` em um evento cancelado.

O `tickets-service` guarda os eventos cancelados ou removidos na tabela `closed_events`, gravada pelo consumidor da cascata. A transação da emissão e a da cascata começam com o mesmo `pg_advisory_xact_lock(hashtextextended(event_id, 0))`: uma espera a outra. Assim, ou o ingresso é salvo antes e cancelado junto com os demais, ou a emissão encontra o evento em `closed_events`, responde `409 Event is not open for registrations` e devolve a vaga (D30). É um lock consultivo porque o evento não tem linha no `tickets-db`.

A tabela também serve de recusa rápida: uma inscrição em evento já conhecido como encerrado responde `400 Event is not open for registrations` sem chamar o `events-service`.

## D33 — Cancelar ou remover evento cancela os ingressos de forma assíncrona

**Status:** confirmada pelo autor. Substitui a D22.

`PUT /events/{id}` com `status: CANCELLED` e `DELETE /events/{id}` travam o evento (`SELECT ... FOR UPDATE`), aplicam a mudança e gravam, na mesma transação do `events-db`, a atividade (`event.cancelled` ou `event.deleted`) e um aviso com o mesmo nome em `events.exchange`. O `tickets-service` consome a fila `tickets.event-updates` e, em uma transação com o lock da D32, registra o evento em `closed_events`, cancela os ingressos ativos com um único `UPDATE ... RETURNING` e grava um `ticket.cancelled` por ingresso, com `reason` `event_cancelled` ou `event_deleted`.

- As vagas não são devolvidas, porque o evento não aceita mais inscrições (como na D22).
- O consumo é idempotente: um aviso repetido não encontra ingressos ativos e não grava nada.
- A resposta do `PUT` ou do `DELETE` não espera os ingressos; eles aparecem como `CANCELLED` cerca de 1 s depois. O `events-service` não depende do `tickets-service`: se ele estiver fora, o aviso espera na fila.
- O travamento do evento continua necessário: ele espera as reservas em andamento terminarem antes de fechar o evento.

## D34 — Uma exchange por finalidade e publicação mensagem a mensagem

**Status:** provisória. Complementa a D20 e a D28.

| Exchange (topic) | Quem publica | Routing keys | Fila e consumidor |
|---|---|---|---|
| `activities.exchange` | `events-service` e `tickets-service` | `event.*` e `ticket.*` (atividades) | `logs.activity`, `logs-service` |
| `events.exchange` | `events-service` | `event.cancelled`, `event.deleted` | `tickets.event-updates`, `tickets-service` |
| `tickets.exchange` | `tickets-service` | `spot.release_requested` | `events.spot-releases`, `events-service` |

Cada fila tem a sua DLQ (`<fila>.dlq`) e é declarada pelo próprio consumidor; o publicador declara só as exchanges. A coluna `exchange` foi acrescentada a `outbox_messages`.

Justificativa: com `mandatory`, o broker devolve a mensagem que não chega a nenhuma fila. Se uma mesma exchange tivesse duas filas ligadas à mesma routing key, uma mensagem que chegasse só a uma delas, por exemplo com o `tickets-service` ainda sem a fila criada, não seria devolvida, e o aviso se perderia. Com uma fila por exchange e routing key, a devolução sempre indica que o consumidor ainda não existe.

O lote marca como publicadas só as mensagens que o broker confirmou e não devolveu. A devolvida continua pendente sem segurar as outras: uma fila ainda não criada não atrasa as atividades. Com mensagem devolvida e lote incompleto, o próximo ciclo espera o intervalo de nova tentativa (5 s).

## D35 — events-service em JavaScript com NestJS e TypeORM

**Status:** confirmada pelo autor (linguagem e stack). Os detalhes de implementação são provisórios.

NestJS e TypeORM nasceram para TypeScript, que fornece decorators e metadados de tipo. Em JavaScript:

- **Babel** transpila `src/` para `dist/` com `@babel/plugin-proposal-decorators` (modo `legacy`) e `@babel/plugin-transform-class-properties`; o Jest usa o mesmo `babel.config.json`.
- **Injeção de dependências** por `@Dependencies(...)` na classe, porque não há tipos dos parâmetros do construtor.
- **Parâmetros das rotas** por `@Bind(...)` no método, porque o JavaScript não tem decorators de parâmetro.
- **Validação explícita:** sem o tipo do parâmetro, o `ValidationPipe` global não saberia qual DTO aplicar. `ValidBody(Dto)` e `ValidQuery(Dto)` (`common/validation.js`) criam o pipe com `expectedType`, com as mesmas regras do `tickets-service` (`whitelist`, `forbidNonWhitelisted`, `transform`).
- **Tabelas com `EntitySchema`,** a forma do TypeORM sem decorators; as linhas são objetos simples. O formato das respostas no Swagger fica em `EventResponseDto`.
- **Swagger com tipos declarados:** todo `@ApiProperty` informa `type` ou `enum`. O teste `src/openapi.spec.js` gera o documento como o `main.js` e falha se algum campo ficar sem tipo.

## D36 — Portas, caminhos e ordem de subida da versão 3

**Status:** provisória.

- Portas internas: `events-service` em `3001`, `tickets-service` em `3002` e `logs-service` em `8000`. Só o `api-gateway` publica porta no host (`8080`).
- Caminhos públicos (D14): `/docs/{events,tickets,logs}`, `/health/{events,tickets,logs}` e `/metrics/{events,tickets,logs}`; jobs do Prometheus `events-service`, `tickets-service` e `logs-service`.
- Nenhum serviço depende de outro serviço para subir, só do próprio banco e do RabbitMQ. O `api-gateway` e o `prometheus` esperam o `events-service` e o `tickets-service` saudáveis, mas não o `logs-service` (D27).
- Os volumes são `events_pgdata`, `tickets_pgdata`, `logs_pgdata`, `rabbitmq_data` e `prometheus_data`. Os dois primeiros têm o mesmo nome dos volumes da versão 1, com outro esquema: quem rodou uma versão anterior na mesma máquina deve usar `docker compose down -v` antes de subir a versão 3 (D8).
