# Roteiro da apresentação

Roteiro para a apresentação síncrona de até **30 minutos**, com data limite em **21/11**. A estrutura segue o edital: contextualização, arquitetura e demonstração a partir do repositório em máquina limpa, com rotas, persistência e coleta de telemetria. A explicação detalhada está em [guia-da-implementacao.md](guia-da-implementacao.md).

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

- [ ] Ensaiar o roteiro inteiro com cronômetro, pelo menos uma vez.
- [ ] Testar um "Try it out" no Swagger, o único passo que ainda não foi testado na tela.
- [ ] Perguntar ao professor se o Swagger basta como cliente da "aplicação web".
- [ ] Definir a máquina e testar a internet da sala. Se for ruim, levar o celular para roteador.
- [ ] Gravar um vídeo de uma execução bem-sucedida, como plano B.

### Deixar a máquina limpa

Faça isso antes da aula, com calma e com o Docker aberto. Os comandos apagam só o que é deste projeto, além do cache de build do Docker, que afeta também outros projetos, mas é refeito sozinho.

```powershell
# Na pasta de uma cópia anterior do projeto, se houver
docker compose down -v --rmi all

docker rmi python:3.11-slim node:20-alpine
docker builder prune -af
```

Se o `docker rmi` avisar que a imagem não existe, pode ignorar. Depois, apague qualquer cópia antiga do projeto na pasta que vai usar.

### Na hora

- [ ] Docker Desktop aberto e porta 8080 livre.
- [ ] Git Bash aberto em uma pasta vazia, com a fonte aumentada.
- [ ] Este roteiro aberto para copiar os comandos.
- [ ] Notificações desligadas.

## 00:00: Abertura e início do build (2 min)

> "Meu trabalho é o events-tickets-ms, uma plataforma distribuída de eventos e ingressos. Vou começar pela parte prática: vou clonar o repositório público e subir o ambiente do zero, nesta máquina limpa. Enquanto isso constrói, apresento o problema e a arquitetura."

```sh
docker ps -a
git clone https://github.com/Igor-Lazarin-Oliani/events-tickets-ms.git
cd events-tickets-ms
docker compose up --build -d
```

Aponte que o `docker ps -a` não mostra contêineres do projeto. Depois do comando de subida, passe para a explicação.

**Tempo de referência:** neste computador, o build sem cache e a subida levaram cerca de 2 minutos, sem contar o download das imagens base. Em máquina limpa, o download é somado e depende da internet.

## 02:00: Contextualização do problema (4 min)

Mostre o `README.md` no GitHub ou fale sem apoio.

> "O domínio é a gestão de eventos e a emissão de ingressos. É genérico: atende de um simpósio acadêmico a um show ou uma corrida. Inscrição e ingresso são a mesma coisa: ao se inscrever, a pessoa recebe um ingresso com código único e controle de presença."

> "O problema central é controlar vagas. Não posso vender mais ingressos do que a capacidade, mesmo com muitas pessoas tentando ao mesmo tempo, e o sistema precisa continuar consistente quando uma parte falha."

**Por que dois microsserviços:**

- **`events-service`** é o catálogo e a autoridade sobre as vagas. Muda pouco e não conhece os ingressos.
- **`tickets-service`** concentra as inscrições, os dados dos participantes e o check-in. Tem outro ritmo de uso e de mudança.

> "Cada um tem seu banco e pode evoluir, escalar e falhar de forma independente. Para evidenciar a heterogeneidade, um é em Python com FastAPI e o outro em TypeScript com NestJS."

## 06:00: Arquitetura (7 min)

Mostre o diagrama do `README.md`, seção **Arquitetura**, e percorra cada elemento, como o edital pede.

| Elemento | O que dizer |
|---|---|
| **Cliente** | "O cliente usa o Swagger ou qualquer ferramenta HTTP, sempre por uma única porta." |
| **API Gateway** | "O NGINX é a única porta aberta, a 8080. Ele esconde a topologia e usa uma lista de rotas permitidas. As rotas internas de reserva nem existem para quem vem de fora." |
| **Microsserviços** | "Dois serviços, em tecnologias diferentes, em camadas: rota, regra de negócio e acesso a dados." |
| **Bancos** | "Dois PostgreSQL separados, um por serviço. Como não há consulta entre bancos, o ingresso guarda uma cópia dos dados do evento." |
| **Comunicação síncrona** | "REST com JSON para validar o evento e reservar vagas, porque o usuário está esperando a resposta." |
| **Mensageria** | "RabbitMQ para o que não precisa de resposta imediata: ao cancelar um evento, os ingressos são cancelados de forma assíncrona." |
| **Observabilidade** | "O Prometheus coleta as métricas, o Grafana exibe e os logs são ligados por um identificador de correlação." |

**Três decisões para destacar (1 min cada):**

1. **Reserva atômica.**
   > "A reserva é um único UPDATE condicional. O banco garante que duas pessoas não fiquem com a mesma vaga."
2. **Compensação.**
   > "Não existe transação entre dois bancos. Se eu reservei a vaga e não consegui salvar o ingresso, o sistema devolve a vaga. É uma saga simples."
3. **Outbox.**
   > "Ao cancelar um evento, a mensagem é gravada na mesma transação. Se o RabbitMQ estiver fora, ela espera. Publicar diretamente poderia perder a mensagem. Como a entrega é ao menos uma vez, o consumidor é idempotente."

## 13:00: Demonstração (12 min)

Volte ao terminal. Copie um bloco de cada vez.

### 1. Ambiente no ar (1 min)

```sh
docker compose ps
```

> "São 8 contêineres saudáveis, e só o gateway publica porta no host."

Se ainda estiver subindo, repita o comando e aproveite para abrir as abas do próximo passo.

Abra no navegador:

- http://localhost:8080/docs/events
- http://localhost:8080/docs/tickets
- http://localhost:8080/grafana/
- http://localhost:8080/prometheus/targets
- http://localhost:8080/rabbitmq/ (`events_tickets` / `events_tickets_pass`)

### 2. Swagger (1 min)

Mostre os dois Swaggers. No de eventos, execute `GET /events` em "Try it out".

> "As duas APIs estão documentadas e são acessadas pelo gateway."

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
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Workshop Docker","category":"WORKSHOP","modality":"ONLINE","location":"https://example.com/live","start_at":"2026-11-20T08:00:00-04:00","end_at":"2026-11-20T18:00:00-04:00","max_capacity":2}')
echo "$EVENT"
EVENT_ID=$(echo "$EVENT" | extract_id)
```

**Emitir 2 ingressos.** O serviço de ingressos chama o de eventos para reservar cada vaga.

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

**Check-in do primeiro ingresso:**

```sh
curl -s -X PUT "$GATEWAY/tickets/$TICKET_1_ID" -H "$JSON" -d '{"status":"CHECKED_IN"}'; echo
```

**Cancelar o segundo ingresso:**

```sh
curl -s -X DELETE "$GATEWAY/tickets/$TICKET_2_ID"; echo
show_event
```

> "A vaga voltou, e o evento está PUBLISHED de novo, com available_spots igual a 1."

### 5. O gateway protege a rede interna (30 s)

```sh
curl -s -X PATCH "$GATEWAY/events/$EVENT_ID/reserve-spot"; echo
curl -s -m 2 http://localhost:8000/health || echo "porta 8000 fechada"
```

> "A rota de reserva não existe pelo gateway, e o serviço não está acessível diretamente."

### 6. Mensageria (2 min)

**Criar um evento com 2 ingressos e cancelá-lo:**

```sh
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Festival Indie","category":"CONCERT","modality":"IN_PERSON","location":"Parque das Nacoes","start_at":"2026-12-05T18:00:00-04:00","end_at":"2026-12-05T23:00:00-04:00","max_capacity":10}')
EVENT_ID=$(echo "$EVENT" | extract_id)
issue 'Eva Nunes' 'eva@example.com' '2026000005'; echo
issue 'Fabio Ramos' 'fabio@example.com' '2026000006'; echo
curl -s -X PUT "$GATEWAY/events/$EVENT_ID" -H "$JSON" -d '{"status":"CANCELLED"}'; echo
sleep 3
curl -s "$GATEWAY/tickets?event_id=$EVENT_ID&status=CANCELLED"; echo
docker compose logs events-service tickets-service | grep -E 'EVENT MESSAGE PUBLISHED|TICKETS CANCELLED BY EVENT'
```

> "O cancelamento respondeu na hora. Logo depois, a mensagem foi publicada, consumida, e os dois ingressos foram cancelados."

Mostre a fila `tickets.event-updates` na interface do RabbitMQ, em **Queues and Streams**, com um consumidor ativo.

### 7. Coleta de telemetria (2 min)

```sh
curl -s "$GATEWAY/metrics/tickets" | grep -E '^tickets_(issued|cancelled)_total'
curl -s "$GATEWAY/metrics/events" | grep '^events_spot_operations_total'
docker compose logs api-gateway events-service tickets-service | grep demo-2026000001
```

> "Essa é uma única inscrição atravessando o gateway e os dois serviços, com o mesmo identificador."

Mostre nesta ordem:

1. **Prometheus:** os dois alvos como `UP`.
2. **Grafana:** serviços no ar, ingressos, vagas, requisições, latência, erros e mensagens.

Mostre o Grafana **antes** da persistência, porque os contadores zeram quando os serviços reiniciam.

### 8. Persistência (1,5 min)

```sh
docker compose down
docker compose ps -a
docker compose up -d --wait
show_event
curl -s "$GATEWAY/tickets?event_id=$EVENT_ID"; echo
```

> "Removi todos os contêineres, e nenhum ficou de pé. Ao subir de novo, o evento e os ingressos continuam lá, porque os dados estão nos volumes."

A subida leva menos de 1 minuto. Use esse tempo para explicar a diferença entre contêiner e volume.

### Se sobrar tempo: falha do `events-service`

```sh
docker compose stop events-service
issue 'Daniel Melo' 'daniel@example.com' '2026000004'; echo
curl -s -X DELETE "$GATEWAY/tickets/$TICKET_1_ID"; echo
curl -s "$GATEWAY/tickets/$TICKET_1_ID"; echo
docker compose up -d --wait events-service
```

> "Sem o serviço de eventos, a emissão e o cancelamento respondem 503, e o ingresso continua CHECKED_IN. O sistema falha sem deixar dados inconsistentes."

### Se sobrar tempo: falha do RabbitMQ

```sh
EVENT=$(curl -s -X POST "$GATEWAY/events" -H "$JSON" -d '{"title":"Corrida de Rua","category":"SPORTS","modality":"IN_PERSON","location":"Parque Laguna","start_at":"2026-12-06T07:00:00-04:00","end_at":"2026-12-06T11:00:00-04:00","max_capacity":10}')
EVENT_ID=$(echo "$EVENT" | extract_id)
issue 'Gabi Souza' 'gabi@example.com' '2026000007'; echo
docker compose stop rabbitmq
curl -s -X PUT "$GATEWAY/events/$EVENT_ID" -H "$JSON" -d '{"status":"CANCELLED"}'; echo
sleep 3
curl -s "$GATEWAY/tickets?event_id=$EVENT_ID"; echo
docker compose up -d --wait rabbitmq
sleep 10
curl -s "$GATEWAY/tickets?event_id=$EVENT_ID"; echo
```

> "Com o broker fora, o evento foi cancelado e o ingresso continuou CONFIRMED, porque a mensagem ficou na outbox. Quando o broker voltou, ela foi entregue, e o ingresso foi cancelado."

## 25:00: Limitações e encerramento (2 min)

> "Por escopo, não implementei autenticação, e o foco foi a arquitetura distribuída. Também não há idempotência nas chamadas HTTP entre os serviços: em um timeout, uma vaga poderia ficar presa. Como evolução, eu colocaria autenticação, chaves de idempotência, paginação, migrações de banco e múltiplas instâncias atrás do gateway."

> "O projeto atende aos itens do edital: dois serviços heterogêneos com CRUD, banco por serviço, tudo em contêineres, API Gateway, observabilidade e mensageria. O código e o guia de execução estão no repositório público. Obrigado."

## Se algo der errado

| Problema | O que fazer |
|---|---|
| Build lento | Siga a teoria; ela cobre até 13 minutos. Se precisar, encurte a arquitetura |
| Sem internet | Use o celular como roteador; em último caso, mostre o vídeo gravado |
| Porta 8080 ocupada | No PowerShell, `netstat -ano \| findstr :8080`, e encerre o processo |
| Contêiner sem ficar `healthy` | `docker compose logs <nome>` e, se necessário, `docker compose up -d --wait` |
| Grafana sem dados | Confira o Prometheus e o intervalo "Last 15 minutes"; a coleta leva alguns segundos |
| Variáveis perdidas no terminal | Rode de novo os blocos "Preparar o terminal" e "Criar um evento" |
| `404` no `POST /tickets` pelo Swagger | Troque o `event_id` do exemplo pelo do evento criado |
| `409` de participante já inscrito | Use outro `participant_document` |
| Estourando o tempo | Pule os blocos opcionais e o passo 5; nunca pule rotas, persistência e telemetria |

## Perguntas prováveis

**Por que dois bancos, e não um só?**
Para desacoplar a persistência: cada serviço evolui seu esquema e falha sem afetar o outro. O custo é não ter `JOIN` nem transação única, e por isso uso o snapshot e a compensação.

**O que acontece se duas pessoas tentarem a última vaga?**
O `UPDATE` condicional só altera a linha se ainda houver vaga. Uma consegue, e a outra recebe `409`.

**E se o serviço cair depois de reservar a vaga?**
Se salvar o ingresso falhar, a vaga é devolvida. Se o próprio processo morrer entre a reserva e o salvamento, a compensação não roda, e a vaga fica presa. Uma evolução seria registrar a reserva antes, para concluir ou desfazer depois.

**Por que HTTP em um fluxo e RabbitMQ em outro?**
Reservar vaga exige resposta imediata. Cancelar os ingressos de um evento pode envolver muitos registros, e quem cancelou não precisa esperar.

**Por que não publicar direto no RabbitMQ?**
Se o broker estiver fora, ou o processo cair entre o commit e a publicação, a mensagem se perde. A outbox grava a mensagem na mesma transação.

**A mensagem pode ser processada duas vezes?**
Sim, a entrega é "ao menos uma vez". O consumidor só cancela o que ainda está ativo, então repetir não muda o resultado.

**Isso é consistente?**
Na reserva de vagas, sim, no momento da operação. No cancelamento em massa, a consistência é eventual, normalmente em cerca de 1 s.

**Por que NGINX?**
É simples e suficiente para roteamento e entrada única. Traefik ou Kong seriam úteis com descoberta automática ou plugins de autenticação e limite de requisições.

**O gateway é um ponto único de falha?**
Neste ambiente, sim. Em produção, haveria mais de uma instância atrás de um balanceador.

**Como escalaria?**
Mais instâncias dos serviços atrás do gateway. A reserva continuaria correta, porque quem garante é o banco. Os contadores do Prometheus seriam somados entre as instâncias.

**Como rastrear uma requisição?**
Pelo `X-Correlation-Id`: o gateway o gera, os serviços o repassam, e ele também vai na mensagem do RabbitMQ.

**Por que o Grafana abre sem login?**
Para simplificar a demonstração, em modo somente leitura. Em produção, teria autenticação e não ficaria exposto assim.
