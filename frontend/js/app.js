// Aplicação: eventos, ingressos e registro de atividades. Não há regra de negócio aqui; a página
// só chama a API pelo gateway e mostra o que cada componente respondeu.
import * as api from './api.js';
import * as monitor from './monitor.js';
import * as topo from './topology.js';
import * as traces from './traces.js';
import {
  copyText, fmtClock, fmtDateTime, fmtMs, fmtRange, fromLocalInput, h, newCorrelationId,
  samplePerson, shortId, sleep, toLocalInput, toast,
} from './util.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  tab: 'events',
  events: [],
  eventsTotal: null,
  eventsError: null,
  selectedEventId: null,
  tickets: [],
  ticketsTotal: null,
  ticketsLoading: false,
  ticketsError: null,
  logs: [],
  logsTotal: null,
  logsError: null,
  logCorrelation: null,
};

// As listagens são paginadas pela API; a página mostra a primeira página e avisa se houver mais.
const PAGE_LIMIT = 100;

/** Aviso de lista cortada, a partir do total informado no cabeçalho X-Total-Count. */
function moreNote(shown, total, what) {
  if (total === null || total <= shown) return null;
  return h('div', { class: 'empty small' }, `Mostrando ${shown} de ${total} ${what}, dos mais recentes aos mais antigos.`);
}

const CATEGORIES = ['ACADEMIC', 'WORKSHOP', 'CONCERT', 'SPORTS', 'ESPORTS', 'GENERAL'];
const TIERS = ['STANDARD', 'ESTUDANTE', 'VIP', 'OUVINTE', 'LOTE_1'];
const MODALITIES = [
  { value: 'IN_PERSON', label: 'Presencial' },
  { value: 'ONLINE', label: 'Online' },
  { value: 'HYBRID', label: 'Híbrido' },
];
const MODALITY_LABEL = Object.fromEntries(MODALITIES.map((m) => [m.value, m.label]));
const SERVICE_OF = {
  events: 'events-service',
  tickets: 'tickets-service',
  issue: 'tickets-service',
  logs: 'logs-service',
  eventHistory: 'events-service',
  ticketHistory: 'tickets-service',
};
const DB_OF = { events: 'events-db', tickets: 'tickets-db', issue: 'tickets-db', logs: 'logs-db' };

// ---------------------------------------------------------------------------------------------
// Operações rastreadas
// ---------------------------------------------------------------------------------------------

/** A recusa veio do events-service, na reserva da vaga (as mensagens dele começam por "Event"). */
const refusedByEvents = (result) => /^Event /.test(api.errorMessage(result));

/** Passo da reserva de vaga, a chamada HTTP do tickets-service ao events-service (emissão). */
function reservationStep(trace, result, at) {
  const label = 'tickets-service → events-service (HTTP REST síncrono)';
  const message = api.errorMessage(result);
  if (result.ok) {
    trace.step('rest', {
      label,
      detail: 'PATCH /events/{id}/reserve-spot com o id do ingresso: vaga reservada pelo UPDATE condicional no events-db',
      state: 'ok',
      at,
    });
  } else if (result.status === 503 && message === 'Events service unavailable') {
    trace.step('rest', {
      label,
      detail: 'sem resposta do events-service: nenhum ingresso foi emitido, e a devolução de uma eventual reserva foi gravada na outbox (compensação)',
      state: 'error',
      at,
    });
  } else if (refusedByEvents(result)) {
    trace.step('rest', { label, detail: `o events-service recusou a reserva: ${message}`, state: 'warn', at });
  }
}

/**
 * Escrita com rastro: a chamada HTTP, a transação no banco e, quando houver atividades, a
 * entrega assíncrona até o logs-service. async: { label, origins, waitsFor } do watchAsync.
 * Devolve o resultado da chamada.
 */
async function traced({ title, subtitle, method, path, body, route = 'events', activities = 0, tx, async: asyncOptions }) {
  const correlationId = newCorrelationId();
  const trace = traces.create({ title, subtitle, correlationId });
  const service = SERVICE_OF[route];
  const httpLabel = `Navegador → api-gateway → ${service}`;
  trace.step('http', { label: httpLabel, detail: `${method} ${path}`, state: 'pending' });

  // A animação segue sozinha; o rastro registra os tempos reais assim que a resposta chega.
  const promise = api.request(method, path, { body, correlationId });
  trace.animation = topo.animateCall(route, promise);
  const result = await promise;
  const at = result.ms;

  const line = `${method} ${path} → ${api.statusLine(result)} em ${fmtMs(result.ms)}`;
  if (result.networkError) {
    trace.step('http', { detail: `${method} ${path}: o api-gateway não respondeu`, state: 'error', at });
    trace.finish('error');
    return result;
  }
  if (!result.reachedService) {
    trace.step('http', { detail: `${line}: o api-gateway não alcançou o ${service}`, state: 'error', at });
    trace.finish('error');
    return result;
  }

  const httpState = result.ok ? 'ok' : result.status < 500 ? 'warn' : 'error';
  trace.step('http', { detail: result.ok ? line : `${line} · ${api.errorMessage(result)}`, state: httpState, at });

  const dbLabel = `${service} → ${DB_OF[route]}`;
  if (route === 'issue') reservationStep(trace, result, at);
  if (route === 'issue' && !result.ok && (refusedByEvents(result) || result.status === 503)) {
    trace.step('db', { label: dbLabel, detail: 'nada foi gravado: sem vaga reservada, não há ingresso', state: 'warn', at });
  } else if (result.ok) {
    trace.step('db', { label: dbLabel, detail: tx, state: 'ok', at });
  } else if (result.status === 400 || result.status === 422) {
    trace.step('db', {
      label: `${service} (validação)`,
      detail: 'dados rejeitados antes de chegar ao banco; nada foi gravado',
      state: 'warn',
      at,
    });
  } else if (result.status === 409) {
    trace.step('db', {
      label: dbLabel,
      detail: 'a regra barrou a operação: a transação foi desfeita, e nenhuma mensagem entrou na outbox',
      state: 'warn',
      at,
    });
  } else if (result.status === 404) {
    trace.step('db', { label: dbLabel, detail: 'registro não encontrado no banco', state: 'warn', at });
  }

  if (result.ok && activities !== 0) {
    traces.watchAsync(trace, activities, asyncOptions);
  } else {
    trace.finish(httpState);
  }
  return result;
}

/** Leitura sem rastro, só com a animação discreta (cinza). */
function read(path, { animate = true, route = 'events' } = {}) {
  const promise = api.request('GET', path);
  if (animate) void topo.animateCall(route, promise, { light: true });
  return promise;
}

async function afterWrite() {
  await loadEvents({ animate: false });
  if (state.selectedEventId) await loadTickets({ animate: false });
}

// ---------------------------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------------------------

async function loadEvents({ animate = true } = {}) {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  const status = $('#filter-event-status').value;
  if (status) params.set('status', status);
  const result = await read(`/events?${params}`, { animate });
  if (result.ok) {
    state.events = result.data;
    state.eventsTotal = result.total;
    state.eventsError = null;
    if (state.selectedEventId && !state.events.some((ev) => ev.id === state.selectedEventId)) {
      state.selectedEventId = null;
    }
  } else {
    state.eventsError = api.errorMessage(result);
  }
  renderEvents();
}

function renderEvents() {
  const list = $('#event-list');
  if (state.eventsError) {
    list.replaceChildren(errorBox(`Não foi possível listar os eventos: ${state.eventsError}`, () => loadEvents()));
    return;
  }
  if (!state.events.length) {
    list.replaceChildren(h('div', { class: 'empty' }, 'Nenhum evento. Crie o primeiro em “+ Novo evento”.'));
    return;
  }
  const more = moreNote(state.events.length, state.eventsTotal, 'eventos');
  list.replaceChildren(...state.events.map(eventCard), ...(more ? [more] : []));
}

function eventCard(ev) {
  const used = ev.max_capacity - ev.available_spots;
  const pct = Math.round((used / ev.max_capacity) * 100);
  const selected = ev.id === state.selectedEventId;
  const cancelled = ev.status === 'CANCELLED';
  const action = (label, fn, cls = '') =>
    h('button', {
      class: `btn small ${cls}`,
      onclick: (e) => {
        e.stopPropagation();
        fn(ev);
      },
    }, label);

  return h('article', {
    class: `event-card${selected ? ' selected' : ''}`,
    onclick: () => selectEvent(ev.id),
  },
    h('div', { class: 'event-head' },
      h('h3', {}, ev.title),
      badge(ev.status)),
    h('div', { class: 'event-meta' },
      `${ev.category} · ${MODALITY_LABEL[ev.modality] ?? ev.modality} · ${fmtRange(ev.start_at, ev.end_at)} · ${ev.location}`),
    h('div', { class: 'spots' },
      h('div', { class: `spots-bar${ev.available_spots === 0 ? ' full' : ''}` }, h('span', { style: `width:${pct}%` })),
      h('span', { class: 'spots-text' }, `${used}/${ev.max_capacity} vagas ocupadas · ${ev.available_spots} livre(s)`)),
    h('div', { class: 'actions' },
      action('Inscrever', openIssueTicket, 'primary'),
      action('⚡ Concorrência', openRush),
      action('Histórico', (e) => showHistory('event', e.id, e.title)),
      action('Editar', openEditEvent),
      cancelled ? null : action('Cancelar evento', cancelEvent, 'danger-ghost'),
      action('Remover', deleteEvent, 'danger-ghost')),
    selected ? ticketsSection(ev) : null);
}

async function selectEvent(id) {
  if (state.selectedEventId === id) {
    state.selectedEventId = null;
    renderEvents();
    return;
  }
  focusEvent(id);
  renderEvents();
  await loadTickets();
}

/** Abre o evento na lista. Devolve true se a seleção mudou e os ingressos precisam ser carregados. */
function focusEvent(id) {
  if (state.selectedEventId === id) return false;
  state.selectedEventId = id;
  state.tickets = [];
  state.ticketsError = null;
  state.ticketsLoading = true;
  return true;
}

function openEvent(id) {
  if (focusEvent(id)) {
    renderEvents();
    void loadTickets({ animate: false });
  }
}

function defaultEvent() {
  const start = new Date();
  start.setDate(start.getDate() + 7);
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setHours(18);
  return {
    title: 'Workshop Docker',
    category: 'WORKSHOP',
    modality: 'ONLINE',
    location: 'https://example.com/live',
    start_at: toLocalInput(start),
    end_at: toLocalInput(end),
    max_capacity: 2,
    description: '',
  };
}

function eventFields(values) {
  return [
    { name: 'title', label: 'Título', required: true, value: values.title, wide: true },
    { name: 'category', label: 'Categoria', required: true, value: values.category, list: CATEGORIES },
    { name: 'modality', label: 'Modalidade', type: 'select', options: MODALITIES, value: values.modality },
    { name: 'location', label: 'Local ou link', required: true, value: values.location, wide: true },
    { name: 'start_at', label: 'Início', type: 'datetime-local', required: true, value: values.start_at },
    { name: 'end_at', label: 'Fim', type: 'datetime-local', required: true, value: values.end_at },
    {
      name: 'max_capacity', label: 'Capacidade', type: 'number', min: 1, required: true,
      value: values.max_capacity, hint: 'Poucas vagas deixam o evento esgotar logo na demonstração.',
    },
    { name: 'description', label: 'Descrição (opcional)', type: 'textarea', value: values.description ?? '', wide: true },
  ];
}

function openNewEvent() {
  openForm({
    title: 'Novo evento',
    description: 'POST /events: o evento nasce PUBLISHED, com todas as vagas livres.',
    fields: eventFields(defaultEvent()),
    submitLabel: 'Criar evento',
    onSubmit: async (v) => {
      const body = {
        title: v.title,
        category: v.category,
        modality: v.modality,
        location: v.location,
        start_at: fromLocalInput(v.start_at),
        end_at: fromLocalInput(v.end_at),
        max_capacity: v.max_capacity,
        ...(v.description ? { description: v.description } : {}),
      };
      const result = await traced({
        title: 'Criar evento',
        subtitle: v.title,
        method: 'POST',
        path: '/events',
        body,
        activities: 1,
        tx: 'uma transação no events-db: grava o evento e a mensagem event.created na outbox',
        async: { origins: ['events'] },
      });
      if (!result.ok) return api.errorMessage(result);
      focusEvent(result.data.id);
      await afterWrite();
      return null;
    },
  });
}

function openEditEvent(ev) {
  openForm({
    title: 'Editar evento',
    description: 'PUT /events/{id}: só os campos alterados são enviados. As vagas ocupadas são preservadas.',
    fields: eventFields({
      ...ev,
      start_at: toLocalInput(ev.start_at),
      end_at: toLocalInput(ev.end_at),
    }),
    submitLabel: 'Salvar',
    onSubmit: async (v) => {
      const changes = {};
      for (const key of ['title', 'category', 'modality', 'location', 'max_capacity']) {
        if (v[key] !== ev[key]) changes[key] = v[key];
      }
      for (const key of ['start_at', 'end_at']) {
        const iso = fromLocalInput(v[key]);
        if (Date.parse(iso) !== Date.parse(ev[key])) changes[key] = iso;
      }
      if ((v.description || null) !== (ev.description || null)) changes.description = v.description || null;
      if (!Object.keys(changes).length) return 'Nenhum campo foi alterado.';

      const result = await traced({
        title: 'Editar evento',
        subtitle: `${ev.title}: ${Object.keys(changes).join(', ')}`,
        method: 'PUT',
        path: `/events/${ev.id}`,
        body: changes,
        activities: 1,
        tx: 'uma transação no events-db, com o evento bloqueado (FOR UPDATE): aplica a mudança e grava event.updated na outbox',
        async: { origins: ['events'] },
      });
      if (!result.ok) return api.errorMessage(result);
      await afterWrite();
      return null;
    },
  });
}

/** Ingressos ativos do evento, pelo X-Total-Count: não depende de todos caberem em uma página. */
async function activeTicketCount(eventId) {
  const totals = await Promise.all(['CONFIRMED', 'CHECKED_IN'].map(async (status) => {
    const result = await api.request('GET', `/tickets?event_id=${eventId}&status=${status}&limit=1`);
    return result.ok ? result.total : null;
  }));
  return totals.some((total) => total === null) ? null : totals[0] + totals[1];
}

async function cancelEvent(ev) {
  const ok = await confirmAction({
    title: 'Cancelar evento',
    message: `“${ev.title}” será cancelado. O tickets-service recebe o aviso pelo RabbitMQ e cancela os ingressos ativos em cerca de 1 s. Um evento cancelado não pode ser reaberto.`,
    confirmLabel: 'Cancelar evento',
  });
  if (!ok) return;
  const active = await activeTicketCount(ev.id);
  const result = await traced({
    title: 'Cancelar evento',
    subtitle: ev.title,
    method: 'PUT',
    path: `/events/${ev.id}`,
    body: { status: 'CANCELLED' },
    activities: active === null ? null : 1 + active,
    tx: 'uma transação no events-db, com o evento bloqueado: cancela o evento e grava event.cancelled e o aviso ao tickets-service na outbox',
    async: {
      label: `outbox → rabbitmq → tickets-service (cancela ${active ?? 'os'} ingresso(s)) e logs-service`,
      origins: ['events'],
      waitsFor: 'tickets',
    },
  });
  if (!result.ok) toast(api.errorMessage(result), 'error');
  await afterWrite();
}

async function deleteEvent(ev) {
  const ok = await confirmAction({
    title: 'Remover evento',
    message: `“${ev.title}” será removido, e o tickets-service cancela os ingressos ativos ao receber o aviso pelo RabbitMQ. Os ingressos guardam uma cópia do evento (event_snapshot), e o histórico continua no logs-service.`,
    confirmLabel: 'Remover',
  });
  if (!ok) return;
  const active = await activeTicketCount(ev.id);
  const result = await traced({
    title: 'Remover evento',
    subtitle: ev.title,
    method: 'DELETE',
    path: `/events/${ev.id}`,
    activities: active === null ? null : 1 + active,
    tx: 'uma transação no events-db: remove o evento e grava event.deleted e o aviso ao tickets-service na outbox',
    async: {
      label: `outbox → rabbitmq → tickets-service (cancela ${active ?? 'os'} ingresso(s)) e logs-service`,
      origins: ['events'],
      waitsFor: 'tickets',
    },
  });
  if (!result.ok) toast(api.errorMessage(result), 'error');
  if (result.ok && state.selectedEventId === ev.id) state.selectedEventId = null;
  await afterWrite();
}

// ---------------------------------------------------------------------------------------------
// Ingressos
// ---------------------------------------------------------------------------------------------

async function loadTickets({ animate = true } = {}) {
  const eventId = state.selectedEventId;
  if (!eventId) return;
  const result = await read(`/tickets?event_id=${eventId}&limit=${PAGE_LIMIT}`, { animate, route: 'tickets' });
  if (eventId !== state.selectedEventId) return;
  state.ticketsLoading = false;
  if (result.ok) {
    state.tickets = result.data;
    state.ticketsTotal = result.total;
    state.ticketsError = null;
  } else {
    state.ticketsError = api.errorMessage(result);
  }
  renderEvents();
}

function ticketsSection(ev) {
  const body = (() => {
    if (state.ticketsLoading) return h('div', { class: 'empty small' }, 'Carregando ingressos…');
    if (state.ticketsError) return errorBox(`Não foi possível listar os ingressos: ${state.ticketsError}`, () => loadTickets());
    if (!state.tickets.length) return h('div', { class: 'empty small' }, 'Nenhum ingresso ainda. Use “Inscrever”.');
    return h('div', { class: 'ticket-list' }, state.tickets.map(ticketRow),
      moreNote(state.tickets.length, state.ticketsTotal, 'ingressos'));
  })();
  return h('div', { class: 'tickets', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'tickets-head' },
      h('h4', {}, `Ingressos de “${ev.title}”`),
      h('button', { class: 'btn tiny ghost', onclick: () => loadTickets() }, 'Atualizar')),
    body);
}

function ticketRow(ticket) {
  const cancelled = ticket.status === 'CANCELLED';
  const action = (label, fn, cls = '') =>
    h('button', { class: `btn tiny ${cls}`, onclick: () => fn(ticket) }, label);
  return h('div', { class: `ticket-row${cancelled ? ' cancelled' : ''}` },
    h('code', { class: 'ticket-code' }, ticket.ticket_code),
    h('div', { class: 'ticket-who' },
      h('strong', {}, ticket.participant_name),
      h('small', {}, `${ticket.participant_email} · ${ticket.modality_tier}`)),
    badge(ticket.status),
    h('div', { class: 'row-actions' },
      ticket.status === 'CONFIRMED' ? action('Check-in', checkIn, 'primary') : null,
      cancelled ? null : action('Editar', openEditTicket),
      cancelled ? null : action('Cancelar', cancelTicket, 'danger-ghost'),
      action('Histórico', (t) => showHistory('ticket', t.id, t.ticket_code))));
}

function openIssueTicket(ev) {
  openEvent(ev.id);
  const person = samplePerson();
  openForm({
    title: 'Inscrever participante',
    description: `POST /tickets em “${ev.title}” (${ev.available_spots} vaga(s) livre(s)). O tickets-service reserva a vaga no events-service por HTTP antes de salvar. Repetir o documento de um inscrito ativo responde 409.`,
    fields: [
      { name: 'participant_name', label: 'Nome', required: true, value: person.name, wide: true },
      { name: 'participant_email', label: 'E-mail', type: 'email', required: true, value: person.email },
      { name: 'participant_document', label: 'Documento (CPF, RG ou matrícula)', required: true, value: person.document },
      { name: 'modality_tier', label: 'Categoria da inscrição', value: 'STANDARD', list: TIERS },
    ],
    submitLabel: 'Emitir ingresso',
    onSubmit: async (v) => {
      const result = await traced({
        title: 'Emitir ingresso',
        subtitle: `${v.participant_name} em ${ev.title}`,
        method: 'POST',
        path: '/tickets',
        body: { event_id: ev.id, ...v, modality_tier: v.modality_tier || undefined },
        route: 'issue',
        activities: 2,
        tx: 'uma transação no tickets-db: salva o ingresso e grava ticket.issued na outbox; a reserva já gravou event.spot_reserved na outbox do events-db',
        async: { origins: ['tickets', 'events'] },
      });
      await afterWrite();
      return result.ok ? null : api.errorMessage(result);
    },
  });
}

function openEditTicket(ticket) {
  openForm({
    title: 'Editar ingresso',
    description: `PUT /tickets/{id} em ${ticket.ticket_code}: só os campos alterados são enviados.`,
    fields: [
      { name: 'participant_name', label: 'Nome', required: true, value: ticket.participant_name, wide: true },
      { name: 'participant_email', label: 'E-mail', type: 'email', required: true, value: ticket.participant_email },
      { name: 'participant_document', label: 'Documento', required: true, value: ticket.participant_document },
      { name: 'modality_tier', label: 'Categoria da inscrição', required: true, value: ticket.modality_tier, list: TIERS },
    ],
    onSubmit: async (v) => {
      const changes = Object.fromEntries(Object.entries(v).filter(([key, value]) => value !== ticket[key]));
      if (!Object.keys(changes).length) return 'Nenhum campo foi alterado.';
      const result = await traced({
        title: 'Editar ingresso',
        subtitle: `${ticket.ticket_code}: ${Object.keys(changes).join(', ')}`,
        method: 'PUT',
        path: `/tickets/${ticket.id}`,
        body: changes,
        route: 'tickets',
        activities: 1,
        tx: 'uma transação no tickets-db: atualiza o ingresso e grava ticket.updated na outbox',
      });
      await afterWrite();
      return result.ok ? null : api.errorMessage(result);
    },
  });
}

async function checkIn(ticket) {
  const result = await traced({
    title: 'Check-in',
    subtitle: `${ticket.ticket_code} (${ticket.participant_name})`,
    method: 'PUT',
    path: `/tickets/${ticket.id}`,
    body: { status: 'CHECKED_IN' },
    route: 'tickets',
    activities: 1,
    tx: 'uma transação no tickets-db: registra a presença e grava ticket.checked_in na outbox',
  });
  if (!result.ok) toast(api.errorMessage(result), 'error');
  await afterWrite();
}

async function cancelTicket(ticket) {
  const ok = await confirmAction({
    title: 'Cancelar ingresso',
    message: `${ticket.ticket_code} (${ticket.participant_name}) será cancelado, e a vaga volta para o evento cerca de 1 s depois, pelo RabbitMQ. O registro do ingresso é mantido.`,
    confirmLabel: 'Cancelar ingresso',
  });
  if (!ok) return;
  const result = await traced({
    title: 'Cancelar ingresso',
    subtitle: `${ticket.ticket_code} (${ticket.participant_name})`,
    method: 'DELETE',
    path: `/tickets/${ticket.id}`,
    route: 'tickets',
    activities: 2,
    tx: 'uma transação no tickets-db: cancela o ingresso e grava ticket.cancelled e o pedido de devolução da vaga na outbox',
    async: {
      label: 'outbox → rabbitmq → events-service (devolve a vaga) e logs-service',
      origins: ['tickets'],
      waitsFor: 'events',
    },
  });
  if (!result.ok) toast(api.errorMessage(result), 'error');
  await afterWrite();
}

// ---------------------------------------------------------------------------------------------
// Teste de concorrência
// ---------------------------------------------------------------------------------------------

function openRush(ev) {
  openEvent(ev.id);
  openForm({
    title: 'Teste de concorrência',
    description: `Dispara várias inscrições ao mesmo tempo em “${ev.title}”, cada uma com um documento diferente. Cada uma pede a vaga ao events-service, onde a reserva é um UPDATE condicional: só passam as que encontram vaga, e as demais recebem 409.`,
    fields: [
      { name: 'count', label: 'Inscrições simultâneas', type: 'number', min: 2, max: 60, required: true, value: 20 },
    ],
    submitLabel: 'Disparar',
    onSubmit: async (v) => {
      void rush(ev, v.count);
      return null;
    },
  });
}

async function rush(ev, count) {
  const before = await api.request('GET', `/events/${ev.id}`);
  const availableBefore = before.ok ? before.data.available_spots : ev.available_spots;
  const correlationId = newCorrelationId('ui-rush');
  const trace = traces.create({
    title: `Teste de concorrência: ${count} inscrições simultâneas`,
    subtitle: ev.title,
    correlationId,
  });
  trace.step('http', {
    label: 'Navegador → api-gateway → tickets-service → events-service',
    detail: `${count} × POST /tickets disparados juntos, com ${availableBefore} vaga(s) livre(s)`,
    state: 'pending',
  });

  const run = Date.now().toString(36).slice(-4);
  const startedAt = performance.now();
  const animations = [];
  const calls = Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    const promise = api.request('POST', '/tickets', {
      correlationId,
      body: {
        event_id: ev.id,
        participant_name: `Participante ${n}`,
        participant_email: `participante${n}.${run}@example.com`,
        participant_document: `rush-${run}-${n}`,
        modality_tier: 'LOTE_1',
      },
    });
    animations.push(sleep(i * 25).then(() => topo.animateCall('issue', promise, { scale: 0.55 })));
    return promise;
  });
  trace.animation = Promise.all(animations);
  const results = await Promise.all(calls);
  const elapsed = performance.now() - startedAt;

  const groups = new Map();
  for (const r of results) {
    const key = r.ok ? api.statusLine(r) : `${api.statusLine(r)} (${api.errorMessage(r)})`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const issued = results.filter((r) => r.status === 201).length;
  const summary = [...groups].map(([key, n]) => `${n} × ${key}`).join(' · ');
  trace.step('http', { detail: `${count} respostas em ${fmtMs(elapsed)}: ${summary}`, state: issued > 0 ? 'ok' : 'warn' });

  const after = await api.request('GET', `/events/${ev.id}`);
  const availableAfter = after.ok ? after.data.available_spots : '?';
  const safe = issued <= availableBefore;
  trace.step('db', {
    label: 'events-service → events-db (UPDATE condicional)',
    detail: `vagas livres: ${availableBefore} → ${availableAfter} · ${issued} ingresso(s) emitido(s) · ${safe ? 'nenhuma venda além da capacidade' : 'ATENÇÃO: mais vendas do que vagas'}`,
    state: safe ? 'ok' : 'error',
  });
  if (issued > 0) {
    traces.watchAsync(trace, issued * 2, { origins: ['tickets', 'events'] });
  } else {
    trace.finish('warn');
  }
  await afterWrite();
}

// ---------------------------------------------------------------------------------------------
// Histórico (HTTP REST síncrono entre os serviços)
// ---------------------------------------------------------------------------------------------

async function showHistory(kind, id, label) {
  const path = `/${kind}s/${id}/history`;
  const correlationId = newCorrelationId();
  const trace = traces.create({ title: 'Consultar histórico', subtitle: label, correlationId });
  const service = kind === 'event' ? 'events-service' : 'tickets-service';
  const httpLabel = `Navegador → api-gateway → ${service}`;
  trace.step('http', { label: httpLabel, detail: `GET ${path}`, state: 'pending' });

  const promise = api.request('GET', path, { correlationId });
  const animation = topo.animateCall(kind === 'event' ? 'eventHistory' : 'ticketHistory', promise);
  trace.animation = animation;
  const result = await promise;
  const at = result.ms;

  const line = `GET ${path} → ${api.statusLine(result)} em ${fmtMs(result.ms)}`;
  const restLabel = `${service} → logs-service (HTTP REST síncrono)`;
  const restQuery = `GET /logs?entity_type=${kind}&entity_id=${shortId(id)}`;

  if (result.ok) {
    const { entries, total } = result.data;
    trace.step('http', { detail: line, state: 'ok', at });
    trace.step('rest', { label: restLabel, detail: `${restQuery} → ${entries.length} registro(s)`, state: 'ok', at });
    trace.finish('ok');
    // O histórico abre depois da animação, para o caminho REST entre os serviços ficar visível.
    await Promise.race([animation, sleep(6000)]);
    openHistory(kind, label, entries, total ?? null, service);
    return;
  }
  if (!result.reachedService || result.networkError) {
    trace.step('http', { detail: `${line}: o api-gateway não alcançou o ${service}`, state: 'error', at });
    trace.finish('error');
    toast(`${service} indisponível`, 'error');
    return;
  }
  trace.step('http', { detail: `${line} · ${api.errorMessage(result)}`, state: result.status === 503 ? 'error' : 'warn', at });
  if (result.status === 503) {
    trace.step('rest', {
      label: restLabel,
      detail: `${restQuery} sem resposta: só o histórico falha; emissões e cancelamentos continuam funcionando`,
      state: 'error',
      at,
    });
    trace.finish('error');
    toast('logs-service indisponível: o histórico responde 503, e o resto da API continua no ar.', 'error');
  } else {
    trace.finish('warn');
    toast(api.errorMessage(result), 'error');
  }
}

function openHistory(kind, label, entries, total, service) {
  $('#history-title').textContent = `Histórico: ${label}`;
  // O histórico é paginado; a página mostra a primeira e avisa quando há mais.
  const count = total !== null && total > entries.length
    ? `Os ${entries.length} primeiros de ${total} registros`
    : `${entries.length} registro(s)`;
  $('#history-description').textContent =
    `Montado pelo ${service}, que consultou o logs-service por HTTP. ${count} em ordem cronológica.`;
  const list = $('#history-list');
  list.replaceChildren(...(entries.length
    ? entries.map((entry) => h('li', { class: `history-item level-${entry.level}` },
      h('time', {}, fmtDateTimeSeconds(entry.occurred_at)),
      h('div', {},
        h('div', { class: 'history-top' },
          h('code', { class: 'chip' }, entry.action),
          badge(entry.level),
          entry.correlation_id ? h('code', { class: 'cid' }, entry.correlation_id) : null),
        h('div', {}, entry.message),
        entry.data ? h('code', { class: 'data' }, compactData(entry.data)) : null)))
    : [h('li', { class: 'empty small' }, kind === 'event'
      ? 'Nenhum registro ainda. As atividades chegam pelo RabbitMQ em cerca de 1 s.'
      : 'Nenhum registro ainda.')]));
  $('#dlg-history').showModal();
}

function compactData(data) {
  return Object.entries(data)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Registro de atividades (logs-service)
// ---------------------------------------------------------------------------------------------

async function loadLogs({ animate = true } = {}) {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT), order: 'desc' });
  const filters = {
    entity_type: $('#filter-log-entity').value,
    level: $('#filter-log-level').value,
    status: $('#filter-log-status').value,
    correlation_id: state.logCorrelation ?? '',
  };
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if ($('#filter-log-archived').checked) params.set('include_archived', 'true');

  const result = await read(`/logs?${params}`, { animate, route: 'logs' });
  if (result.ok) {
    state.logs = result.data;
    state.logsTotal = result.total;
    state.logsError = null;
  } else {
    state.logsError = api.errorMessage(result);
  }
  renderLogs();
}

function renderLogs() {
  const chip = $('#log-correlation-filter');
  chip.hidden = !state.logCorrelation;
  $('#log-correlation-value').textContent = state.logCorrelation ?? '';

  const list = $('#log-list');
  if (state.logsError) {
    list.replaceChildren(errorBox(`Não foi possível listar os registros: ${state.logsError}`, () => loadLogs()));
    return;
  }
  if (!state.logs.length) {
    list.replaceChildren(h('div', { class: 'empty' }, state.logCorrelation
      ? 'Nenhum registro com este correlation_id ainda.'
      : 'Nenhum registro com estes filtros.'));
    return;
  }
  const more = moreNote(state.logs.length, state.logsTotal, 'registros');
  list.replaceChildren(...state.logs.map(logRow), ...(more ? [more] : []));
}

function logRow(log) {
  const archived = Boolean(log.archived_at);
  const statusSelect = h('select', {
    class: 'inline-select',
    disabled: archived,
    'aria-label': 'Triagem',
    onchange: (e) => updateLog(log, { status: e.target.value }, `triagem → ${e.target.value}`),
  }, ['NEW', 'REVIEWED', 'RESOLVED'].map((value) => h('option', { value, selected: value === log.status }, value)));

  return h('article', { class: `log-row level-${log.level}${archived ? ' archived' : ''}` },
    h('div', { class: 'log-top' },
      h('time', {}, fmtDateTimeSeconds(log.occurred_at)),
      h('code', { class: 'chip' }, log.action),
      badge(log.level),
      h('span', { class: 'log-source' }, log.source),
      archived ? h('span', { class: 'badge muted' }, 'ARQUIVADO') : statusSelect),
    h('div', { class: 'log-message' }, log.message),
    h('div', { class: 'log-meta' },
      log.entity_type ? h('span', {}, `${log.entity_type} ${shortId(log.entity_id)}`) : null,
      log.correlation_id ? h('button', {
        class: 'cid as-link',
        title: 'Filtrar por este correlation_id',
        onclick: () => showCorrelation(log.correlation_id),
      }, log.correlation_id) : null,
      log.notes ? h('span', { class: 'log-notes' }, `notas: ${log.notes}`) : null),
    archived ? null : h('div', { class: 'row-actions' },
      h('button', { class: 'btn tiny', onclick: () => openNotes(log) }, 'Notas'),
      h('button', { class: 'btn tiny danger-ghost', onclick: () => archiveLog(log) }, 'Arquivar')));
}

function showCorrelation(correlationId) {
  state.logCorrelation = correlationId;
  switchTab('logs');
}

async function updateLog(log, changes, subtitle) {
  const result = await traced({
    title: 'Triagem de registro',
    subtitle: `${log.action}: ${subtitle}`,
    method: 'PUT',
    path: `/logs/${log.id}`,
    body: changes,
    route: 'logs',
    tx: 'atualiza só status e notes; o fato registrado continua imutável',
  });
  if (!result.ok) toast(api.errorMessage(result), 'error');
  await loadLogs({ animate: false });
  return result;
}

function openNotes(log) {
  openForm({
    title: 'Notas da triagem',
    description: `PUT /logs/{id} em ${log.action}. Só status e notes podem mudar.`,
    fields: [{ name: 'notes', label: 'Notas', type: 'textarea', value: log.notes ?? '', wide: true }],
    onSubmit: async (v) => {
      const result = await updateLog(log, { notes: v.notes || null }, 'notas');
      return result.ok ? null : api.errorMessage(result);
    },
  });
}

async function archiveLog(log) {
  const result = await traced({
    title: 'Arquivar registro',
    subtitle: log.action,
    method: 'DELETE',
    path: `/logs/${log.id}`,
    route: 'logs',
    tx: 'exclusão lógica: preenche archived_at, e o registro continua no logs-db',
  });
  if (!result.ok) toast(api.errorMessage(result), 'error');
  await loadLogs({ animate: false });
}

function openNewLog() {
  openForm({
    title: 'Registrar ocorrência',
    description: 'POST /logs: registro manual, gravado direto pela API do logs-service, sem passar pelo RabbitMQ.',
    fields: [
      { name: 'action', label: 'Ação', required: true, value: 'incident.reported', hint: 'Formato <entidade>.<verbo>' },
      { name: 'level', label: 'Nível', type: 'select', options: ['INFO', 'WARNING', 'ERROR'], value: 'WARNING' },
      {
        name: 'entity_id', label: 'Evento relacionado', type: 'select', wide: true,
        options: [{ value: '', label: 'Nenhum' }, ...state.events.map((ev) => ({ value: ev.id, label: ev.title }))],
        value: state.selectedEventId ?? '',
      },
      {
        name: 'message', label: 'Mensagem', type: 'textarea', required: true, wide: true,
        value: 'Projetor do auditório com defeito; a palestra atrasou 15 minutos.',
      },
    ],
    submitLabel: 'Registrar',
    onSubmit: async (v) => {
      const body = {
        action: v.action,
        level: v.level,
        message: v.message,
        ...(v.entity_id ? { entity_type: 'event', entity_id: v.entity_id } : {}),
      };
      const result = await traced({
        title: 'Registrar ocorrência',
        subtitle: v.action,
        method: 'POST',
        path: '/logs',
        body,
        route: 'logs',
        tx: 'grava o registro manual (source: manual) no logs-db',
      });
      await loadLogs({ animate: false });
      return result.ok ? null : api.errorMessage(result);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Componentes de interface
// ---------------------------------------------------------------------------------------------

function badge(value) {
  return h('span', { class: `badge s-${String(value).toLowerCase()}` }, value);
}

function errorBox(message, retry) {
  return h('div', { class: 'error-box' },
    h('span', {}, message),
    retry ? h('button', { class: 'btn small', onclick: retry }, 'Tentar de novo') : null);
}

function fmtDateTimeSeconds(iso) {
  return `${fmtDateTime(iso)}:${String(new Date(iso).getSeconds()).padStart(2, '0')}`;
}

/** Formulário genérico em <dialog>. onSubmit devolve null para fechar ou a mensagem de erro. */
function openForm({ title, description, fields, submitLabel = 'Salvar', onSubmit }) {
  const dialog = $('#dlg-form');
  const form = $('#form-body');
  const error = $('#form-error');
  const submit = $('#form-submit');
  $('#form-title').textContent = title;
  $('#form-description').textContent = description ?? '';
  submit.textContent = submitLabel;
  error.hidden = true;

  const inputs = {};
  const container = $('#form-fields');
  container.replaceChildren(...fields.map((field) => {
    let input;
    if (field.type === 'select') {
      input = h('select', { name: field.name }, field.options.map((option) => {
        const value = option.value ?? option;
        return h('option', { value, selected: value === field.value }, option.label ?? option);
      }));
    } else if (field.type === 'textarea') {
      input = h('textarea', { name: field.name, rows: 3, required: field.required });
      input.value = field.value ?? '';
    } else {
      input = h('input', {
        name: field.name,
        type: field.type ?? 'text',
        required: field.required,
        min: field.min,
        max: field.max,
        list: field.list ? `list-${field.name}` : null,
        autocomplete: 'off',
      });
      input.value = field.value ?? '';
    }
    inputs[field.name] = { input, type: field.type };
    return h('label', { class: `form-field${field.wide ? ' wide' : ''}` },
      h('span', {}, field.label),
      input,
      field.list ? h('datalist', { id: `list-${field.name}` }, field.list.map((value) => h('option', { value }))) : null,
      field.hint ? h('small', {}, field.hint) : null);
  }));

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const values = {};
    for (const [name, { input, type }] of Object.entries(inputs)) {
      values[name] = type === 'number' ? Number(input.value) : input.value.trim();
    }
    submit.disabled = true;
    error.hidden = true;
    try {
      const message = await onSubmit(values);
      if (message) {
        error.textContent = message;
        error.hidden = false;
      } else {
        dialog.close();
      }
    } finally {
      submit.disabled = false;
    }
  };
  $('#form-cancel').onclick = () => dialog.close();
  dialog.showModal();
  container.querySelector('input, select, textarea')?.focus();
}

function confirmAction({ title, message, confirmLabel }) {
  const dialog = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-yes').textContent = confirmLabel;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.onclose = () => resolve(dialog.returnValue === 'yes');
    dialog.showModal();
  });
}

function switchTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tab')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  $('#tab-events').hidden = tab !== 'events';
  $('#tab-logs').hidden = tab !== 'logs';
  if (tab === 'logs') void loadLogs();
}

// ---------------------------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------------------------

function wire() {
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  }
  $('#btn-new-event').addEventListener('click', openNewEvent);
  $('#btn-refresh-events').addEventListener('click', () => loadEvents());
  $('#filter-event-status').addEventListener('change', () => loadEvents());

  $('#btn-new-log').addEventListener('click', openNewLog);
  $('#btn-refresh-logs').addEventListener('click', () => loadLogs());
  for (const id of ['#filter-log-entity', '#filter-log-level', '#filter-log-status', '#filter-log-archived']) {
    $(id).addEventListener('change', () => loadLogs());
  }
  $('#btn-clear-correlation').addEventListener('click', () => {
    state.logCorrelation = null;
    void loadLogs();
  });

  $('#btn-clear-traces').addEventListener('click', () => traces.clear());
  $('#btn-experiments').addEventListener('click', () => $('#dlg-experiments').showModal());
  $('#experiments-close').addEventListener('click', () => $('#dlg-experiments').close());
  $('#history-close').addEventListener('click', () => $('#dlg-history').close());
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => copyText(button.dataset.copy));
  }

  traces.onShowCorrelation(showCorrelation);
  // A devolução de vaga e a cascata chegam depois da resposta: a lista é recarregada quando os
  // registros confirmam que elas aconteceram.
  traces.onAsyncResolved(() => {
    if (state.tab === 'logs') void loadLogs({ animate: false });
    else void afterWrite();
  });
  monitor.onHealthChange((id, label, previous, next) => {
    if (next === 'down') {
      traces.note(`${label} saiu do ar`, 'error');
    } else if (previous === 'down') {
      traces.note(`${label} voltou${next === 'up' ? '' : ' parcialmente'}`, 'ok');
      if ((id === 'events' || id === 'tickets') && next === 'up') void loadEvents({ animate: false });
    }
  });
}

topo.initTopology($('#topology'));
wire();
monitor.start();
void loadEvents({ animate: false });
traces.note(`Página carregada às ${fmtClock()}. Cada operação aparece aqui com o seu X-Correlation-Id.`, 'info');
