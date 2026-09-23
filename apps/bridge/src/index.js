// Gen-Harness bridge. Giai đoạn 1: health + heartbeat. Giai đoạn 2: Zalo (zca-js loginQR) và WhatsApp (Baileys)
// publish tin vào gh.bridge.inbound; ingest trong worker ghi raw.events (ARCHITECTURE §4, lệch D1).
import http from 'node:http';
import { createClient } from 'redis';
import { STREAMS, envelope } from './envelope.js';

const REDIS_URL = process.env.GH_REDIS_URL || 'redis://localhost:6379/0';
const PORT = Number(process.env.GH_BRIDGE_PORT || 3100);
const HEARTBEAT_MS = Number(process.env.GH_BRIDGE_HEARTBEAT_MS || 10000);
const STREAM_MAXLEN = Number(process.env.GH_STREAM_MAXLEN || 100000);

const state = { startedAt: new Date().toISOString(), redis: 'down', channels: [] };
const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => {
  state.redis = 'down';
  console.error(JSON.stringify({ level: 'ERROR', msg: `redis: ${err.message}` }));
});
redis.on('ready', () => { state.redis = 'ok'; });

export async function publish(stream, type, payload) {
  return redis.xAdd(stream, '*', envelope(type, payload), {
    TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: STREAM_MAXLEN },
  });
}

async function heartbeat() {
  if (!redis.isReady) return;
  const at = new Date().toISOString();
  await redis.set('gh:bridge:heartbeat', at, { EX: Math.ceil((HEARTBEAT_MS * 3) / 1000) });
  await publish(STREAMS.status, 'bridge.heartbeat', { at, channels: state.channels });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const ok = state.redis === 'ok';
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', ...state }));
    return;
  }
  res.writeHead(404).end();
});

async function main() {
  await redis.connect();
  server.listen(PORT, () => console.log(JSON.stringify({ level: 'INFO', msg: `bridge nghe cổng ${PORT}` })));
  await heartbeat().catch(() => {});
  const timer = setInterval(() => heartbeat().catch((e) => console.error(e.message)), HEARTBEAT_MS);
  const stop = async () => {
    clearInterval(timer);
    server.close();
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'ERROR', msg: err.message }));
  process.exit(1);
});
