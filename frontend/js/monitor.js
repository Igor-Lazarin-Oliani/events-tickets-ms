// Saúde dos contêineres, fila do RabbitMQ e contadores do Prometheus, sempre consultados pelo gateway.
import * as api from './api.js';
import * as topo from './topology.js';
import { h } from './util.js';

export const health = {};
// total = prontas + entregues sem confirmação (ack), como a coluna "Total" da interface do RabbitMQ.
export const queue = { known: false, total: 0, ready: 0, unacked: 0, consumers: 0 };
export const metrics = { known: false, outboxPending: 0, up: {} };

const LABELS = {
  gateway: 'api-gateway',
  core: 'events-tickets-service',
  coredb: 'events-tickets-db',
  logs: 'logs-service',
  logsdb: 'logs-db',
  rabbitmq: 'rabbitmq',
  prometheus: 'prometheus',
  grafana: 'grafana',
};

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
  const result = await api.rabbitQueue('logs.activity');
  if (result.ok && result.data) {
    const q = result.data;
    Object.assign(queue, {
      known: true,
      total: q.messages ?? 0,
      ready: q.messages_ready ?? 0,
      unacked: q.messages_unacknowledged ?? 0,
      consumers: q.consumers ?? 0,
    });
    const consumers = queue.consumers === 1 ? '1 consumidor' : `${queue.consumers} consumidores`;
    update('rabbitmq', 'up', `${queue.total} na fila · ${consumers}`, queue.consumers === 0 ? 'warn' : undefined);
    topo.setBadge('rabbitmq', queue.total > 0 ? String(queue.total) : null);
    return;
  }
  queue.known = false;
  topo.setBadge('rabbitmq', null);
  if (result.status === 404 && result.reachedService) {
    update('rabbitmq', 'warn', 'fila ainda não criada', 'warn');
  } else {
    update('rabbitmq', 'down', 'fora do ar', 'error');
  }
}

const METRIC_NAMES = [
  'tickets_issued_total',
  'tickets_cancelled_total',
  'outbox_messages_published_total',
  'outbox_messages_pending',
  'logs_messages_consumed_total',
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
  for (const series of result.data.data.result) {
    const name = series.metric.__name__;
    const value = Number(series.value[1]);
    if (name === 'up') {
      up[series.metric.job] = value;
    } else {
      sums[name] = (sums[name] ?? 0) + value;
    }
  }
  Object.assign(metrics, {
    known: true,
    issued: sums.tickets_issued_total ?? 0,
    cancelled: sums.tickets_cancelled_total ?? 0,
    published: sums.outbox_messages_published_total ?? 0,
    outboxPending: sums.outbox_messages_pending ?? 0,
    consumed: sums.logs_messages_consumed_total ?? 0,
    entries: sums.logs_entries_created_total ?? 0,
    up,
  });
  const targets = Object.values(up);
  const upCount = targets.filter((v) => v === 1).length;
  update('prometheus', 'up', `alvos: ${upCount}/${targets.length} UP`, upCount < targets.length ? 'warn' : undefined);
  topo.setBadge('core', metrics.outboxPending > 0 ? `${metrics.outboxPending} na outbox` : null);
  topo.animateScrape(
    [['core', 'events-tickets-service'], ['logs', 'logs-service']]
      .filter(([, job]) => up[job] === 1)
      .map(([node]) => node),
  );
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
    ['gateway', 'core', isDown('gateway') || isDown('core')],
    ['gateway', 'logs', isDown('gateway') || isDown('logs')],
    ['core', 'coredb', isDown('core') || isDown('coredb')],
    ['logs', 'logsdb', isDown('logs') || isDown('logsdb')],
    ['core', 'rabbitmq', isDown('core') || isDown('rabbitmq')],
    ['rabbitmq', 'logs', isDown('rabbitmq') || isDown('logs') || (queue.known && queue.consumers === 0)],
    ['core', 'logs', isDown('core') || isDown('logs')],
    ['prometheus', 'core', isDown('prometheus') || metrics.up['events-tickets-service'] === 0],
    ['prometheus', 'logs', isDown('prometheus') || metrics.up['logs-service'] === 0],
    ['grafana', 'prometheus', isDown('grafana') || isDown('prometheus')],
  ];
  for (const [from, to, broken] of pairs) topo.setEdgeBroken(from, to, broken);
}

const KPIS = [
  { key: 'issued', label: 'Ingressos emitidos', source: 'prometheus', metric: 'tickets_issued_total' },
  { key: 'cancelled', label: 'Cancelados', source: 'prometheus', metric: 'tickets_cancelled_total' },
  { key: 'published', label: 'Msgs publicadas', source: 'prometheus', metric: 'outbox_messages_published_total' },
  { key: 'consumed', label: 'Msgs consumidas', source: 'prometheus', metric: 'logs_messages_consumed_total' },
  { key: 'entries', label: 'Registros gravados', source: 'prometheus', metric: 'logs_entries_created_total' },
  { key: 'total', label: 'Na fila agora', source: 'rabbitmq', metric: 'messages (prontas + sem ack) da fila logs.activity' },
];
const kpiEls = {};

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
  for (const kpi of KPIS) {
    const known = kpi.source === 'rabbitmq' ? queue.known : metrics.known;
    const raw = kpi.source === 'rabbitmq' ? queue[kpi.key] : metrics[kpi.key];
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
        checkService('core', 'coredb', '/health/events-tickets'),
        checkService('logs', 'logsdb', '/health/logs'),
      ]);
    }
    refreshEdges();
    renderKpis();
  });
  // Laço próprio: com um serviço fora do ar, a checagem de saúde espera o timeout, e a fila não
  // pode atrasar junto.
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
