const $ = (selector) => document.querySelector(selector);
const svgNS = 'http://www.w3.org/2000/svg';
const statusLabels = { observed: 'สังเกตจริง', inferred: 'อนุมาน', unknown: 'ยังไม่ทราบ' };
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
      link.href = `/flowatlas/source?file=${encodeURIComponent(target.source.file)}&sha256=${target.source.sha256}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `เปิด ${target.source.file} · ${target.source.symbol} ↗`;
      details.append(link);
    }
    item.append(details);
    container.append(item);
  }
}

function renderGraph(graph) {
  $('#empty').hidden = true;
  $('#trace-content').hidden = false;
  $('#trace-subtitle').textContent = `${graph.name} · ${graph.outcome} · ${graph.nodes.length} nodes`;
  $('#action-id').textContent = graph.id;
  $('#json-link').href = `/flowatlas/actions/${encodeURIComponent(graph.id)}`;
  renderMap(graph);
  renderEvidence(graph);
}

async function performAction(button) {
  const id = crypto.randomUUID();
  const action = button.dataset.action;
  document.querySelectorAll('button[data-action]').forEach((element) => { element.disabled = true; });
  $('#result').textContent = `กำลังรัน ${action}…`;
  try {
    const started = await fetch('/flowatlas/action-start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: action, clientTime: new Date().toISOString() }),
    });
    if (!started.ok) throw new Error(`บันทึก action ไม่สำเร็จ (${started.status})`);
    const response = await fetch(button.dataset.path, {
      method: button.dataset.method,
      headers: { 'x-flowatlas-action-id': id },
    });
    const result = await response.json();
    $('#result').textContent = response.ok ? JSON.stringify(result) : `HTTP ${response.status}: ${JSON.stringify(result)}`;
    const traceResponse = await fetch(`/flowatlas/actions/${encodeURIComponent(id)}`);
    if (!traceResponse.ok) throw new Error('ไม่พบ trace');
    renderGraph(await traceResponse.json());
  } catch (error) {
    $('#result').textContent = error.message;
  } finally {
    document.querySelectorAll('button[data-action]').forEach((element) => { element.disabled = false; });
  }
}

document.querySelectorAll('button[data-action]').forEach((button) => {
  button.addEventListener('click', () => performAction(button));
});

const incomingActionId = new URLSearchParams(location.search).get('actionId');
if (incomingActionId) {
  $('#demo-actions').hidden = true;
  $('.workspace').classList.add('viewer-mode');
  $('#intro-lead').textContent = 'แผนที่นี้มาจากเว็บแอปอีกระบบหนึ่ง เลือกเส้นเชื่อมเพื่อดูหลักฐานและระดับความแน่นอนของแต่ละช่วง';
  fetch(`/flowatlas/actions/${encodeURIComponent(incomingActionId)}`)
    .then((response) => {
      if (!response.ok) throw new Error(`ไม่พบ action นี้ (${response.status})`);
      return response.json();
    })
    .then((graph) => {
      renderGraph(graph);
    })
    .catch((error) => {
      $('#trace-subtitle').textContent = error.message;
      $('#empty p').textContent = 'ไม่สามารถเปิดแผนที่นี้ได้';
    });
}
