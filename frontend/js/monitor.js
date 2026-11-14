// Saúde dos contêineres, filas do RabbitMQ e contadores do Prometheus, sempre consultados pelo gateway.
import * as api from './api.js';
import * as topo from './topology.js';
import { h } from './util.js';

export const health = {};
// Fila logs.activity. total = prontas + entregues sem confirmação (ack), como a coluna "Total"
// da interface do RabbitMQ.
export const queue = { known: false, total: 0, ready: 0, unacked: 0, consumers: 0 };
// As três filas, pelo nome: { known, total, consumers }.
export const queues = {};
export const metrics = { known: false, outboxPending: 0, pendingByJob: {}, up: {} };

export const QUEUES = ['logs.activity', 'tickets.event-updates', 'events.spot-releases'];

const LABELS = {
  gateway: 'api-gateway',
  events: 'events-service',
  eventsdb: 'events-db',
  tickets: 'tickets-service',
  ticketsdb: 'tickets-db',
  logs: 'logs-service',
  logsdb: 'logs-db',
  rabbitmq: 'rabbitmq',
  prometheus: 'prometheus',
  grafana: 'grafana',
};

// Nó do diagrama de cada job do Prometheus.
const JOB_NODES = [['events', 'events-service'], ['tickets', 'tickets-service'], ['logs', 'logs-service']];

const listeners = new Set();

/** fn(id, rótulo, estado anterior, estado novo) a cada mudança de estado de um contêiner. */
export function onHealthChange(fn) {
  listeners.add(fn);
}

function update(id, state, detail, tone) {
  const previous = health[id];
  health[id] = state;
  topo.setNode(id, state, detail, tone);
  if (previous && previous !== state) {
    for (const fn of listeners) fn(id, LABELS[id], previous, state);
  }
}

const isDown = (id) => health[id] === 'down';
const noConsumer = (name) => queues[name]?.known && queues[name].consumers === 0;

async function checkService(id, dbId, path) {
  const result = await api.request('GET', path, { timeoutMs: 3000 });
  if (result.ok) {
    update(id, 'up', 'no ar');
    update(dbId, 'up', 'respondendo');
  } else if (result.reachedService && result.data?.database === 'down') {
    update(id, 'warn', 'sem acesso ao banco', 'warn');
    update(dbId, 'down', 'fora do ar', 'error');
  } else {
    update(id, 'down', 'fora do ar', 'error');
    update(dbId, 'unknown', 'sem informação');
  }
}

async function checkRabbit() {
  const results = await Promise.all(QUEUES.map((name) => api.rabbitQueue(name)));
  let reached = false;
  let missing = 0;
  results.forEach((result, i) => {
    const name = QUEUES[i];
    if (result.ok && result.data) {
      reached = true;
      const q = result.data;
      queues[name] = { known: true, total: q.messages ?? 0, consumers: q.consumers ?? 0 };
      if (name === 'logs.activity') {
        Object.assign(queue, {
          known: true,
          total: q.messages ?? 0,
          ready: q.messages_ready ?? 0,
          unacked: q.messages_unacknowledged ?? 0,
          consumers: q.consumers ?? 0,
        });
      }
    } else {
      queues[name] = { known: false, total: 0, consumers: 0 };
      if (result.status === 404 && result.reachedService) {
        reached = true;
        missing += 1;
      }
    }
  });
  if (!queues['logs.activity'].known) queue.known = false;

  if (!reached) {
    topo.setBadge('rabbitmq', null);
    update('rabbitmq', 'down', 'fora do ar', 'error');
    return;
  }
  const total = QUEUES.reduce((sum, name) => sum + queues[name].total, 0);
  const consuming = QUEUES.filter((name) => queues[name].consumers > 0).length;
  topo.setBadge('rabbitmq', total > 0 ? String(total) : null);
  if (missing > 0) {
    update('rabbitmq', 'warn', `${missing} fila(s) ainda não criada(s)`, 'warn');
  } else {
    update('rabbitmq', 'up', `${total} na fila · ${consuming}/3 consumindo`, consuming < 3 ? 'warn' : undefined);
  }
}

const METRIC_NAMES = [
  'tickets_issued_total',
  'tickets_cancelled_total',
  'outbox_messages_published_total',
  'outbox_messages_pending',
  'logs_messages_consumed_total',
  'integration_messages_consumed_total',
  'logs_entries_created_total',
  'up',
];

async function checkPrometheus() {
  const result = await api.prometheusQuery(`{__name__=~"${METRIC_NAMES.join('|')}"}`);
  if (!result.ok || result.data?.status !== 'success') {
    metrics.known = false;
    update('prometheus', 'down', 'fora do ar', 'error');
    return;
  }
  const sums = {};
  const up = {};
  const pendingByJob = {};
  for (const series of result.data.data.result) {
    const name = series.metric.__name__;
    const value = Number(series.value[1]);
    if (name === 'up') {
      up[series.metric.job] = value;
    } else {
      sums[name] = (sums[name] ?? 0) + value;
      if (name === 'outbox_messages_pending') pendingByJob[series.metric.job] = value;
    }
  }
  Object.assign(metrics, {
    known: true,
    issued: sums.tickets_issued_total ?? 0,
    cancelled: sums.tickets_cancelled_total ?? 0,
    published: sums.outbox_messages_published_total ?? 0,
    outboxPending: sums.outbox_messages_pending ?? 0,
    pendingByJob,
    consumed: (sums.logs_messages_consumed_total ?? 0) + (sums.integration_messages_consumed_total ?? 0),
    entries: sums.logs_entries_created_total ?? 0,
    up,
  });
  const targets = Object.values(up);
  const upCount = targets.filter((v) => v === 1).length;
  update('prometheus', 'up', `alvos: ${upCount}/${targets.length} UP`, upCount < targets.length ? 'warn' : undefined);
  for (const [node, job] of JOB_NODES.slice(0, 2)) {
    const pending = pendingByJob[job] ?? 0;
    topo.setBadge(node, pending > 0 ? `${pending} na outbox` : null);
  }
  topo.animateScrape(JOB_NODES.filter(([, job]) => up[job] === 1).map(([node]) => node));
}

async function checkGrafana() {
  const result = await api.request('GET', '/grafana/api/health', { timeoutMs: 3000 });
  update('grafana', result.ok ? 'up' : 'down', result.ok ? 'painel provisionado' : 'fora do ar', result.ok ? undefined : 'error');
}

function markAllUnknown() {
  for (const id of Object.keys(LABELS)) {
    if (id !== 'gateway') update(id, 'unknown', 'sem acesso pelo gateway');
  }
  queue.known = false;
  for (const name of QUEUES) queues[name] = { known: false, total: 0, consumers: 0 };
  metrics.known = false;
}

async function gatewayUp() {
  const result = await api.request('GET', '/gateway/health', { timeoutMs: 3000 });
  if (result.ok) {
    update('gateway', 'up', 'porta 8080');
    return true;
  }
  update('gateway', 'down', 'fora do ar', 'error');
  markAllUnknown();
  return false;
}

function refreshEdges() {
  const pairs = [
    ['browser', 'gateway', isDown('gateway')],
    ['gateway', 'events', isDown('gateway') || isDown('events')],
    ['gateway', 'tickets', isDown('gateway') || isDown('tickets')],
    ['gateway', 'logs', isDown('gateway') || isDown('logs')],
    ['events', 'eventsdb', isDown('events') || isDown('eventsdb')],
    ['tickets', 'ticketsdb', isDown('tickets') || isDown('ticketsdb')],
    ['logs', 'logsdb', isDown('logs') || isDown('logsdb')],
    ['tickets', 'events', isDown('tickets') || isDown('events')],
    ['tickets', 'logs', isDown('tickets') || isDown('logs')],
    ['events', 'logs', isDown('events') || isDown('logs')],
    ['events', 'rabbitmq', isDown('events') || isDown('rabbitmq') || noConsumer('events.spot-releases')],
    ['tickets', 'rabbitmq', isDown('tickets') || isDown('rabbitmq') || noConsumer('tickets.event-updates')],
    ['rabbitmq', 'logs', isDown('rabbitmq') || isDown('logs') || noConsumer('logs.activity')],
    ['prometheus', 'events', isDown('prometheus') || metrics.up['events-service'] === 0],
    ['prometheus', 'tickets', isDown('prometheus') || metrics.up['tickets-service'] === 0],
    ['prometheus', 'logs', isDown('prometheus') || metrics.up['logs-service'] === 0],
    ['grafana', 'prometheus', isDown('grafana') || isDown('prometheus')],
  ];
  for (const [from, to, broken] of pairs) topo.setEdgeBroken(from, to, broken);
}

const KPIS = [
  { key: 'issued', label: 'Ingressos emitidos', source: 'prometheus', metric: 'tickets_issued_total' },
  { key: 'cancelled', label: 'Cancelados', source: 'prometheus', metric: 'tickets_cancelled_total' },
  { key: 'published', label: 'Msgs publicadas', source: 'prometheus', metric: 'outbox_messages_published_total (events-service e tickets-service)' },
  { key: 'consumed', label: 'Msgs consumidas', source: 'prometheus', metric: 'logs_messages_consumed_total + integration_messages_consumed_total' },
  { key: 'entries', label: 'Registros gravados', source: 'prometheus', metric: 'logs_entries_created_total' },
  { key: 'total', label: 'Nas filas agora', source: 'rabbitmq', metric: 'mensagens (prontas + sem ack) das filas logs.activity, tickets.event-updates e events.spot-releases' },
];
const kpiEls = {};

function rabbitTotal() {
  return QUEUES.reduce((sum, name) => sum + (queues[name]?.total ?? 0), 0);
}

function renderKpis() {
  const box = document.getElementById('kpis');
  if (!box.childElementCount) {
    for (const kpi of KPIS) {
      const value = h('strong', {}, '–');
      kpiEls[kpi.key] = value;
      const source = kpi.source === 'rabbitmq' ? 'API do RabbitMQ' : 'Prometheus';
      box.append(h('div', { class: 'kpi', title: `${source}: ${kpi.metric}` },
        h('span', {}, kpi.label), value));
    }
  }
  const rabbitKnown = QUEUES.some((name) => queues[name]?.known);
  for (const kpi of KPIS) {
    const known = kpi.source === 'rabbitmq' ? rabbitKnown : metrics.known;
    const raw = kpi.source === 'rabbitmq' ? rabbitTotal() : metrics[kpi.key];
    const text = known ? String(Math.round(raw)) : '–';
    const el = kpiEls[kpi.key];
    if (el.textContent !== text) {
      if (el.textContent !== '–' && known) {
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      }
      el.textContent = text;
    }
  }
}

function every(ms, task) {
  const run = async () => {
    try {
      await task();
    } finally {
      setTimeout(run, ms);
    }
  };
  void run();
}

export function start() {
  topo.setNode('browser', 'up', 'esta página');
  every(2000, async () => {
    if (await gatewayUp()) {
      await Promise.all([
        checkService('events', 'eventsdb', '/health/events'),
        checkService('tickets', 'ticketsdb', '/health/tickets'),
        checkService('logs', 'logsdb', '/health/logs'),
      ]);
    }
    refreshEdges();
    renderKpis();
  });
  // Laço próprio: com um serviço fora do ar, a checagem de saúde espera o timeout, e as filas não
  // podem atrasar junto.
  every(1500, async () => {
    if (health.gateway !== 'up') return;
    await checkRabbit();
    refreshEdges();
    renderKpis();
  });
  every(4000, async () => {
    if (health.gateway !== 'up') return;
    await Promise.all([checkPrometheus(), checkGrafana()]);
    refreshEdges();
    renderKpis();
  });
}
