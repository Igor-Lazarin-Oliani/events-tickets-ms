# Roteiro da apresentação

Roteiro para a apresentação síncrona de até **30 minutos**, com data limite em **21/11**. A estrutura segue o edital: contextualização (com a justificativa da divisão dos microsserviços), arquitetura e demonstração a partir do repositório em máquina limpa, com rotas, persistência e coleta de telemetria. A explicação detalhada está em [guia-da-implementacao.md](guia-da-implementacao.md).

## Cronograma

O build começa logo no início e roda enquanto você apresenta a teoria. Assim, ele não consome tempo de demonstração.

| Tempo | Duração | Parte |
|---|---|---|
| 00:00 | 2 min | Abertura e início do build |
| 02:00 | 4 min | Contextualização do problema |
| 06:00 | 7 min | Arquitetura |
| 13:00 | 12 min | Demonstração |
| 25:00 | 2 min | Limitações e encerramento |
| 27:00 | 3 min | Folga para imprevistos e perguntas |

## Antes da aula

### Dias antes

- [ ] Ensaiar o roteiro inteiro com cronômetro, pelo menos uma vez, já com a versão 3.
- [ ] Medir o tempo do build em máquina limpa e anotar no passo "Abertura".
- [ ] Testar um "Try it out" em cada um dos três Swaggers.
- [ ] Testar a aplicação web (http://localhost:8080/) no projetor: o diagrama dos 10 contêineres e o rastro precisam caber na tela. Se não couberem, reduza o zoom do navegador para 90% ou 80%.
- [ ] Definir a máquina e testar a internet da sala. Se for ruim, levar o celular para roteador.
- [ ] Gravar um vídeo de uma execução bem-sucedida, como plano B.

### Deixar a máquina limpa

Faça isso antes da aula, com calma e com o Docker aberto. Os comandos apagam só o que é deste projeto, além do cache de build do Docker, que afeta também outros projetos, mas é refeito sozinho.

```powershell
# Na pasta de uma cópia anterior do projeto, se houver
docker compose down -v --rmi all --remove-orphans

# Volumes e imagens que sobraram das versões anteriores, se ainda existirem
docker volume rm events-tickets-ms_events_pgdata events-tickets-ms_tickets_pgdata events-tickets-ms_events_tickets_pgdata
docker rmi events-tickets-ms-events-service events-tickets-ms-tickets-service events-tickets-ms-events-tickets-service

docker rmi python:3.11-slim node:20-alpine
docker builder prune -af
```

Se algum `docker rmi` ou `docker volume rm` avisar que o item não existe, pode ignorar. Os volumes `events_pgdata` e `tickets_pgdata` precisam sumir: eles têm o mesmo nome dos da versão 1, mas outro esquema. Os contêineres usam `restart: unless-stopped` e voltam sozinhos quando o Docker reinicia: depois de cada ensaio, encerre com `docker compose down`, senão o `docker ps -a` da abertura vai mostrá-los. Depois, apague qualquer cópia antiga do projeto na pasta que vai usar.

### Na hora

- [ ] Docker Desktop aberto e porta 8080 livre.
- [ ] Git Bash aberto em uma pasta vazia, com a fonte aumentada.
- [ ] Este roteiro aberto para copiar os comandos.
- [ ] Notificações desligadas.

## 00:00: Abertura e início do build (2 min)

> "Meu trabalho é o events-tickets-ms, uma plataforma distribuída de eventos e ingressos com registro de atividades. Vou começar pela parte prática: vou clonar o repositório público e subir o ambiente do zero, nesta máquina limpa. Enquanto isso constrói, apresento o problema e a arquitetura."

```sh
docker ps -a
git clone https://github.com/Igor-Lazarin-Oliani/events-tickets-ms.git
cd events-tickets-ms
docker compose up --build -d
```

Aponte que o `docker ps -a` não mostra contêineres do projeto. Depois do comando de subida, passe para a explicação.

**Tempo de referência:** anote aqui o tempo medido no ensaio. São três imagens próprias (duas Node.js e uma Python), mais as imagens base; em máquina limpa, soma-se o download, que depende da internet.

## 02:00: Contextualização do problema (4 min)

Mostre o `README.md` no GitHub ou fale sem apoio.

> "O domínio é a gestão de eventos e a emissão de ingressos. É genérico: atende de um simpósio acadêmico a um show ou uma corrida. Inscrição e ingresso são a mesma coisa: ao se inscrever, a pessoa recebe um ingresso com código único e controle de presença."

> "O problema central é controlar vagas: não posso vender mais ingressos do que a capacidade, mesmo com muitas pessoas tentando ao mesmo tempo. E preciso saber o que aconteceu com cada evento e cada ingresso: quem esgotou, quando cancelou, o que a organização anotou."

**Por que esses três microsserviços:**

- **`events-service`** é dono dos eventos e das vagas. Só ele mexe em `available_spots`.
- **`tickets-service`** é dono das inscrições, dos ingressos e do check-in.
- **`logs-service`** guarda o registro de atividades. Ele só acrescenta dados, tem outra retenção e não pode impedir uma venda se cair.

> "Cada um tem seu banco e pode evoluir, escalar e falhar de forma independente. Para evidenciar a heterogeneidade, são três ecossistemas: eventos em JavaScript, ingressos em TypeScript, os dois com NestJS e TypeORM, e logs em Python com FastAPI."

> "O desafio é que a regra das vagas agora atravessa dois bancos: a vaga está no serviço de eventos, e o ingresso, no de ingressos. Boa parte da arquitetura existe para resolver isso sem perder consistência."

Se perguntarem por que não juntar eventos e ingressos: "Juntos, uma transação local resolveria. Foi assim na versão 2. Separados, cada serviço tem um dono claro e evolui sozinho, e a regra das vagas continua correta com reserva idempotente, compensação e mensagens. É o tipo de problema que um sistema distribuído real enfrenta."

## 06:00: Arquitetura (7 min)

Mostre o diagrama do `README.md`, seção **Arquitetura**, e percorra cada elemento, como o edital pede.

| Elemento | O que dizer |
|---|---|
| **Cliente** | "O cliente é a aplicação web, servida pelo próprio gateway. O Swagger e o curl também funcionam, sempre pela mesma porta." |
| **API Gateway** | "O NGINX é a única porta aberta, a 8080. Ele esconde a topologia e usa uma lista de rotas permitidas: a rota interna de reserva de vaga fica de fora." |
| **Microsserviços** | "Três serviços, em três ecossistemas, em camadas: rota, regra de negócio e acesso a dados." |
| **Bancos** | "Três PostgreSQL separados, um por serviço. O serviço de ingressos nunca lê o banco de eventos: recebe o evento na resposta da reserva." |
| **Comunicação síncrona** | "Duas chamadas REST com JSON: o serviço de ingressos reserva a vaga no de eventos, porque o cliente espera a resposta, e os dois consultam o histórico no de logs." |
| **Mensageria** | "Três exchanges no RabbitMQ: atividades para o serviço de logs, avisos de evento cancelado para o de ingressos e pedidos de devolução de vaga para o de eventos. Tudo sai de uma outbox." |
| **Observabilidade** | "O Prometheus coleta as métricas dos três, o Grafana exibe, e os logs são ligados por um identificador de correlação. O serviço de logs é de negócio, é auditoria; a observabilidade é o Prometheus e o Grafana." |

**Quatro decisões para destacar (cerca de 1 min cada):**

1. **Reserva atômica e idempotente.**
   > "A reserva é um único UPDATE condicional no banco de eventos: duas pessoas não ficam com a mesma vaga. O serviço de ingressos gera o id do ingresso antes e o usa como chave da reserva. Se a chamada repetir, por exemplo depois de um timeout, não reserva outra vaga."
2. **Compensação.**
   > "Se a vaga foi reservada e o ingresso não pôde ser salvo, ou se o serviço de eventos não respondeu, o serviço de ingressos pede a devolução. Como a devolução é feita pelo id do ingresso, ela desfaz a reserva se houve, e não muda nada se não houve."
3. **Outbox e mensagens entre os serviços.**
   > "Cancelar um ingresso grava, na mesma transação, o pedido de devolução da vaga. Cancelar um evento grava o aviso para o serviço de ingressos. Se o broker ou o outro serviço estiverem fora, as mensagens esperam, e nada se perde."
4. **Isolamento de falhas.**
   > "Se o serviço de logs cair, a venda continua, e só o histórico responde 503. Se o serviço de eventos cair, só a emissão para: consultas, check-in e cancelamentos seguem."

## 13:00: Demonstração (12 min)

Volte ao terminal. Copie um bloco de cada vez.

### 1. Ambiente no ar (1 min)

```sh
docker compose ps
```

> "São 10 contêineres saudáveis, e só o gateway publica porta no host."

Se ainda estiver subindo, repita o comando e aproveite para abrir as abas do próximo passo.

Abra no navegador:

- http://localhost:8080/ (aplicação web)
- http://localhost:8080/docs/events, http://localhost:8080/docs/tickets e http://localhost:8080/docs/logs
- http://localhost:8080/grafana/
- http://localhost:8080/prometheus/targets
- http://localhost:8080/rabbitmq/ (`events_tickets` / `events_tickets_pass`)

### Alternativa: passos 4, 5 e 8 pela aplicação web

A aplicação web cobre as rotas, a comunicação entre os serviços e as falhas, com o caminho de cada chamada desenhado ao lado. Os blocos de `curl` abaixo continuam valendo como plano B.

| Passo | Na aplicação | O que dizer |
|---|---|---|
| Rotas | **+ Novo evento** com capacidade 5, depois **Inscrever** um participante | "A inscrição entra pelo gateway no serviço de ingressos, que reserva a vaga no de eventos por REST e só então salva o ingresso. Um segundo depois, os registros chegam ao serviço de logs pelo RabbitMQ, com o mesmo identificador." |
| Concorrência | **⚡ Concorrência** com 20 inscrições | "Vinte inscrições ao mesmo tempo para 4 vagas: exatamente 4 passaram, e as outras receberam 409. O UPDATE condicional no banco de eventos não deixa vender além da capacidade." |
| Cancelamento | **Cancelar** um ingresso | "O cancelamento respondeu na hora. O pedido de devolução foi pelo RabbitMQ até o serviço de eventos, que devolveu a vaga: o evento está PUBLISHED de novo." |
| Comunicação síncrona | **Histórico** do evento | "A linha verde-azulada é o serviço de eventos consultando o de logs por HTTP REST, porque o usuário espera a resposta." |
| Cascata | **Cancelar evento** com ingressos | "O serviço de eventos avisou o de ingressos pelo RabbitMQ, que cancelou os ingressos." |
| CRUD de logs | Aba **Registro de atividades**: mude a triagem, adicione notas e arquive | "O fato é imutável; só a triagem muda, e excluir é arquivar." |
| Falha | Botão **Experimentos de falha**, cenários 1 e 2 | "Com o serviço de logs fora, a venda segue. Com o de eventos fora, só a emissão para, e a devolução de um cancelamento espera na fila." |
| Rastreamento | Botão **grep** de uma operação, colado no terminal | "A mesma operação no gateway e nos três serviços." |

### 2. Swagger (1 min)

Mostre os três Swaggers. No de eventos, execute `GET /events` em "Try it out" e mostre a rota `reserve-spot` marcada como interna.

> "As três APIs estão documentadas e são acessadas pelo gateway, todas com CRUD completo. A reserva de vaga aparece como integração: o gateway não a expõe."

### 3. Preparar o terminal (15 s)

```sh
GATEWAY=http://localhost:8080
JSON='Content-Type: application/json'
extract_id() { sed -E 's/.*"id":"([^"]+)".*/\1/'; }
show_event() { curl -s "$GATEWAY/events/$EVENT_ID"; echo; }
issue() {
  curl -s -X POST "$GATEWAY/tickets" -H "$JSON" -H "X-Correlation-Id: demo-$3" \
    -d "{\"event_id\":\"$EVENT_ID\",\"participant_name\":\"$1\",\"participant_email\":\"$2\",\"participant_document\":\"$3\"}"
}
```

### 4. Rotas e fluxo principal (3 min)

**Criar um evento com 2 vagas** (serviço de eventos):

```sh
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Workshop Docker","category":"WORKSHOP","modality":"ONLINE","location":"https://example.com/live","start_at":"2027-03-20T08:00:00-04:00","end_at":"2027-03-20T18:00:00-04:00","max_capacity":2}')
echo "$EVENT"
EVENT_ID=$(echo "$EVENT" | extract_id)
```

**Emitir 2 ingressos.** Cada emissão reserva a vaga no serviço de eventos e salva o ingresso no de ingressos.

```sh
TICKET_1=$(issue 'Ana Lima' 'ana@example.com' '2026000001')
echo "$TICKET_1"
TICKET_2=$(issue 'Bruno Reis' 'bruno@example.com' '2026000002')
echo "$TICKET_2"
TICKET_1_ID=$(echo "$TICKET_1" | extract_id)
TICKET_2_ID=$(echo "$TICKET_2" | extract_id)
show_event
```

> "As vagas chegaram a zero, e o evento mudou sozinho para SOLD_OUT. Quem mudou foi o serviço de eventos, a pedido do de ingressos."

**O terceiro ingresso é barrado:**

```sh
issue 'Carla Dias' 'carla@example.com' '2026000003'; echo
```

> "409, Event is sold out. A recusa veio do serviço de eventos e chegou ao cliente igual."

**Check-in do primeiro ingresso e cancelamento do segundo:**

```sh
curl -s -X PUT "$GATEWAY/tickets/$TICKET_1_ID" -H "$JSON" -d '{"status":"CHECKED_IN"}'; echo
curl -s -X DELETE "$GATEWAY/tickets/$TICKET_2_ID"; echo
sleep 2
show_event
```

> "O cancelamento respondeu na hora. A devolução da vaga foi pelo RabbitMQ, e um segundo depois o evento está PUBLISHED de novo, com available_spots igual a 1."

### 5. Comunicação entre os serviços (2 min)

**Histórico, pela chamada síncrona:**

```sh
curl -s "$GATEWAY/tickets/$TICKET_1_ID/history"; echo
curl -s "$GATEWAY/events/$EVENT_ID/history"; echo
```

> "Cada serviço consultou o de logs por HTTP. No evento, aparecem as duas reservas e a devolução, com o status de cada momento; os registros chegaram lá pelo RabbitMQ."

**A rota interna não passa pelo gateway:**

```sh
curl -s -X PATCH "$GATEWAY/events/$EVENT_ID/reserve-spot" -H "$JSON" -d '{"ticket_id":"00000000-0000-4000-8000-000000000000"}'; echo
```

> "404: a reserva é uma integração entre serviços, só pela rede interna."

**CRUD do serviço de logs:**

```sh
LOG=$(curl -s -X POST "$GATEWAY/logs" -H "$JSON" -d "{\"action\":\"incident.reported\",\"entity_type\":\"event\",\"entity_id\":\"$EVENT_ID\",\"level\":\"WARNING\",\"message\":\"Projetor do auditorio com defeito\"}")
echo "$LOG"
LOG_ID=$(echo "$LOG" | extract_id)
curl -s -X PUT "$GATEWAY/logs/$LOG_ID" -H "$JSON" -d '{"status":"RESOLVED","notes":"Projetor trocado"}'; echo
curl -s -X PUT "$GATEWAY/logs/$LOG_ID" -H "$JSON" -d '{"message":"reescrever o fato"}'; echo
curl -s -X DELETE "$GATEWAY/logs/$LOG_ID"; echo
```

> "Criei uma ocorrência manual, fiz a triagem e arquivei. O que aconteceu não pode ser reescrito, por isso o 422. E excluir é arquivar: o identificador da mensagem continua lá, para uma reentrega não recriar o registro."

Mostre as três filas na interface do RabbitMQ, em **Queues and Streams**, cada uma com um consumidor.

### 6. Coleta de telemetria (2 min)

```sh
curl -s "$GATEWAY/metrics/events" | grep -E '^events_spot_operations_total'
curl -s "$GATEWAY/metrics/tickets" | grep -E '^tickets_(issued|cancelled|spot_reservations)_total'
curl -s "$GATEWAY/metrics/logs" | grep -E '^logs_(entries_created|messages_consumed)_total'
docker compose logs api-gateway events-service tickets-service logs-service | grep demo-2026000001
```

> "Essa é uma única inscrição atravessando o gateway, o serviço de ingressos, a reserva no de eventos, o RabbitMQ e o serviço de logs, com o mesmo identificador."

Mostre nesta ordem:

1. **Prometheus:** os três alvos como `UP`.
2. **Grafana:** serviços no ar, ingressos, vagas, registros gravados, requisições, latência, reservas e mensagens.

Mostre o Grafana **antes** da persistência, porque os contadores zeram quando os serviços reiniciam.

### 7. Persistência (1,5 min)

```sh
docker compose down
docker compose ps -a
docker compose up -d --wait
show_event
curl -s "$GATEWAY/tickets/$TICKET_1_ID/history"; echo
```

> "Removi todos os contêineres, e nenhum ficou de pé. Ao subir de novo, o evento, os ingressos e o histórico continuam lá, porque os dados estão nos volumes dos três bancos."

A subida leva cerca de 30 s. Use esse tempo para explicar a diferença entre contêiner e volume.

### 8. Falha do serviço de eventos (1,5 min)

```sh
docker compose stop events-service
issue 'Daniel Melo' 'daniel@example.com' '2026000004'; echo
curl -s -X PUT "$GATEWAY/tickets/$TICKET_1_ID" -H "$JSON" -d '{"modality_tier":"VIP"}'; echo
docker compose up -d --wait events-service
```

> "Com o serviço de eventos fora, a emissão respondeu 503, sem emitir nada: sem vaga reservada, não há ingresso. O resto do serviço de ingressos continuou funcionando, como a edição do ingresso. É o isolamento de falhas."

### Se sobrar tempo: falha do serviço de logs

```sh
docker compose stop logs-service
issue 'Elisa Prado' 'elisa@example.com' '2026000005'; echo
curl -s "$GATEWAY/tickets/$TICKET_1_ID/history"; echo
docker compose up -d --wait logs-service
sleep 3
curl -s "$GATEWAY/logs?action=ticket.issued&limit=1"; echo
```

> "Com o serviço de logs fora, a emissão funcionou normalmente, e só o histórico respondeu 503. Quando ele voltou, consumiu as mensagens que esperavam na fila."

### Se sobrar tempo: cancelamento de evento

```sh
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Festival Indie","category":"CONCERT","modality":"IN_PERSON","location":"Parque das Nacoes","start_at":"2027-04-10T18:00:00-04:00","end_at":"2027-04-10T23:00:00-04:00","max_capacity":10}')
EVENT_ID=$(echo "$EVENT" | extract_id)
issue 'Eva Nunes' 'eva@example.com' '2026000006'; echo
issue 'Fabio Ramos' 'fabio@example.com' '2026000007'; echo
curl -s -X PUT "$GATEWAY/events/$EVENT_ID" -H "$JSON" -d '{"status":"CANCELLED"}'; echo
sleep 2
curl -s "$GATEWAY/tickets?event_id=$EVENT_ID&status=CANCELLED"; echo
```

> "O serviço de eventos cancelou o evento e avisou o de ingressos pelo RabbitMQ, que cancelou os dois ingressos. Uma inscrição que estivesse no meio do caminho seria cancelada junto ou recusada: a emissão e o cancelamento em cascata usam o mesmo lock por evento no banco de ingressos."

### Se sobrar tempo: falha do RabbitMQ

```sh
docker compose stop rabbitmq
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Corrida de Rua","category":"SPORTS","modality":"IN_PERSON","location":"Parque Laguna","start_at":"2027-04-18T07:00:00-04:00","end_at":"2027-04-18T11:00:00-04:00","max_capacity":10}')
EVENT_ID=$(echo "$EVENT" | extract_id)
docker compose exec events-db psql -U events_user -d events_db -c 'select exchange, routing_key from outbox_messages where published_at is null;'
docker compose up -d --wait rabbitmq
sleep 10
curl -s "$GATEWAY/events/$EVENT_ID/history"; echo
```

> "Com o broker fora, o evento foi criado, e a mensagem ficou na outbox do banco de eventos. Quando o broker voltou, ela foi publicada e gravada no serviço de logs."

## 25:00: Limitações e encerramento (2 min)

> "Por escopo, não implementei autenticação, e o foco foi a arquitetura distribuída. Entre os serviços, a consistência é eventual em três pontos: a devolução de vaga, o cancelamento em cascata e o histórico, todos com cerca de um segundo de atraso e sem perda de mensagens. Como evolução, eu colocaria autenticação, migrações de banco e múltiplas instâncias atrás do gateway."

> "O projeto atende aos itens do edital: três serviços heterogêneos com CRUD completo, banco por serviço, tudo em contêineres, API Gateway, observabilidade com Prometheus e Grafana e mensageria nos dois sentidos. O código e o guia de execução estão no repositório público. Obrigado."

## Se algo der errado

| Problema | O que fazer |
|---|---|
| Build lento | Siga a teoria; ela cobre até 13 minutos. Se precisar, encurte a arquitetura |
| Sem internet | Use o celular como roteador; em último caso, mostre o vídeo gravado |
| Porta 8080 ocupada | No PowerShell, `netstat -ano \| findstr :8080`, e encerre o processo |
| Contêiner sem ficar `healthy` | `docker compose logs <nome>` e, se necessário, `docker compose up -d --wait` |
| Serviço NestJS não sobe com erro de coluna ou tabela | Sobraram volumes de uma versão anterior: `docker compose down -v` e suba de novo |
| Vaga ainda não voltou depois do cancelamento | Espere 1 a 2 s: a devolução passa pela outbox e pelo RabbitMQ |
| Histórico vazio logo após a operação | Espere 1 a 2 s: o registro passa pela outbox e pelo RabbitMQ |
| Grafana sem dados | Confira o Prometheus e o intervalo "Last 15 minutes"; a coleta leva alguns segundos |
| Variáveis perdidas no terminal | Rode de novo os blocos "Preparar o terminal" e "Criar um evento" |
| `404` no `POST /tickets` pelo Swagger | Troque o `event_id` do exemplo pelo do evento criado |
| `409` de participante já inscrito | Use outro `participant_document` |
| Estourando o tempo | Pule os blocos opcionais e o passo 8; nunca pule rotas, persistência e telemetria |

## Perguntas prováveis

**Por que eventos e ingressos em serviços separados, se a regra das vagas envolve os dois?**
Porque cada um tem um dono claro: o serviço de eventos é a fonte da verdade sobre as vagas, e o de ingressos, sobre os participantes. Separados, evoluem e falham de forma independente: com o serviço de eventos fora, ingressos continuam consultáveis e canceláveis. A regra continua correta com reserva atômica e idempotente, compensação e mensagens.

**O que acontece se a reserva der timeout?**
O serviço de ingressos não sabe se a vaga foi reservada, então responde 503 e pede a devolução. A devolução é feita pelo id do ingresso: se a reserva aconteceu, é desfeita; se não, nada muda. E se a reserva chegar atrasada, depois da devolução, ela é recusada, porque a devolução deixa registrado aquele id como devolvido.

**E se a reserva der certo e o ingresso não puder ser salvo?**
É a compensação: o serviço de ingressos grava na outbox o pedido de devolução da vaga, e o de eventos a devolve ao consumir. É uma saga: em vez de rollback entre bancos, uma ação que desfaz a anterior.

**Por que a reserva é síncrona e a devolução é assíncrona?**
A reserva precisa de resposta: o cliente quer saber na hora se conseguiu o ingresso. A devolução não precisa de resposta, precisa acontecer. Gravada junto com o cancelamento, ela não se perde, e o cancelamento não falha se o serviço de eventos estiver fora.

**E se alguém se inscrever no instante em que o evento é cancelado?**
A emissão e o cancelamento em cascata usam o mesmo lock por evento no banco de ingressos. Ou o ingresso é salvo antes e cancelado junto com os outros, ou a inscrição vê que o evento foi encerrado, desiste e devolve a vaga.

**Então o serviço de logs não é só um serviço artificial para cumprir o edital?**
Não: ele responde uma pergunta de negócio, o que aconteceu com cada evento e ingresso, e permite a triagem das ocorrências. E tem características que justificam a separação: só acrescenta dados, tem outra retenção e não pode derrubar a venda.

**Por que CRUD em logs? Log não é imutável?**
O fato é imutável: ação, entidade, mensagem e data não mudam, e tentar responde 422. O que muda é a triagem: status e anotações. E excluir é arquivar, porque apagar de verdade deixaria uma mensagem repetida recriar o registro.

**O serviço de logs é a observabilidade do sistema?**
Não. Ele é auditoria de negócio. A observabilidade é o Prometheus coletando métricas dos três serviços, o Grafana exibindo e os logs dos contêineres ligados pelo identificador de correlação.

**Por que três bancos, e não um só?**
Para desacoplar a persistência: cada serviço evolui seu esquema e falha sem afetar os outros. O serviço de ingressos nunca lê o banco de eventos; recebe o evento na resposta da reserva e guarda uma cópia no ingresso.

**Por que JavaScript em um serviço e TypeScript em outro?**
Para evidenciar a heterogeneidade e mostrar o que muda sem sistema de tipos: no serviço em JavaScript, a injeção de dependências, os parâmetros das rotas, a validação e o Swagger precisam ser declarados explicitamente, e um teste gera o Swagger para garantir que nada ficou sem tipo.

**O que acontece se duas pessoas tentarem a última vaga?**
O `UPDATE` condicional só altera a linha se ainda houver vaga. Uma consegue, e a outra recebe `409`. Testei com 20 inscrições simultâneas para 5 vagas: exatamente 5 foram emitidas.

**E se alguém tentar se inscrever num evento que já acabou, ou que não existe?**
É recusado: evento inexistente responde `404`, e evento com o `end_at` no passado responde `400 Event has already ended`, sem consumir vaga. A regra também está no `UPDATE` da reserva, então nem uma corrida no último segundo passa.

**A mensagem pode ser processada duas vezes?**
Pode chegar duas vezes, porque a entrega é "ao menos uma vez". Cada consumidor é idempotente: o de logs pelo identificador da mensagem, o de eventos pelo id do ingresso da reserva, e o de ingressos só cancela ingressos ainda ativos.

**Por que não publicar direto no RabbitMQ?**
Se o broker estiver fora, ou o processo cair entre o commit e a publicação, a mensagem se perde. A outbox grava a mensagem na mesma transação.

**Por que três exchanges?**
Uma por finalidade, cada uma com a sua fila. Com a publicação obrigatória (`mandatory`), o broker devolve a mensagem que não chega a nenhuma fila, e isso só é um aviso confiável se cada routing key tiver uma fila só.

**Isso é consistente?**
Cada serviço é consistente no próprio banco, no momento da operação. Entre os serviços, a devolução de vaga, a cascata e o histórico são eventualmente consistentes, normalmente em cerca de 1 s, sem perda.

**Por que NGINX?**
É simples e suficiente para roteamento e entrada única. Traefik ou Kong seriam úteis com descoberta automática ou plugins de autenticação e limite de requisições.

**O gateway é um ponto único de falha?**
Neste ambiente, sim. Em produção, haveria mais de uma instância atrás de um balanceador.

**Como escalaria?**
Mais instâncias dos serviços atrás do gateway. A reserva continuaria correta, porque quem garante é o banco, e as outbox já travam as mensagens com `SKIP LOCKED`, então dois publicadores não enviam a mesma linha.

**Como rastrear uma requisição?**
Pelo `X-Correlation-Id`: o gateway o gera, os serviços o repassam entre si por HTTP e nas mensagens, e ele fica gravado em cada registro de logs, que pode ser filtrado por ele.

**A animação da aplicação web é real ou só ilustrativa?**
Ela acompanha chamadas reais, só que em câmera lenta. A parte síncrona é desenhada com a resposta HTTP de verdade, e a assíncrona só aparece quando o registro com o mesmo `X-Correlation-Id` chega ao serviço de logs; o caminho desenhado vem do próprio registro, como a devolução passando pelo serviço de eventos. Os tempos no rastro são os reais, e a saúde de cada contêiner é consultada a cada 2 s pelo gateway.

**Por que a aplicação web não tem contêiner próprio?**
São só arquivos estáticos, sem regra de negócio. O próprio gateway os serve, na mesma origem da API: não há CORS nem etapa de build, e a página entra pela porta 8080 como qualquer cliente.
