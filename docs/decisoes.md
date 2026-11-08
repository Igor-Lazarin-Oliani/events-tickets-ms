# Decisões do projeto

Decisões que refinam ou completam o [prompt.md](prompt.md). As marcadas como **provisórias** foram adotadas pelo agente onde a especificação era omissa e podem ser revistas pelo autor. Numere novas decisões em sequência e não reaproveite números.

## D1 — Cancelamento é soft delete

**Status:** confirmada pelo autor.

`DELETE /tickets/:id` muda o status para `CANCELLED` e mantém o registro. O histórico fica visível na demonstração, e repetir a operação responde `409`, sem devolver a vaga duas vezes.

## D2 — Mudança de capacidade preserva as vagas ocupadas

**Status:** confirmada pelo autor. Substitui o cálculo proporcional da versão original do prompt.

`available_spots = nova capacidade - ocupadas`. Reduzir abaixo das ocupadas responde `409`. O cálculo proporcional deixaria as vagas inconsistentes com os ingressos: 100 vagas com 50 ocupadas, ao dobrar para 200, resultariam em 100 ocupadas para apenas 50 ingressos.

## D3 — Uma inscrição ativa por documento em cada evento

**Status:** confirmada pelo autor.

Não pode haver dois ingressos não cancelados com o mesmo `participant_document` no mesmo evento. Quem cancelou pode se inscrever de novo. A garantia é um índice único parcial no `tickets_db`, e a demonstração deve usar documentos diferentes.

## D4 — Testes automatizados das regras principais

**Status:** confirmada pelo autor.

`pytest` no `events-service` e Jest no `tickets-service`, restritos às regras de vagas e aos fluxos de emissão e cancelamento com compensação. As dependências de teste ficam fora da imagem de produção do `events-service`.

## D5 — Regras de transição e compensação de ingressos

**Status:** provisória.

- O `PUT` não cancela ingressos, e o check-in só parte de `CONFIRMED`.
- Falha do Serviço A na emissão responde `503`, sem criar ingresso.
- Falha de `release-spot` no cancelamento restaura o status anterior e responde `503`, mantendo a ordem da seção 6 do prompt.
- Timeouts podem deixar o resultado da operação remota desconhecido. É uma limitação aceita e documentada, porque a comunicação é síncrona e não há idempotência.

## D6 — Exclusão de evento com ingressos ativos

**Status:** provisória.

O `DELETE /events/{id}` é permitido, como na especificação: o Serviço A não conhece ingressos e consultá-los criaria dependência circular. Os ingressos mantêm o `event_snapshot`, e `404` em `release-spot` não impede o cancelamento. Desde a D16, os ingressos ativos do evento removido também são cancelados de forma assíncrona.

## D7 — Correlação entre chamadas por cabeçalho

**Status:** provisória.

O cabeçalho `X-Correlation-Id` liga os logs dos dois serviços e atende ao requisito de rastreamento de chamadas sem adicionar contêineres.

## D8 — Sem ferramenta de migração

**Status:** provisória.

As tabelas são criadas por `create_all` e `synchronize: true`, como definido no prompt. É adequado para um trabalho prático sem dados a preservar. Mudanças de modelo exigem `docker compose down -v`.

## D10 — Datas com fuso e `PUT` parcial em eventos

**Status:** provisória.

`start_at` e `end_at` exigem fuso horário, para que uma data ambígua não seja gravada em horário errado. O `PUT /events/{id}` altera apenas os campos enviados, como já indicava o `EventUpdate` do prompt.

## D9 — `README.md` na raiz

**Status:** provisória.

Toda a documentação fica em `docs/`, exceto o `README.md`, previsto na raiz pelo prompt e exibido pelo GitHub na página do repositório.

## D11 — Evento esgotado responde `409`, e não `400`

**Status:** provisória. Corrige a ordem das validações da versão original do prompt.

Um evento esgotado tem status `SOLD_OUT`. Na ordem original, ele cairia na regra `status !== PUBLISHED` e responderia `400`, mas o roteiro da demonstração exige `409 Event is sold out` no terceiro ingresso. Por isso, `SOLD_OUT` é verificado antes; `CANCELLED` e `FINISHED` continuam respondendo `400`.

## D13 — API Gateway NGINX como única porta de entrada

**Status:** confirmada pelo autor. Substitui a topologia estrita de 4 contêineres.

O edital pontua o gateway. O `api-gateway` publica a porta `8080`; serviços e bancos ficam acessíveis só na rede interna. O NGINX usa lista de rotas permitidas: `reserve-spot` e `release-spot` não têm rota pública e respondem `404`, o que reduz a falta de autenticação entre serviços. O `tickets-service` continua chamando o `events-service` diretamente pela rede interna.

## D14 — Swagger, saúde e métricas sob caminhos do gateway

**Status:** confirmada pelo autor. Substitui a rota `/docs` de cada serviço.

Os dois serviços tinham `/docs`, `/health` e `/metrics`, que colidiriam em uma única porta. O Swagger agora é servido em `/docs/events` e `/docs/tickets`, diretamente pelos serviços, sem reescrita de URL, o que mantém o "Try it out" funcionando pelo gateway. Saúde e métricas são publicadas em `/health/{events,tickets}` e `/metrics/{events,tickets}`.

## D15 — Prometheus e Grafana provisionados e atrás do gateway

**Status:** confirmada pelo autor (uso das ferramentas). O acesso pelo gateway e o modo anônimo são provisórios.

O edital pede coleta por ferramentas especializadas. O Prometheus coleta `/metrics` dos dois serviços a cada 5 s, pela rede interna, e o Grafana já sobe com fonte de dados e painel definidos em arquivos, sem passo manual. Os dois são acessados por `/prometheus/` e `/grafana/`, mantendo a porta única da D13. O Grafana abre sem login, somente leitura, para simplificar a demonstração; editar exige `admin`/`admin`, credencial exclusiva do ambiente local.

## D16 — Mensageria com RabbitMQ e outbox

**Status:** confirmada pelo autor (uso do RabbitMQ e cenário de cancelamento). O uso da outbox é provisório.

Cancelar ou remover um evento grava uma mensagem na tabela `outbox_messages`, na mesma transação da mudança. Uma thread do `events-service` publica as pendentes a cada segundo, com publisher confirms, e só então as marca como publicadas. Assim, nem uma queda do broker nem uma falha entre o commit e a publicação perdem a mensagem.

A entrega é "ao menos uma vez": o `tickets-service` é idempotente e confirma a mensagem só depois de gravar. Mensagens inválidas vão para a fila `tickets.event-updates.dlq`, e falhas temporárias voltam para a fila. Os ingressos são cancelados sem devolver vagas, pois o evento não aceita mais inscrições.

## D17 — Evento cancelado não pode ser reaberto

**Status:** provisória.

`CANCELLED` passa a ser um estado final: mudar para outro status responde `409`. Se o evento pudesse ser reaberto, seus ingressos já cancelados deixariam vagas presas, e uma mensagem atrasada poderia cancelar ingressos emitidos depois da reabertura.

## D12 — `PUT /tickets/:id` parcial e estrito

**Status:** provisória.

O `PUT` altera apenas os campos enviados e recusa com `400` campos desconhecidos, `event_id`, `null` e qualquer `status` diferente de `CHECKED_IN`. O `ValidationPipe` global usa `forbidNonWhitelisted`, então o mesmo vale para os outros corpos e filtros da API.
