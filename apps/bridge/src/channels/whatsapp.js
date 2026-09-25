// Adapter WhatsApp (Baileys). Một instance = một phiên. Trạng thái xác thực chỉ nằm trong RAM
// (initAuthCreds + BufferJSON) và được tuần tự hoá thành credential. Thư viện tiêm qua `lib`.
// Sự kiện phát ra: qr · scanned · active · credential · ended · inbound.
import { EventEmitter } from 'node:events';
import { silentLogger } from '../log.js';
import { RecentIds, errorCode, toIso, toPlain } from '../util.js';

export const WA_FIRST_QR_TTL_MS = 60000; // Baileys: QR đầu sống 60 giây, các QR sau 20 giây
export const WA_NEXT_QR_TTL_MS = 20000;
const MAX_RECONNECTS = 10;

export async function loadWhatsAppLib() {
  const [b, qrcode, pino] = await Promise.all([
    import('@whiskeysockets/baileys'), import('qrcode'), import('pino'),
  ]);
  const toDataURL = qrcode.toDataURL || qrcode.default?.toDataURL;
  const pinoFn = pino.default || pino;
  let version;
  try {
    // Phiên bản WA Web mới nhất (một lần khi khởi động); lỗi → dùng bản đóng gói trong Baileys.
    const r = await Promise.race([
      b.fetchLatestBaileysVersion(),
      new Promise((_, rej) => { setTimeout(() => rej(new Error('timeout')), 5000).unref?.(); }),
    ]);
    version = r?.version;
  } catch { version = undefined; }
  return {
    makeWASocket: b.makeWASocket || b.default,
    DisconnectReason: b.DisconnectReason,
    initAuthCreds: b.initAuthCreds,
    BufferJSON: b.BufferJSON,
    proto: b.proto,
    version,
    toDataURL: (text) => toDataURL(text, { margin: 2, width: 400 }),
    logger: pinoFn({ level: 'silent' }),
  };
}

/** Trạng thái xác thực trong RAM; `stored` là object đã tuần tự bằng BufferJSON.replacer. */
export function memoryAuthState(lib, stored) {
  const parsed = stored ? JSON.parse(JSON.stringify(stored), lib.BufferJSON.reviver) : null;
  const creds = parsed?.creds || lib.initAuthCreds();
  const keys = parsed?.keys || {};
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let v = keys[type]?.[id] ?? null;
            if (v && type === 'app-state-sync-key' && lib.proto?.Message?.AppStateSyncKeyData) {
              v = lib.proto.Message.AppStateSyncKeyData.fromObject(v);
            }
            out[id] = v;
          }
          return out;
        },
        set: async (data) => {
          for (const cat of Object.keys(data)) {
            keys[cat] ||= {};
            for (const id of Object.keys(data[cat])) {
              const v = data[cat][id];
              if (v) keys[cat][id] = v; else delete keys[cat][id];
            }
          }
        },
      },
    },
    serialize: () => JSON.parse(JSON.stringify({ creds, keys }, lib.BufferJSON.replacer)),
  };
}

function bareJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const [user, server] = jid.split('@');
  return server ? `${user.split(':')[0]}@${server}` : user.split(':')[0];
}

function phoneOf(jid) {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return undefined;
  const digits = jid.split('@')[0].split(':')[0];
  return /^\d{6,}$/.test(digits) ? `+${digits}` : undefined;
}

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage'];
const IGNORED_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i += 1) {
    const inner = WRAPPERS.map((w) => m[w]?.message).find(Boolean);
    if (!inner) break;
    m = inner;
  }
  return m;
}

/** → { kind, body, ctx } hoặc null (tin giao thức nội bộ, bỏ qua). */
function classify(message, stubType) {
  const m = unwrap(message);
  if (!m) return stubType ? { kind: 'system', body: null, ctx: null } : null;
  const type = Object.keys(m).find((k) => !IGNORED_KEYS.has(k) && m[k] !== null && m[k] !== undefined);
  if (!type) return stubType ? { kind: 'system', body: null, ctx: null } : null;
  const c = m[type];
  switch (type) {
    case 'conversation': return { kind: 'text', body: String(c), ctx: null };
    case 'extendedTextMessage': return { kind: 'text', body: c.text ?? null, ctx: c.contextInfo };
    case 'imageMessage': return { kind: 'image', body: c.caption || null, ctx: c.contextInfo };
    case 'stickerMessage': return { kind: 'sticker', body: null, ctx: c.contextInfo };
    case 'documentMessage': return { kind: 'file', body: c.caption || c.fileName || null, ctx: c.contextInfo };
    case 'videoMessage':
    case 'ptvMessage': return { kind: 'other', body: c.caption || null, ctx: c.contextInfo };
    case 'audioMessage': return { kind: 'other', body: null, ctx: c.contextInfo };
    case 'reactionMessage': return { kind: 'reaction', body: c.text || null, ctx: null };
    case 'protocolMessage':
      // Chỉ giữ thu hồi tin (REVOKE = 0); các loại khác là đồng bộ nội bộ của WhatsApp.
      return Number(c?.type ?? -1) === 0 ? { kind: 'system', body: null, ctx: null } : null;
    default: return { kind: 'other', body: null, ctx: c?.contextInfo || null };
  }
}

export class WhatsAppAdapter extends EventEmitter {
  channel = 'whatsapp';

  constructor({ lib, sessionId, logger = silentLogger, qrMax = 5, now = Date.now, reconnectBaseMs = 2000 } = {}) {
    super();
    this.lib = lib;
    this.sessionId = sessionId;
    this.log = logger;
    this.qrMax = qrMax;
    this.now = now;
    this.reconnectBaseMs = reconnectBaseMs;
    this.state = 'idle';
    this.sock = null;
    this.gen = 0;
    this.qrCount = 0;
    this.reconnects = 0;
    this.cancelled = false;
    this.groupNames = new Map();
    this.names = new Map(); // jid → pushName (chỉ trong RAM, dùng cho danh bạ nhóm)
    this.recent = new RecentIds(2000);
    this.own = { jid: '', lid: '', name: '' };
  }

  /** credential = object đã tuần tự (BufferJSON) hoặc null (QR). Resolve khi active hoặc ended. */
  async login(credential) {
    this.lib ||= await loadWhatsAppLib();
    try {
      this.auth = memoryAuthState(this.lib, credential);
    } catch {
      return this.#end('expired', 'CREDENTIAL_INVALID');
    }
    this.resuming = Boolean(credential);
    if (credential && !this.auth.state.creds?.me?.id) return this.#end('expired', 'CREDENTIAL_INVALID');
    this.state = credential ? 'connecting' : 'qr';
    return new Promise((resolve) => {
      this.settle = resolve;
      this.#connect();
    });
  }

  #connect() {
    if (this.cancelled || this.state === 'ended') return;
    const gen = ++this.gen;
    this.qrInSocket = 0;
    const sock = this.lib.makeWASocket({
      ...(this.lib.version ? { version: this.lib.version } : {}),
      auth: this.auth.state,
      printQRInTerminal: false,
      logger: this.lib.logger,
      browser: ['Gen-Harness', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false, // để điện thoại vẫn nhận thông báo
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    sock.ev.on('creds.update', () => {
      if (gen === this.gen && this.state === 'active') this.emit('credential');
    });
    sock.ev.on('connection.update', (u) => {
      this.#onConnection(u, gen).catch((err) => this.log.error('whatsapp: connection.update lỗi', { error: errorCode(err) }));
    });
    sock.ev.on('messages.upsert', (ev) => {
      if (gen !== this.gen || ev?.type !== 'notify') return;
      for (const m of ev.messages || []) this.#onLibMessage(m);
    });
  }

  async #onConnection(u, gen) {
    if (gen !== this.gen || this.cancelled || this.state === 'ended') return;
    const { connection, lastDisconnect, qr, isNewLogin } = u || {};
    if (qr && this.resuming) {
      // Phiên đã lưu mà máy chủ lại đòi QR → phiên không còn hiệu lực.
      this.#end('expired', 'CREDENTIAL_REJECTED');
      return;
    }
    if (qr) {
      // Mỗi mã QR mới = mã trước đã hết hạn. Quá qrMax mã → dừng.
      if (this.qrCount >= this.qrMax) {
        this.#end('expired', 'QR_EXPIRED');
        return;
      }
      this.qrCount += 1;
      this.qrInSocket += 1;
      const ttl = this.qrInSocket === 1 ? WA_FIRST_QR_TTL_MS : WA_NEXT_QR_TTL_MS;
      const image = await this.lib.toDataURL(qr);
      if (gen !== this.gen || this.cancelled || this.state === 'ended') return;
      this.emit('qr', { image, expiresAt: new Date(this.now() + ttl).toISOString() });
    }
    if (isNewLogin) {
      this.emit('scanned', { displayName: this.auth.state.creds?.me?.name || null });
    }
    if (connection === 'open') {
      this.reconnects = 0;
      const user = this.sock.user || this.auth.state.creds?.me || {};
      this.own = { jid: bareJid(user.id), lid: bareJid(user.lid), name: user.name || user.verifiedName || '' };
      if (this.state !== 'active') {
        this.state = 'active';
        const account = { id: this.own.jid, name: this.own.name };
        const phone = phoneOf(this.own.jid);
        if (phone) account.phone = phone;
        this.emit('active', { account, credential: this.getCredential() });
        this.#settle('active');
      }
      return;
    }
    if (connection === 'close') this.#onClose(lastDisconnect?.error?.output?.statusCode, gen);
  }

  #onClose(code, gen) {
    const DR = this.lib.DisconnectReason;
    this.sock = null;
    this.log.info('whatsapp: kết nối đóng', { code: code ?? null });
    if (code === DR.loggedOut) {
      this.#end('expired', this.state === 'active' ? 'LOGGED_OUT_REMOTELY' : 'CREDENTIAL_REJECTED');
      return;
    }
    if (code === DR.connectionReplaced) return this.#end('error', 'CONNECTION_REPLACED');
    if (code === DR.forbidden) return this.#end('error', 'FORBIDDEN');
    if (code === DR.multideviceMismatch) return this.#end('error', 'MULTIDEVICE_MISMATCH');
    if (code === DR.restartRequired) return this.#schedule(0, gen); // sau khi ghép cặp QR
    const pairing = this.state === 'qr' && !this.auth.state.creds?.me?.id;
    if (pairing) {
      // Hết lượt QR của socket này → mở socket mới để xin QR tiếp, trong giới hạn qrMax.
      if (this.qrCount >= this.qrMax) return this.#end('expired', 'QR_EXPIRED');
      return this.#schedule(0, gen);
    }
    this.reconnects += 1;
    if (this.reconnects > MAX_RECONNECTS) {
      return this.#end(this.resuming && this.state !== 'active' ? 'expired' : 'error', 'RECONNECT_FAILED');
    }
    return this.#schedule(Math.min(60000, this.reconnectBaseMs * 2 ** (this.reconnects - 1)), gen);
  }

  #schedule(delayMs, gen) {
    const t = setTimeout(() => { if (gen === this.gen) this.#connect(); }, delayMs);
    t.unref?.();
  }

  #onLibMessage(m) {
    let p;
    try { p = this.normalise(m); } catch (err) {
      this.log.warn('whatsapp: không chuẩn hoá được tin', { error: errorCode(err) });
      return;
    }
    if (!p) return;
    if (!this.recent.add(`${p.external_msg_id}:${p.external_group_id || ''}`)) return;
    this.emit('inbound', p);
  }

  #settle(result) {
    const s = this.settle;
    this.settle = null;
    s?.(result);
  }

  #end(reason, error) {
    if (this.state === 'ended') return 'ended';
    this.state = 'ended';
    this.gen += 1; // bỏ mọi sự kiện muộn của socket cũ
    const sock = this.sock;
    this.sock = null;
    try { sock?.end?.(undefined); } catch { /* đã đóng */ }
    this.emit('ended', { reason, error });
    this.#settle('ended');
    return 'ended';
  }

  getCredential() {
    return this.auth ? this.auth.serialize() : null;
  }

  /** Đăng xuất trên WhatsApp (gỡ thiết bị liên kết), rồi bỏ phiên khỏi RAM. */
  async logout() {
    const sock = this.sock;
    const wasActive = this.state === 'active';
    this.cancelled = true;
    this.gen += 1;
    if (sock && wasActive) {
      try { await sock.logout(); } catch (err) { this.log.warn('whatsapp: logout lỗi', { error: errorCode(err) }); }
    }
    this.close();
  }

  /** Dừng không phát sự kiện. */
  close() {
    this.cancelled = true;
    this.gen += 1;
    const sock = this.sock;
    this.sock = null;
    try { sock?.end?.(undefined); } catch { /* đã đóng */ }
    this.state = 'ended';
    this.auth = null;
    this.#settle('closed');
  }

  async send(threadId, threadType, text) {
    if (this.state !== 'active' || !this.sock) throw Object.assign(new Error('SESSION_NOT_ACTIVE'), { code: 'SESSION_NOT_ACTIVE' });
    const res = await this.sock.sendMessage(String(threadId), { text });
    return res?.key?.id ? String(res.key.id) : null;
  }

  async syncGroups() {
    if (!this.sock) throw new Error('SESSION_NOT_ACTIVE');
    const all = await this.sock.groupFetchAllParticipating();
    return Object.entries(all || {}).map(([jid, g]) => {
      const participants = Array.isArray(g.participants) ? g.participants : [];
      const name = g.subject || '';
      this.groupNames.set(jid, name);
      return {
        external_id: jid,
        name,
        member_count: Number(g.size ?? participants.length) || participants.length,
        members: participants.map((p) => {
          const id = p.id || '';
          const member = { external_id: id, name: p.name || p.notify || this.names.get(bareJid(id)) || '' };
          const phone = phoneOf(p.phoneNumber) || phoneOf(id);
          if (phone) member.phone = phone;
          return member;
        }),
      };
    });
  }

  /** WAMessage (messages.upsert) → payload gh.bridge.inbound `message`. null = bỏ qua. */
  normalise(m) {
    const key = m?.key || {};
    const remote = key.remoteJid || '';
    if (!remote || remote.endsWith('@broadcast') || remote.endsWith('@newsletter')) return null;
    const cls = classify(m.message, m.messageStubType);
    if (!cls) return null;
    const isGroup = remote.endsWith('@g.us');
    const fromMe = Boolean(key.fromMe);
    let sender;
    let senderAlt;
    if (fromMe) sender = this.own.jid || '';
    else if (isGroup) { sender = key.participant || ''; senderAlt = key.participantAlt || key.participantPn; }
    else { sender = remote; senderAlt = key.remoteJidAlt || key.senderPn; }
    const senderName = fromMe ? this.own.name : (m.pushName || '');
    if (!fromMe && sender && m.pushName) this.names.set(bareJid(sender), m.pushName);
    const mentioned = Array.isArray(cls.ctx?.mentionedJid) ? cls.ctx.mentionedJid.map(bareJid) : [];
    const mine = [this.own.jid, this.own.lid].filter(Boolean);
    const out = {
      channel: 'whatsapp',
      session_id: this.sessionId,
      external_msg_id: String(key.id || ''),
      external_group_id: isGroup ? remote : null,
      sender_external_id: sender,
      sender_name: senderName || '',
      occurred_at: toIso(m.messageTimestamp, 's', this.now),
      kind: cls.kind,
      body_text: cls.body,
      direction: fromMe ? 'outbound' : 'inbound',
      mentions_self: mentioned.some((j) => mine.includes(j)),
      payload: toPlain(m),
    };
    if (isGroup && this.groupNames.has(remote)) out.group_name = this.groupNames.get(remote);
    const phone = phoneOf(sender) || phoneOf(senderAlt);
    if (phone) out.sender_phone = phone;
    return out;
  }
}
