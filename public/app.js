const $ = (selector) => document.querySelector(selector);
let credential = null;
let authorized = false;
let sessionGeneration = 0;
function lockSession(message = '') {
  sessionGeneration++;
  historyRequest++;
  credential = null; authorized = false;
  document.body.classList.add('session-pending');
  $('#session-panel').hidden = false;
  $('#session-lock').hidden = true;
  $('#session-code').value = '';
  $('#session-message').textContent = message;
  $('#history-list').replaceChildren(); $('#evidence').replaceChildren(); $('#map').replaceChildren();
  $('#trace-content').hidden = true; $('#action-id').textContent = '';
  $('#result').textContent = 'เลือกการกระทำเพื่อเริ่ม trace';
}
async function apiFetch(path, options = {}) {
  const generation = sessionGeneration;
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !/^\/(flowatlas|api)\//.test(url.pathname)) throw new Error('Invalid viewer request');
  const headers = new Headers(options.headers);
  if (credential) headers.set('authorization', `Bearer ${credential}`);
  const response = await fetch(url, { ...options, headers, redirect: 'error' });
  if (generation !== sessionGeneration) throw new Error('session ถูกล็อกแล้ว');
  if (response.status === 401) {
    lockSession('session หมดอายุหรือรหัสไม่ถูกต้อง กรุณาเชื่อมต่อใหม่');
    throw new Error('กรุณาเชื่อมต่อ session');
  }
  return response;
}
function protectedLink(link) {
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    const popup = window.open('', '_blank');
    if (!popup) return;
    popup.opener = null;
    const pre = popup.document.createElement('pre');
    pre.textContent = 'กำลังอ่านข้อมูล…'; popup.document.body.replaceChildren(pre);
    try {
      const response = await apiFetch(link.getAttribute('href'));
      if (!response.ok) throw new Error(`เปิดข้อมูลไม่สำเร็จ (${response.status})`);
      pre.textContent = await response.text();
    } catch (error) { pre.textContent = error.message; }
  });
}
const svgNS = 'http://www.w3.org/2000/svg';
const statusLabels = { observed: 'สังเกตจริง', inferred: 'อนุมาน', unknown: 'ยังไม่ทราบ' };
const outcomeLabels = { success: 'สำเร็จ', error: 'ผิดพลาด', running: 'ยังไม่มีผลสุดท้าย' };
const typeLabels = {
  'user-action': 'USER ACTION', api: 'API', code: 'CODE',
  'external-request': 'EXTERNAL REQUEST', unknown: 'COVERAGE GAP',
};

function svgElement(name, attrs = {}) {
  const element = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function renderMap(graph) {
  const svg = $('#map');
  svg.replaceChildren();
  const width = 680;
  const rowHeight = 100;
  const height = graph.nodes.length * rowHeight + 20;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.height = `${height}px`;
  const locations = new Map(graph.nodes.map((node, index) => [node.id, { x: 88, y: 20 + index * rowHeight }]));

  for (const edge of graph.edges) {
    const from = locations.get(edge.from);
    const to = locations.get(edge.to);
    if (!from || !to) continue;
    const line = svgElement('path', {
      d: `M ${from.x + 250} ${from.y + 62} L ${to.x + 250} ${to.y + 9}`,
      class: `map-edge ${edge.status}`,
    });
    svg.append(line);
    const label = svgElement('text', { x: from.x + 272, y: (from.y + to.y) / 2 + 35, class: `edge-label ${edge.status}` });
    label.textContent = statusLabels[edge.status];
    svg.append(label);
  }

  for (const node of graph.nodes) {
    const { x, y } = locations.get(node.id);
    const group = svgElement('g', { class: `map-node ${node.type}` });
    group.append(svgElement('rect', { x, y, width: 500, height: 72, rx: 12 }));
    const type = svgElement('text', { x: x + 18, y: y + 25, class: 'node-type' });
    type.textContent = typeLabels[node.type] ?? node.type;
    group.append(type);
    const title = svgElement('text', { x: x + 18, y: y + 52, class: 'node-title' });
    title.textContent = node.label.length > 58 ? `${node.label.slice(0, 55)}…` : node.label;
    group.append(title);
    svg.append(group);
  }
}

function renderEvidence(graph) {
  const container = $('#evidence');
  container.replaceChildren();
  for (const edge of graph.edges) {
    const source = graph.nodes.find((node) => node.id === edge.from);
    const target = graph.nodes.find((node) => node.id === edge.to);
    const item = document.createElement('details');
    item.className = `evidence-item ${edge.status}`;
    const summary = document.createElement('summary');
    const badge = document.createElement('span');
    badge.className = `badge ${edge.status}`;
    badge.textContent = statusLabels[edge.status];
    const title = document.createElement('span');
    title.textContent = `${source.label} → ${target.label}`;
    summary.append(badge, title);
    item.append(summary);
    const details = document.createElement('div');
    details.className = 'evidence-detail';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(edge.evidence, null, 2);
    details.append(pre);
    if (target.source) {
      const link = document.createElement('a');
      link.href = `/flowatlas/source?actionId=${encodeURIComponent(graph.id)}&file=${encodeURIComponent(target.source.file)}&sha256=${target.source.sha256}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `เปิด ${target.source.file} · ${target.source.symbol} ↗`;
      protectedLink(link);
      details.append(link);
    }
    item.append(details);
    container.append(item);
  }
}

function renderGraph(graph) {
  if (!authorized) return;
  $('#empty').hidden = true;
  $('#trace-content').hidden = false;
  $('#trace-subtitle').textContent = `${graph.name} · ${outcomeLabels[graph.outcome]} · ${graph.nodes.length} nodes`;
  $('#action-id').textContent = graph.id;
  $('#json-link').href = `/flowatlas/actions/${encodeURIComponent(graph.id)}`;
  renderMap(graph);
  renderEvidence(graph);
}

async function performAction(button) {
  const generation = sessionGeneration;
  const id = crypto.randomUUID();
  const action = button.dataset.action;
  document.querySelectorAll('button[data-action]').forEach((element) => { element.disabled = true; });
  $('#result').textContent = `กำลังรัน ${action}…`;
  try {
    const started = await apiFetch('/flowatlas/action-start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: action, clientTime: new Date().toISOString() }),
    });
    if (!started.ok) throw new Error(`บันทึก action ไม่สำเร็จ (${started.status})`);
    const response = await apiFetch(button.dataset.path, {
      method: button.dataset.method,
      headers: { 'x-flowatlas-action-id': id },
    });
    const result = await response.json();
    if (generation !== sessionGeneration) return;
    $('#result').textContent = response.ok ? JSON.stringify(result) : `HTTP ${response.status}: ${JSON.stringify(result)}`;
    const traceResponse = await apiFetch(`/flowatlas/actions/${encodeURIComponent(id)}`);
    if (!traceResponse.ok) throw new Error('ไม่พบ trace');
    renderGraph(await traceResponse.json());
  } catch (error) {
    $('#result').textContent = error.message;
  } finally {
    document.querySelectorAll('button[data-action]').forEach((element) => { element.disabled = false; });
    await refreshHistory();
  }
}

let historyRequest = 0;
async function refreshHistory() {
  if (!authorized) return;
  const request = ++historyRequest;
  const query = new URLSearchParams({ q: $('#history-query').value,
    outcome: $('#history-outcome').value, limit: $('#history-limit').value });
  $('#history-status').textContent = 'กำลังอ่านรายการ…';
  try {
    const response = await apiFetch(`/flowatlas/actions?${query}`);
    if (!response.ok) throw new Error(`อ่านรายการไม่สำเร็จ (${response.status})`);
    const actions = await response.json();
    if (request !== historyRequest) return;
    $('#history-list').replaceChildren();
    for (const action of actions) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const link = document.createElement('a');
      link.href = `/?actionId=${encodeURIComponent(action.id)}`;
      link.textContent = action.name;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        history.replaceState(null, '', link.getAttribute('href'));
        loadGraph(action.id);
      });
      const id = document.createElement('small');
      id.textContent = action.id;
      name.append(link, id);
      const time = document.createElement('td');
      time.textContent = new Date(action.startedAt).toLocaleString('th-TH');
      const outcome = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `history-outcome ${action.outcome}`;
      badge.textContent = outcomeLabels[action.outcome];
      outcome.append(badge);
      row.append(name, time, outcome);
      $('#history-list').append(row);
    }
    $('#history-status').textContent = actions.length
      ? `แสดง ${actions.length} รายการล่าสุดที่ตรงกับเงื่อนไข` : 'ยังไม่มีรายการที่ตรงกับเงื่อนไข';
  } catch (error) {
    if (request !== historyRequest) return;
    $('#history-list').replaceChildren();
    $('#history-status').textContent = error.message;
  }
}
$('#history-form').addEventListener('submit', (event) => { event.preventDefault(); refreshHistory(); });
async function loadStorage() {
return apiFetch('/flowatlas/status').then((response) => {
  if (!response.ok) throw new Error('ไม่สามารถตรวจสถานะการเก็บข้อมูลได้');
  return response.json();
}).then((status) => {
  if (!authorized) return;
  $('#storage-status').textContent = status.storage === 'disk'
    ? `เก็บผลในโฟลเดอร์โครงการ เปิดดูได้หลังเริ่มโปรแกรมใหม่ · สูงสุด ${status.actionLimit} actions`
    : `เก็บผลชั่วคราวในหน่วยความจำ ปิดโปรแกรมแล้วข้อมูลหาย · สูงสุด ${status.actionLimit} actions`;
}).catch((error) => { $('#storage-status').textContent = error.message; });
}

document.querySelectorAll('button[data-action]').forEach((button) => {
  button.addEventListener('click', () => performAction(button));
});

const incomingActionId = new URLSearchParams(location.search).get('actionId');
if (incomingActionId) {
  $('#demo-actions').hidden = true;
  $('.workspace').classList.add('viewer-mode');
  $('#intro-lead').textContent = 'แผนที่จากการทำงานที่บันทึกไว้ เปิดรายการหลักฐานด้านล่างเพื่อดูที่มาและระดับความแน่นอนของแต่ละช่วง';
}
async function loadGraph(id) {
  const generation = sessionGeneration;
  return apiFetch(`/flowatlas/actions/${encodeURIComponent(id)}`)
    .then((response) => {
      if (!response.ok) throw new Error(`ไม่พบ action นี้ (${response.status})`);
      return response.json();
    })
    .then((graph) => {
      if (generation !== sessionGeneration) return;
      renderGraph(graph);
    })
    .catch((error) => {
      $('#trace-subtitle').textContent = error.message;
      $('#empty p').textContent = 'ไม่สามารถเปิดแผนที่นี้ได้';
    });
}
async function initializeViewer() {
  authorized = true; document.body.classList.remove('session-pending');
  $('#session-panel').hidden = true; $('#session-lock').hidden = credential === null;
  const actionId = new URLSearchParams(location.search).get('actionId');
  await Promise.all([refreshHistory(), loadStorage(), actionId ? loadGraph(actionId) : Promise.resolve()]);
}
protectedLink($('#json-link')); protectedLink($('#history-json'));
$('#session-lock').addEventListener('click', () => lockSession('session ถูกล็อกแล้ว'));
$('#session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const candidate = $('#session-code').value.trim(); $('#session-code').value = '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) { $('#session-message').textContent = 'รหัสไม่ถูกต้อง'; return; }
  credential = candidate;
  try {
    const response = await apiFetch('/flowatlas/status');
    if (!response.ok) throw new Error('เชื่อมต่อไม่สำเร็จ');
    await initializeViewer();
  } catch { lockSession('เชื่อมต่อไม่สำเร็จ กรุณาตรวจ pairing code และเปิด session ใหม่'); }
});
fetch('/flowatlas/session', { redirect: 'error' }).then(async (response) => {
  if (!response.ok) throw new Error('ตรวจ session ไม่สำเร็จ');
  const session = await response.json();
  if (session.authorizationRequired) lockSession(); else await initializeViewer();
}).catch(() => lockSession('ไม่สามารถเชื่อมต่อ FlowAtlas ได้'));
