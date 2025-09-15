// Conecta no SSE para status do WhatsApp (QR/connected/disconnected)
(function(){
try {
const es = new EventSource('/api/whatsapp/stream');


es.addEventListener('status', (ev) => {
try {
const data = JSON.parse(ev.data || '{}');
console.debug('[SSE][status]', data);
// se existir elemento #wa-status, atualiza
const el = document.querySelector('#wa-status');
if (el) {
el.textContent = data.connected ? 'Conectado' : 'Desconectado';
el.className = data.connected ? 'ok' : 'fail';
}
} catch (e) { console.warn('[SSE] parse error', e); }
});


es.onopen = () => console.log('[SSE] aberto');
es.onerror = (e) => console.warn('[SSE] erro', e);
} catch (e) {
console.warn('[SSE] init erro', e);
}
})();
