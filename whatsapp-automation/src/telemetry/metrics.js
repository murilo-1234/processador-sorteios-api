// src/telemetry/metrics.js
// Telemetria leve (in-memory) por instância. Liga com METRICS_ENABLED=1.

const ENABLED = String(process.env.METRICS_ENABLED || '0') === '1';

const state = {
  startedAt: Date.now(),
  perInstance: Object.create(null),
  jobs: Object.create(null),
};

function inst(id = 'default') {
  if (!state.perInstance[id]) {
    state.perInstance[id] = {
      connects: 0,
      disconnects: 0,
      reconnects: 0,
      waErrors: 0,
      messagesSent: 0,
      messagesFailed: 0,
      openaiCalls: 0,
      openaiTotalMs: 0,
    };
  }
  return state.perInstance[id];
}

function recordConnect(instanceId = 'default')      { if (!ENABLED) return; inst(instanceId).connects++; }
function recordDisconnect(instanceId = 'default')   { if (!ENABLED) return; inst(instanceId).disconnects++; }
function recordReconnect(instanceId = 'default')    { if (!ENABLED) return; inst(instanceId).reconnects++; }
function recordWAError(instanceId = 'default')      { if (!ENABLED) return; inst(instanceId).waErrors++; }

function recordMessageSent(instanceId = 'default')  { if (!ENABLED) return; inst(instanceId).messagesSent++; }
function recordMessageFailed(instanceId = 'default'){ if (!ENABLED) return; inst(instanceId).messagesFailed++; }

function recordOpenAI(instanceId = 'default', ms = 0) {
  if (!ENABLED) return;
  const i = inst(instanceId);
  i.openaiCalls++;
  i.openaiTotalMs += Math.max(0, Number(ms) || 0);
}

function recordJobDuration(jobName, status, seconds) {
  if (!ENABLED) return;
  if (!state.jobs[jobName]) state.jobs[jobName] = { runs: 0, ok: 0, fail: 0, totalSec: 0 };
  const j = state.jobs[jobName];
  j.runs++; j.totalSec += Math.max(0, Number(seconds) || 0);
  if (String(status).toLowerCase().startsWith('c')) j.ok++; else j.fail++;
}

function snapshot() {
  const out = {
    enabled: ENABLED,
    startedAt: state.startedAt,
    now: Date.now(),
    perInstance: {},
    jobs: state.jobs,
  };
  for (const [k, v] of Object.entries(state.perInstance)) {
    out.perInstance[k] = {
      ...v,
      openaiAvgMs: v.openaiCalls ? Math.round(v.openaiTotalMs / v.openaiCalls) : 0,
    };
  }
  return out;
}

module.exports = {
  ENABLED,
  recordConnect,
  recordDisconnect,
  recordReconnect,
  recordWAError,
  recordMessageSent,
  recordMessageFailed,
  recordOpenAI,
  recordJobDuration,
  snapshot,
};
