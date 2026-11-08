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

O `DELETE /events/{id}` é permitido, como na especificação: o Serviço A não conhece ingressos e consultá-los criaria dependência circular. Os ingressos mantêm o `event_snapshot`, e `404` em `release-spot` não impede o cancelamento.

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
