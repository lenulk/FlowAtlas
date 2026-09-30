const result = document.querySelector('#result');
const link = document.querySelector('#graph-link');
const buttons = [...document.querySelectorAll('button[data-name]')];

async function run(button) {
  buttons.forEach((item) => { item.disabled = true; });
  link.hidden = true;
  result.textContent = 'กำลังบันทึก action และเรียก API…';
  try {
    const id = crypto.randomUUID();
    const start = await fetch('/action-start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: button.dataset.name, clientTime: new Date().toISOString() }),
    });
    const started = await start.json();
    if (!start.ok) throw new Error(started.error ?? `HTTP ${start.status}`);
    const response = await fetch(button.dataset.path, {
      method: button.dataset.method, headers: { 'x-flowatlas-action-id': id },
    });
    result.textContent = `HTTP ${response.status}\n${JSON.stringify(await response.json(), null, 2)}`;
    link.href = started.viewerUrl;
    link.hidden = false;
  } catch (error) {
    result.textContent = error.message;
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
}

buttons.forEach((button) => button.addEventListener('click', () => run(button)));
