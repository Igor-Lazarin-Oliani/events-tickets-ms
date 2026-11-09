# Decisões do projeto

Decisões que refinam ou completam o [prompt.md](prompt.md). As marcadas como **provisórias** foram adotadas pelo agente onde a especificação era omissa e podem ser revistas pelo autor. Numere novas decisões em sequência e não reaproveite números.

A partir da D18, o sistema tem dois microsserviços: o `events-tickets-service` (eventos e ingressos, NestJS) e o `logs-service` (registro de atividades, Python). As decisões anteriores que tratavam da comunicação entre o antigo `events-service` e o antigo `tickets-service` estão marcadas como substituídas, e foram mantidas como histórico.

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

**Status:** confirmada pelo autor. Atualizada pela D18.

Jest no `events-tickets-service` (vagas, emissão, cancelamento, cancelamento em cascata, outbox e cliente HTTP do histórico) e `pytest` no `logs-service` (CRUD, arquivamento e consumidor). As dependências de teste ficam fora da imagem de produção do `logs-service`.

## D5 — Regras de transição e compensação de ingressos

**Status:** provisória. **Compensação substituída pela D18.**

- O `PUT` não cancela ingressos, e o check-in só parte de `CONFIRMED`. *(continua valendo)*
- ~~Falha do Serviço A na emissão responde `503`, sem criar ingresso.~~
- ~~Falha de `release-spot` no cancelamento restaura o status anterior e responde `503`.~~
- ~~Timeouts podem deixar o resultado da operação remota desconhecido.~~

Com eventos e ingressos no mesmo banco, reserva e emissão, e cancelamento e devolução, acontecem em uma única transação. Não há operação remota a compensar.

## D6 — Exclusão de evento com ingressos ativos

**Status:** provisória. **Substituída pela D22.**

Era permitida, e os ingressos eram cancelados de forma assíncrona pela mensageria. Agora o cancelamento acontece na mesma transação da remoção.

## D7 — Correlação entre chamadas por cabeçalho

**Status:** provisória. Atualizada pela D18.

O cabeçalho `X-Correlation-Id` liga os logs do gateway e dos dois serviços. O `events-tickets-service` o repassa na chamada HTTP ao `logs-service` e o grava em cada mensagem de atividade; o `logs-service` guarda o valor no registro, o que permite filtrar `GET /logs?correlation_id=`.

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

**Status:** provisória. Corrige a ordem das validações da versão original do prompt.

Um evento esgotado tem status `SOLD_OUT`. Na ordem original, ele cairia na regra `status !== PUBLISHED` e responderia `400`, mas o roteiro da demonstração exige `409 Event is sold out` no terceiro ingresso. Por isso, `SOLD_OUT` é verificado antes; `CANCELLED` e `FINISHED` continuam respondendo `400`.

## D12 — `PUT /tickets/:id` parcial e estrito

**Status:** provisória.

O `PUT` altera apenas os campos enviados e recusa com `400` campos desconhecidos, `event_id`, `null` e qualquer `status` diferente de `CHECKED_IN`. O `ValidationPipe` global usa `forbidNonWhitelisted`, então o mesmo vale para os outros corpos e filtros do `events-tickets-service`.

## D13 — API Gateway NGINX como única porta de entrada

**Status:** confirmada pelo autor. Atualizada pela D18.

O edital pontua o gateway. O `api-gateway` publica a porta `8080`; serviços e bancos ficam acessíveis só na rede interna. O NGINX usa lista de rotas permitidas, e qualquer caminho fora dela responde `404`. As rotas internas `reserve-spot` e `release-spot` deixaram de existir com a D18. O `events-tickets-service` chama o `logs-service` diretamente pela rede interna.

## D14 — Swagger, saúde e métricas sob caminhos do gateway

**Status:** confirmada pelo autor. Caminhos atualizados pela D18.

Os dois serviços têm `/docs`, `/health` e `/metrics`, que colidiriam em uma única porta. O Swagger é servido em `/docs/events-tickets` e `/docs/logs`, diretamente pelos serviços, sem reescrita de URL, o que mantém o "Try it out" funcionando pelo gateway. Saúde e métricas são publicadas em `/health/{events-tickets,logs}` e `/metrics/{events-tickets,logs}`.

## D15 — Prometheus e Grafana provisionados e atrás do gateway

**Status:** confirmada pelo autor (uso das ferramentas). O acesso pelo gateway e o modo anônimo são provisórios.

O edital pede coleta por ferramentas especializadas. O Prometheus coleta `/metrics` dos dois serviços a cada 5 s, pela rede interna, e o Grafana já sobe com fonte de dados e painel definidos em arquivos, sem passo manual. Os dois são acessados por `/prometheus/` e `/grafana/`, mantendo a porta única da D13. O Grafana abre sem login, somente leitura, para simplificar a demonstração; editar exige `admin`/`admin`, credencial exclusiva do ambiente local.

O `logs-service` é um serviço de domínio (registro de atividades), e não substitui essa camada: a observabilidade continua sendo Prometheus, Grafana e os logs estruturados dos contêineres.

## D16 — Mensageria com RabbitMQ e outbox

**Status:** confirmada pelo autor (uso do RabbitMQ). **Destino e conteúdo substituídos pela D20.**

A outbox continua: a mensagem é gravada na mesma transação da mudança e publicada depois, com publisher confirms. O que mudou é o que se publica e quem consome: antes, só `event.cancelled` e `event.deleted`, consumidas pelo antigo `tickets-service`; agora, toda atividade de eventos e ingressos, consumida pelo `logs-service`.

## D17 — Evento cancelado não pode ser reaberto

**Status:** provisória.

`CANCELLED` passa a ser um estado final: mudar para outro status responde `409`. Se o evento pudesse ser reaberto, os ingressos cancelados junto com ele deixariam vagas presas, já que o cancelamento em cascata não devolve vagas.

## D18 — Eventos e ingressos em um único microsserviço

**Status:** confirmada pelo autor. Substitui a topologia `events-service` + `tickets-service`.

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

**Status:** provisória (contrato das mensagens). O uso de RabbitMQ e outbox segue a D16.

Cada operação que altera eventos ou ingressos grava, na mesma transação, uma ou mais mensagens em `outbox_messages`. O publicador do `events-tickets-service` as envia a cada segundo para a exchange `events-tickets.exchange` (topic), com a ação como routing key: `event.created`, `event.updated`, `event.cancelled`, `event.deleted`, `event.spot_reserved`, `event.spot_released`, `ticket.issued`, `ticket.updated`, `ticket.checked_in` e `ticket.cancelled`. O `logs-service` consome a fila `logs.activity`, ligada a `event.*` e `ticket.*`.

- As mensagens nunca levam nome, e-mail ou documento do participante; no `ticket.updated`, só o nome dos campos alterados.
- A publicação usa `mandatory`: se o `logs-service` ainda não criou a fila, o broker devolve a mensagem, e o lote continua pendente.
- O publicador mantém a conexão aberta entre os lotes, porque agora há mensagem a cada operação.
- O consumidor grava e só então confirma (`ack`). O `message_id` único descarta entregas repetidas; mensagem inválida vai para `logs.activity.dlq`; falha do banco devolve a mensagem à fila depois de 5 s.

## D21 — Histórico consultado por HTTP síncrono

**Status:** confirmada pelo autor.

`GET /events/{id}/history` e `GET /tickets/{id}/history` (UUID ou `ticket_code`) verificam que a entidade existe e chamam `GET /logs?entity_type=&entity_id=&order=asc` no `logs-service`, com timeout de 3 s e o `X-Correlation-Id` repassado. Se o `logs-service` estiver fora do ar ou demorar, só essas rotas respondem `503 Logs service unavailable`; emissão, cancelamento e o resto da API continuam funcionando. O histórico de um evento removido continua disponível diretamente em `GET /logs?entity_type=event&entity_id=`.

## D22 — Cancelar ou remover evento cancela os ingressos na mesma transação

**Status:** confirmada pelo autor. Substitui a D6 e o cancelamento assíncrono da D16.

`PUT /events/{id}` com `status: CANCELLED` e `DELETE /events/{id}` travam a linha do evento (`SELECT ... FOR UPDATE`), cancelam os ingressos ativos com um único `UPDATE ... RETURNING` e gravam as mensagens, tudo na mesma transação. Para o cliente, o comportamento é o mesmo de antes, mas sem atraso: a resposta já sai com os ingressos cancelados. As vagas não são devolvidas, porque o evento não aceita mais inscrições. Os ingressos mantêm o `event_snapshot`.

Travar o evento antes de cancelar os ingressos fecha a janela de corrida que existia na versão assíncrona: uma emissão simultânea espera o lock e, depois, ou vê o evento fechado (`409`/`404`), ou já foi gravada e é cancelada junto.

## D23 — Erros de validação respondem `400` no `events-tickets-service`

**Status:** provisória.

Com a D18, as rotas de eventos passaram do FastAPI para o NestJS, cujo `ValidationPipe` responde `400`. Por coerência, todo o `events-tickets-service` usa `400` para corpo inválido, UUID inválido, data sem fuso e fim antes do início. O `logs-service`, em FastAPI, mantém `422` para dados inválidos.
