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

- [ ] Ensaiar o roteiro inteiro com cronômetro, pelo menos uma vez, já com a versão nova.
- [ ] Testar um "Try it out" em cada Swagger.
- [ ] Testar a aplicação web (http://localhost:8080/) no projetor: o diagrama e o rastro precisam caber na tela. Se não couberem, reduza o zoom do navegador para 90%.
- [ ] Definir a máquina e testar a internet da sala. Se for ruim, levar o celular para roteador.
- [ ] Gravar um vídeo de uma execução bem-sucedida, como plano B.

### Deixar a máquina limpa

Faça isso antes da aula, com calma e com o Docker aberto. Os comandos apagam só o que é deste projeto, além do cache de build do Docker, que afeta também outros projetos, mas é refeito sozinho.

```powershell
# Na pasta de uma cópia anterior do projeto, se houver
docker compose down -v --rmi all --remove-orphans

# Volumes e imagens que sobraram da versão 1, se ainda existirem
docker volume rm events-tickets-ms_events_pgdata events-tickets-ms_tickets_pgdata
docker rmi events-tickets-ms-events-service events-tickets-ms-tickets-service

docker rmi python:3.11-slim node:20-alpine
docker builder prune -af
```

Se algum `docker rmi` ou `docker volume rm` avisar que o item não existe, pode ignorar. Os contêineres usam `restart: unless-stopped` e voltam sozinhos quando o Docker reinicia: depois de cada ensaio, encerre com `docker compose down`, senão o `docker ps -a` da abertura vai mostrá-los. Depois, apague qualquer cópia antiga do projeto na pasta que vai usar.

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

**Tempo de referência:** neste computador, o build e a subida levaram cerca de 1 min 20 s com as imagens base já baixadas. Em máquina limpa, soma-se o download, que depende da internet.

## 02:00: Contextualização do problema (4 min)

Mostre o `README.md` no GitHub ou fale sem apoio.

> "O domínio é a gestão de eventos e a emissão de ingressos. É genérico: atende de um simpósio acadêmico a um show ou uma corrida. Inscrição e ingresso são a mesma coisa: ao se inscrever, a pessoa recebe um ingresso com código único e controle de presença."

> "O problema central é controlar vagas: não posso vender mais ingressos do que a capacidade, mesmo com muitas pessoas tentando ao mesmo tempo. E preciso saber o que aconteceu com cada evento e cada ingresso: quem esgotou, quando cancelou, o que a organização anotou."

**Por que esses dois microsserviços:**

- **`events-tickets-service`** cuida de eventos e ingressos juntos, porque os dois dividem a regra das vagas. No mesmo banco, reservar a vaga e emitir o ingresso é uma transação só.
- **`logs-service`** guarda o registro de atividades. Ele só acrescenta dados, tem outra retenção e não pode impedir uma venda se cair. Por isso é separado e recebe tudo de forma assíncrona.

> "Cada um tem seu banco e pode evoluir, escalar e falhar de forma independente. Para evidenciar a heterogeneidade, o principal é em TypeScript com NestJS e o de logs em Python com FastAPI."

Se perguntarem por que não separar eventos e ingressos: "Era assim na primeira versão. Para emitir um ingresso, um serviço pedia a vaga ao outro por HTTP e, se falhasse depois, precisava devolvê-la. Um timeout deixava a dúvida se a vaga tinha sido reservada. Juntos, o banco garante tudo numa transação."

## 06:00: Arquitetura (7 min)

Mostre o diagrama do `README.md`, seção **Arquitetura**, e percorra cada elemento, como o edital pede.

| Elemento | O que dizer |
|---|---|
| **Cliente** | "O cliente é a aplicação web, servida pelo próprio gateway. O Swagger e o curl também funcionam, sempre pela mesma porta." |
| **API Gateway** | "O NGINX é a única porta aberta, a 8080. Ele esconde a topologia e usa uma lista de rotas permitidas." |
| **Microsserviços** | "Dois serviços, em tecnologias diferentes, em camadas: rota, regra de negócio e acesso a dados." |
| **Bancos** | "Dois PostgreSQL separados, um por serviço. O de logs nunca lê o banco de eventos, e vice-versa." |
| **Mensageria** | "Toda mudança em eventos e ingressos vira uma mensagem no RabbitMQ, que o serviço de logs grava. O serviço principal não espera por ele." |
| **Comunicação síncrona** | "Para mostrar o histórico de um ingresso, o serviço principal consulta o de logs por REST com JSON, porque o usuário está esperando a resposta." |
| **Observabilidade** | "O Prometheus coleta as métricas, o Grafana exibe e os logs são ligados por um identificador de correlação. Atenção: o serviço de logs é de negócio, é auditoria. A observabilidade é o Prometheus e o Grafana." |

**Três decisões para destacar (1 min cada):**

1. **Reserva atômica.**
   > "A reserva é um único UPDATE condicional, dentro da mesma transação que salva o ingresso. O banco garante que duas pessoas não fiquem com a mesma vaga, e, se algo falhar, a vaga volta sozinha no rollback."
2. **Outbox.**
   > "A mensagem para o serviço de logs é gravada na mesma transação da mudança. Se o RabbitMQ estiver fora, ela espera. Publicar diretamente poderia perder a mensagem."
3. **Isolamento de falhas.**
   > "Se o serviço de logs cair, a venda continua. As mensagens esperam na fila, e só a consulta de histórico responde 503. Como a entrega é ao menos uma vez, o serviço de logs descarta mensagens repetidas pelo identificador."

## 13:00: Demonstração (12 min)

Volte ao terminal. Copie um bloco de cada vez.

### 1. Ambiente no ar (1 min)

```sh
docker compose ps
```

> "São 8 contêineres saudáveis, e só o gateway publica porta no host."

Se ainda estiver subindo, repita o comando e aproveite para abrir as abas do próximo passo.

Abra no navegador:

- http://localhost:8080/ (aplicação web)
- http://localhost:8080/docs/events-tickets
- http://localhost:8080/docs/logs
- http://localhost:8080/grafana/
- http://localhost:8080/prometheus/targets
- http://localhost:8080/rabbitmq/ (`events_tickets` / `events_tickets_pass`)

### Alternativa: passos 4, 5 e 8 pela aplicação web

A aplicação web cobre as rotas, a comunicação entre os serviços e a falha do serviço de logs, com o caminho de cada chamada desenhado ao lado. Os blocos de `curl` abaixo continuam valendo como plano B.

| Passo | Na aplicação | O que dizer |
|---|---|---|
| Rotas | **+ Novo evento** com capacidade 5, depois **Inscrever** um participante | "A chamada entra pelo gateway, chega ao serviço principal e vira uma transação no banco. Um segundo depois, o registro chega ao serviço de logs pelo RabbitMQ, com o mesmo identificador." |
| Concorrência | **⚡ Concorrência** com 20 inscrições | "Vinte inscrições ao mesmo tempo para 4 vagas: exatamente 4 passaram, e as outras receberam 409. O UPDATE condicional não deixa vender além da capacidade." |
| Check-in e cancelamento | **Check-in** em um ingresso e **Cancelar** em outro | "A vaga voltou, e o evento está PUBLISHED de novo." |
| Comunicação síncrona | **Histórico** do evento | "A linha verde-azulada é o serviço principal consultando o de logs por HTTP REST, porque o usuário espera a resposta." |
| CRUD de logs | Aba **Registro de atividades**: mude a triagem, adicione notas e arquive | "O fato é imutável; só a triagem muda, e excluir é arquivar." |
| Falha | Botão **Experimentos de falha**, cenário 1 | "Com o serviço de logs fora, a venda segue: o rastro fica aguardando, a fila acumula, e só o histórico responde 503. Quando ele volta, a fila esvazia, e o rastro é concluído." |
| Rastreamento | Botão **grep** de uma operação, colado no terminal | "A mesma operação no gateway, no serviço principal e no serviço de logs." |

### 2. Swagger (1 min)

Mostre os dois Swaggers. No de eventos e ingressos, execute `GET /events` em "Try it out".

> "As duas APIs estão documentadas e são acessadas pelo gateway. Os dois serviços têm CRUD completo."

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

**Criar um evento com 2 vagas:**

```sh
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Workshop Docker","category":"WORKSHOP","modality":"ONLINE","location":"https://example.com/live","start_at":"2027-03-20T08:00:00-04:00","end_at":"2027-03-20T18:00:00-04:00","max_capacity":2}')
echo "$EVENT"
EVENT_ID=$(echo "$EVENT" | extract_id)
```

**Emitir 2 ingressos.** Cada emissão reserva a vaga e salva o ingresso na mesma transação.

```sh
TICKET_1=$(issue 'Ana Lima' 'ana@example.com' '2026000001')
echo "$TICKET_1"
TICKET_2=$(issue 'Bruno Reis' 'bruno@example.com' '2026000002')
echo "$TICKET_2"
TICKET_1_ID=$(echo "$TICKET_1" | extract_id)
TICKET_2_ID=$(echo "$TICKET_2" | extract_id)
show_event
```

> "As vagas chegaram a zero, e o evento mudou sozinho para SOLD_OUT."

**O terceiro ingresso é barrado:**

```sh
issue 'Carla Dias' 'carla@example.com' '2026000003'; echo
```

> "409, Event is sold out."

**Check-in do primeiro ingresso e cancelamento do segundo:**

```sh
curl -s -X PUT "$GATEWAY/tickets/$TICKET_1_ID" -H "$JSON" -d '{"status":"CHECKED_IN"}'; echo
curl -s -X DELETE "$GATEWAY/tickets/$TICKET_2_ID"; echo
show_event
```

> "A vaga voltou, e o evento está PUBLISHED de novo, com available_spots igual a 1."

### 5. Comunicação entre os serviços (2 min)

**Histórico, pela chamada síncrona:**

```sh
sleep 2
curl -s "$GATEWAY/tickets/$TICKET_1_ID/history"; echo
curl -s "$GATEWAY/events/$EVENT_ID/history"; echo
```

> "O serviço principal consultou o de logs por HTTP. Os registros chegaram lá pelo RabbitMQ: emissão, check-in e, no evento, cada vaga reservada e devolvida, com o status de cada momento."

**CRUD do serviço de logs:**

```sh
LOG=$(curl -s -X POST "$GATEWAY/logs" -H "$JSON" -d "{\"action\":\"incident.reported\",\"entity_type\":\"event\",\"entity_id\":\"$EVENT_ID\",\"level\":\"WARNING\",\"message\":\"Projetor do auditorio com defeito\"}")
echo "$LOG"
LOG_ID=$(echo "$LOG" | extract_id)
curl -s -X PUT "$GATEWAY/logs/$LOG_ID" -H "$JSON" -d '{"status":"RESOLVED","notes":"Projetor trocado"}'; echo
curl -s -X PUT "$GATEWAY/logs/$LOG_ID" -H "$JSON" -d '{"message":"reescrever o fato"}'; echo
curl -s -X DELETE "$GATEWAY/logs/$LOG_ID"; echo
```

> "Criei uma ocorrência manual, fiz a triagem e arquivei. O que aconteceu não pode ser reescrito, por isso o 422. E excluir é arquivar: o registro sai das listagens, mas o identificador da mensagem continua lá, para uma reentrega não recriá-lo."

Mostre a fila `logs.activity` na interface do RabbitMQ, em **Queues and Streams**, com um consumidor ativo.

### 6. Coleta de telemetria (2 min)

```sh
curl -s "$GATEWAY/metrics/events-tickets" | grep -E '^(tickets_(issued|cancelled)_total|events_spot_operations_total)'
curl -s "$GATEWAY/metrics/logs" | grep -E '^logs_(entries_created|messages_consumed)_total'
docker compose logs api-gateway events-tickets-service logs-service | grep demo-2026000001
```

> "Essa é uma única inscrição atravessando o gateway, o serviço principal, o RabbitMQ e o serviço de logs, com o mesmo identificador."

Mostre nesta ordem:

1. **Prometheus:** os dois alvos como `UP`.
2. **Grafana:** serviços no ar, ingressos, vagas, registros gravados, requisições, latência e mensagens.

Mostre o Grafana **antes** da persistência, porque os contadores zeram quando os serviços reiniciam.

### 7. Persistência (1,5 min)

```sh
docker compose down
docker compose ps -a
docker compose up -d --wait
show_event
curl -s "$GATEWAY/tickets/$TICKET_1_ID/history"; echo
```

> "Removi todos os contêineres, e nenhum ficou de pé. Ao subir de novo, o evento, os ingressos e o histórico continuam lá, porque os dados estão nos volumes."

A subida leva cerca de 30 s. Use esse tempo para explicar a diferença entre contêiner e volume.

### 8. Falha do serviço de logs (1,5 min)

```sh
docker compose stop logs-service
issue 'Daniel Melo' 'daniel@example.com' '2026000004'; echo
curl -s "$GATEWAY/tickets/$TICKET_1_ID/history"; echo
docker compose up -d --wait logs-service
sleep 3
curl -s "$GATEWAY/logs?action=ticket.issued&limit=1"; echo
```

> "Com o serviço de logs fora, a emissão funcionou normalmente, e só o histórico respondeu 503. Quando ele voltou, consumiu a mensagem que esperava na fila, e o registro apareceu."

### Se sobrar tempo: cancelamento de evento

```sh
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Festival Indie","category":"CONCERT","modality":"IN_PERSON","location":"Parque das Nacoes","start_at":"2027-04-10T18:00:00-04:00","end_at":"2027-04-10T23:00:00-04:00","max_capacity":10}')
EVENT_ID=$(echo "$EVENT" | extract_id)
issue 'Eva Nunes' 'eva@example.com' '2026000005'; echo
issue 'Fabio Ramos' 'fabio@example.com' '2026000006'; echo
curl -s -X PUT "$GATEWAY/events/$EVENT_ID" -H "$JSON" -d '{"status":"CANCELLED"}'; echo
curl -s "$GATEWAY/tickets?event_id=$EVENT_ID&status=CANCELLED"; echo
```

> "Cancelar o evento cancelou os dois ingressos na mesma transação: a resposta já veio com tudo atualizado."

### Se sobrar tempo: falha do RabbitMQ

```sh
docker compose stop rabbitmq
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Corrida de Rua","category":"SPORTS","modality":"IN_PERSON","location":"Parque Laguna","start_at":"2027-04-18T07:00:00-04:00","end_at":"2027-04-18T11:00:00-04:00","max_capacity":10}')
EVENT_ID=$(echo "$EVENT" | extract_id)
docker compose exec events-tickets-db psql -U events_tickets_user -d events_tickets_db -c 'select routing_key from outbox_messages where published_at is null;'
docker compose up -d --wait rabbitmq
sleep 10
curl -s "$GATEWAY/events/$EVENT_ID/history"; echo
```

> "Com o broker fora, o evento foi criado, e a mensagem ficou na outbox. Quando o broker voltou, ela foi publicada e gravada no serviço de logs."

## 25:00: Limitações e encerramento (2 min)

> "Por escopo, não implementei autenticação, e o foco foi a arquitetura distribuída. O histórico tem consistência eventual, com cerca de um segundo de atraso. Como evolução, eu colocaria autenticação, migrações de banco e múltiplas instâncias atrás do gateway."

> "O projeto atende aos itens do edital: dois serviços heterogêneos com CRUD completo, banco por serviço, tudo em contêineres, API Gateway, observabilidade com Prometheus e Grafana e mensageria. O código e o guia de execução estão no repositório público. Obrigado."

## Se algo der errado

| Problema | O que fazer |
|---|---|
| Build lento | Siga a teoria; ela cobre até 13 minutos. Se precisar, encurte a arquitetura |
| Sem internet | Use o celular como roteador; em último caso, mostre o vídeo gravado |
| Porta 8080 ocupada | No PowerShell, `netstat -ano \| findstr :8080`, e encerre o processo |
| Contêiner sem ficar `healthy` | `docker compose logs <nome>` e, se necessário, `docker compose up -d --wait` |
| Histórico vazio logo após a operação | Espere 1 a 2 s: o registro passa pela outbox e pelo RabbitMQ |
| Grafana sem dados | Confira o Prometheus e o intervalo "Last 15 minutes"; a coleta leva alguns segundos |
| Variáveis perdidas no terminal | Rode de novo os blocos "Preparar o terminal" e "Criar um evento" |
| `404` no `POST /tickets` pelo Swagger | Troque o `event_id` do exemplo pelo do evento criado |
| `409` de participante já inscrito | Use outro `participant_document` |
| Estourando o tempo | Pule os blocos opcionais e o passo 8; nunca pule rotas, persistência e telemetria |

## Perguntas prováveis

**Por que eventos e ingressos no mesmo serviço?**
Porque compartilham a regra das vagas. Separados, a emissão dependia de uma chamada HTTP e de compensação; um timeout deixava a vaga em estado desconhecido. Juntos, o banco resolve com uma transação.

**Então o serviço de logs não é só um serviço artificial para cumprir o edital?**
Não: ele responde uma pergunta de negócio, o que aconteceu com cada evento e ingresso, e permite a triagem das ocorrências. E tem características que justificam a separação: só acrescenta dados, tem outra retenção e não pode derrubar a venda.

**Por que CRUD em logs? Log não é imutável?**
O fato é imutável: ação, entidade, mensagem e data não mudam, e tentar responde 422. O que muda é a triagem: status e anotações. E excluir é arquivar, porque apagar de verdade deixaria uma mensagem repetida recriar o registro.

**O serviço de logs é a observabilidade do sistema?**
Não. Ele é auditoria de negócio. A observabilidade é o Prometheus coletando métricas dos dois serviços, o Grafana exibindo e os logs dos contêineres ligados pelo identificador de correlação.

**Por que dois bancos, e não um só?**
Para desacoplar a persistência: cada serviço evolui seu esquema e falha sem afetar o outro. O de logs nunca lê o banco de eventos; recebe tudo por mensagem.

**O que acontece se duas pessoas tentarem a última vaga?**
O `UPDATE` condicional só altera a linha se ainda houver vaga. Uma consegue, e a outra recebe `409`. Testei com 30 inscrições simultâneas para 5 vagas: exatamente 5 foram emitidas.

**E se alguém tentar se inscrever num evento que já acabou, ou que não existe?**
É recusado: evento inexistente responde `404`, e evento com o `end_at` no passado responde `400 Event has already ended`, sem consumir vaga. A regra também está no `UPDATE` da reserva, então nem uma corrida no último segundo passa.

**E se um contêiner cair sozinho?**
O Docker o reinicia (`restart: unless-stopped`). Enquanto isso, o resto continua: se for o `logs-service`, a venda segue e as atividades esperam na fila; se for o RabbitMQ, elas esperam na outbox.

**E se o serviço cair no meio da emissão?**
Como reserva, ingresso e mensagem estão na mesma transação, ou tudo foi gravado, ou nada foi. Não há vaga presa.

**Por que HTTP para o histórico e RabbitMQ para gravar?**
Gravar não pode atrasar nem bloquear a venda, então é assíncrono. Consultar o histórico é um pedido do usuário, que espera a resposta, então é síncrono.

**Por que não publicar direto no RabbitMQ?**
Se o broker estiver fora, ou o processo cair entre o commit e a publicação, a mensagem se perde. A outbox grava a mensagem na mesma transação.

**A mensagem pode ser processada duas vezes?**
Pode chegar duas vezes, porque a entrega é "ao menos uma vez". O serviço de logs guarda o identificador de cada mensagem com índice único e descarta a repetida.

**Isso é consistente?**
No serviço principal, sim, no momento da operação. O histórico é eventualmente consistente, normalmente em cerca de 1 s.

**Por que NGINX?**
É simples e suficiente para roteamento e entrada única. Traefik ou Kong seriam úteis com descoberta automática ou plugins de autenticação e limite de requisições.

**O gateway é um ponto único de falha?**
Neste ambiente, sim. Em produção, haveria mais de uma instância atrás de um balanceador.

**Como escalaria?**
Mais instâncias dos serviços atrás do gateway. A reserva continuaria correta, porque quem garante é o banco. A outbox já trava as mensagens com `SKIP LOCKED`, então dois publicadores não enviam a mesma linha ao mesmo tempo.

**Como rastrear uma requisição?**
Pelo `X-Correlation-Id`: o gateway o gera, os serviços o repassam, ele vai na mensagem do RabbitMQ e fica gravado no registro de logs, que pode ser filtrado por ele.

**Por que o Grafana abre sem login?**
Para simplificar a demonstração, em modo somente leitura. Em produção, teria autenticação e não ficaria exposto assim.

**A animação da aplicação web é real ou só ilustrativa?**
Ela acompanha chamadas reais, só que em câmera lenta. A parte síncrona é desenhada com a resposta HTTP de verdade, e a assíncrona só aparece quando o registro com o mesmo `X-Correlation-Id` chega ao serviço de logs. Os tempos no rastro são os reais, e a latência assíncrona vem das datas gravadas pelos próprios serviços. A saúde de cada contêiner é consultada a cada 2 s pelo gateway.

**Por que a aplicação web não tem contêiner próprio?**
São só arquivos estáticos, sem regra de negócio. O próprio gateway os serve, na mesma origem da API: não há CORS nem etapa de build, e a página entra pela porta 8080 como qualquer cliente.
