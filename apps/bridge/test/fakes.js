// Đồ giả cho test: bus trong RAM, thư viện zca-js và Baileys giả phát sự kiện đúng hình dạng thật.
import { EventEmitter } from 'node:events';

export const KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='; // byte 0..31

export class FakeBus {
  constructor() {
    this.events = [];
    this.listen = {}; // channel → Set(groupId)
    this.direct = {}; // channel → '1'
    this.nonces = new Set();
    this.heartbeatKey = null;
  }

  async publish(stream, type, payload, opts = {}) {
    this.events.push({ stream, type, payload: JSON.parse(JSON.stringify(payload)), ...opts });
    return `${this.events.length}-0`;
  }

  async isListening(channel, groupId) { return Boolean(this.listen[channel]?.has(String(groupId))); }

  async listenDirect(channel) { return this.direct[channel] === '1'; }

  async claimNonce(nonce) {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }

  async setHeartbeat(at, ttl) { this.heartbeatKey = { at, ttl }; }

  async ping() { return 1; }

  of(stream, type) { return this.events.filter((e) => e.stream === stream && (!type || e.type === type)); }
}

export const tick = (ms = 0) => new Promise((r) => { setTimeout(r, ms); });

export async function waitFor(fn, { timeout = 2000, step = 5 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await tick(step);
  }
}

// ─── zca-js giả ───────────────────────────────────────────────────────────────

export const ThreadType = { User: 0, Group: 1, 0: 'User', 1: 'Group' };
export const LoginQRCallbackEventType = {
  QRCodeGenerated: 0, QRCodeExpired: 1, QRCodeScanned: 2, QRCodeDeclined: 3, GotLoginInfo: 4,
};

class FakeListener extends EventEmitter {
  constructor() { super(); this.started = 0; this.stopped = 0; }

  start() { this.started += 1; }

  stop() { this.stopped += 1; }
}

export function makeZaloApi({ ownId = '900', groups } = {}) {
  const sent = [];
  const api = {
    sent,
    listener: new FakeListener(),
    getOwnId: () => ownId,
    fetchAccountInfo: async () => ({ profile: { displayName: 'Cửa hàng A', zaloName: 'cuahanga', phoneNumber: '84900000000' } }),
    sendMessage: async (content, threadId, type) => {
      sent.push({ content, threadId, type });
      return { message: { msgId: 7000 + sent.length }, attachment: [] };
    },
    getAllGroups: async () => ({ version: '1', gridVerMap: Object.fromEntries(Object.keys(groups || {}).map((g) => [g, '1'])) }),
    getGroupInfo: async (ids) => ({
      removedsGroup: [], unchangedsGroup: [],
      gridInfoMap: Object.fromEntries([].concat(ids).map((id) => [id, groups[id]])),
    }),
    getGroupMembersInfo: async (ids) => ({
      profiles: Object.fromEntries([].concat(ids).map((id) => [id, { displayName: `Người ${id}`, zaloName: `u${id}`, id }])),
      unchangeds_profile: [],
    }),
  };
  return api;
}

/**
 * Lib zca-js giả. `script` điều khiển loginQR: test gọi ctrl.expire()/decline()/scan()/confirm().
 * Mô phỏng đúng zca-js: retry() gọi lại loginQR (phát QRCodeGenerated mới), abort() → reject.
 */
export function makeZaloLib({ api = makeZaloApi(), loginError = null } = {}) {
  const ctrl = { instances: [], qrGenerated: 0, loginCalls: [], api };
  class Zalo {
    constructor(options) { this.options = options; ctrl.instances.push(this); }

    async login(credential) {
      ctrl.loginCalls.push(credential);
      if (loginError) throw loginError;
      return api;
    }

    loginQR(options, callback) {
      return new Promise((resolve, reject) => {
        let actions;
        const generate = () => {
          ctrl.qrGenerated += 1;
          actions = {
            retry: () => { setImmediate(generate); },
            abort: () => reject(Object.assign(new Error('aborted'), { name: 'ZaloApiLoginQRAborted' })),
            saveToFile: async () => { throw new Error('không được ghi file'); },
          };
          callback({ type: 0, data: { code: `c${ctrl.qrGenerated}`, image: 'iVBORw0KGgoAAAANSUhEUg==', token: 't' }, actions });
        };
        ctrl.expire = () => callback({ type: 1, data: null, actions });
        ctrl.decline = () => callback({ type: 3, data: { code: 'c' }, actions });
        ctrl.scan = () => callback({ type: 2, data: { display_name: 'Chủ shop', avatar: '' }, actions });
        ctrl.confirm = () => {
          callback({ type: 4, data: { cookie: [{ key: 'zpw', value: 'secret' }], imei: 'imei-1', userAgent: 'UA' }, actions: null });
          resolve(api);
        };
        generate();
      });
    }
  }
  return { lib: { Zalo, ThreadType, LoginQRCallbackEventType }, ctrl };
}

export function zaloMessage({ group = true, threadId = 'G1', uidFrom = '111', dName = 'Lan', msgId = '5001',
  ts = '1758600000000', content = 'xin chào', msgType = 'webchat', isSelf = false, mentions } = {}) {
  const data = { msgId, cliMsgId: `cli${msgId}`, msgType, uidFrom, idTo: group ? threadId : '900', dName, ts, content };
  if (mentions) data.mentions = mentions;
  return { type: group ? ThreadType.Group : ThreadType.User, threadId, isSelf, data };
}

// ─── Baileys giả ──────────────────────────────────────────────────────────────

export const DisconnectReason = {
  connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, loggedOut: 401,
  badSession: 500, restartRequired: 515, multideviceMismatch: 411, forbidden: 403, unavailableService: 503,
};

export const BufferJSON = {
  replacer: (k, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
    }
    return value;
  },
  reviver: (_, value) => {
    if (typeof value === 'object' && value && value.type === 'Buffer' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    return value;
  },
};

export function makeBaileysLib() {
  const ctrl = { sockets: [] };
  const makeWASocket = (config) => {
    const sock = {
      config,
      ev: new EventEmitter(),
      user: undefined,
      sent: [],
      ended: 0,
      loggedOut: 0,
      sendMessage: async (jid, content) => {
        sock.sent.push({ jid, content });
        return { key: { remoteJid: jid, fromMe: true, id: `3EB0${sock.sent.length}` } };
      },
      groupFetchAllParticipating: async () => ({
        '120363@g.us': {
          id: '120363@g.us', subject: 'Nhóm kho', size: 2,
          participants: [{ id: '84901111111@s.whatsapp.net', admin: 'admin' }, { id: '5555@lid', phoneNumber: '84902222222@s.whatsapp.net' }],
        },
      }),
      logout: async () => { sock.loggedOut += 1; },
      end: () => { sock.ended += 1; },
      // Tiện cho test
      open(user = { id: '84909999999:3@s.whatsapp.net', lid: '7777:3@lid', name: 'Kho Gen' }) {
        sock.user = user;
        config.auth.creds.me = { id: user.id, lid: user.lid, name: user.name };
        sock.ev.emit('connection.update', { connection: 'open' });
      },
      close(statusCode) {
        sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
      },
    };
    ctrl.sockets.push(sock);
    return sock;
  };
  let qrN = 0;
  const lib = {
    makeWASocket,
    DisconnectReason,
    BufferJSON,
    initAuthCreds: () => ({ noiseKey: { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) }, registered: false }),
    proto: undefined,
    toDataURL: async (text) => { qrN += 1; return `data:image/png;base64,${Buffer.from(`qr${qrN}:${text.length}`).toString('base64')}`; },
    logger: { level: 'silent' },
  };
  ctrl.last = () => ctrl.sockets[ctrl.sockets.length - 1];
  return { lib, ctrl };
}

export function waMessage({ remoteJid = '120363@g.us', participant = '84901111111@s.whatsapp.net', fromMe = false,
  id = 'ABCD1', pushName = 'Minh', message = { conversation: 'chào cả nhà' }, messageTimestamp = 1758600000 } = {}) {
  const key = { remoteJid, fromMe, id };
  if (participant && remoteJid.endsWith('@g.us')) key.participant = participant;
  return { key, pushName, message, messageTimestamp };
}

// ─── Dựng SessionManager với thư viện giả ──────────────────────────────────────

export async function setup({ key = Buffer.from(KEY_B64, 'base64'), zalo = makeZaloLib(), wa = makeBaileysLib(), ...opts } = {}) {
  const { SessionManager } = await import('../src/sessions.js');
  const { Keyring } = await import('../src/crypto.js');
  const { ZaloAdapter } = await import('../src/channels/zalo.js');
  const { WhatsAppAdapter } = await import('../src/channels/whatsapp.js');
  const bus = new FakeBus();
  const keyring = new Keyring(key);
  const mgr = new SessionManager({
    bus,
    keyring,
    createAdapter: (channel, o) => (channel === 'zalo'
      ? new ZaloAdapter({ lib: zalo.lib, reconnectDelayMs: 1, ...o })
      : new WhatsAppAdapter({ lib: wa.lib, reconnectBaseMs: 1, ...o })),
    ...opts,
  });
  return { bus, mgr, keyring, zalo, wa };
}

export function ctl(type, payload, extra = {}) {
  return { type, payload, org_id: 'org-1', correlation_id: `corr-${type}`, ...extra };
}
