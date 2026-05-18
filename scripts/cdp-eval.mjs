// Tiny CDP eval helper. Usage:
//   node scripts/cdp-eval.mjs "expression"
// Evaluates the expression inside the live Shotblocks v2 WebView2
// page and prints the result. Picks the first /json/list target.
// Uses Node's built-in WebSocket (Node 22+).
const expr = process.argv.slice(2).join(' ');
if (!expr) {
  console.error('Usage: node cdp-eval.mjs "<expression>"');
  process.exit(1);
}

const list = await fetch('http://localhost:9222/json/list').then((r) => r.json());
const page = list.find((p) => p.type === 'page' && p.title.includes('Shotblocks'));
if (!page) {
  console.error('No Shotblocks page found at localhost:9222');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let next = 1;

ws.addEventListener('open', () => {
  call('Runtime.evaluate', {
    expression: `(() => { try { return JSON.stringify(${expr}); } catch (e) { return 'ERR: ' + e.message; } })()`,
    returnByValue: true,
    awaitPromise: true,
  }).then((res) => {
    if (res.exceptionDetails) {
      console.error('EXCEPTION:', res.exceptionDetails.text, res.exceptionDetails.exception?.description);
    } else {
      const v = res.result?.value;
      try { console.log(JSON.parse(v)); } catch { console.log(v); }
    }
    ws.close();
  });
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  }
});

function call(method, params) {
  const id = next++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, { resolve }));
}
