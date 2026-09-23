// Adapter Zalo (zca-js). Một instance = một phiên. Thư viện được tiêm qua `lib` để test không chạm mạng.
// Sự kiện phát ra: qr · scanned · active · credential · ended · inbound (payload đã chuẩn hoá).
// Không ghi file, không in QR, không log nội dung tin.
import { EventEmitter } from 'node:events';
import { silentLogger } from '../log.js';
import { RecentIds, errorCode, toIso, toPlain } from '../util.js';

export const ZALO_QR_TTL_MS = 100000; // zca-js tự hết hạn QR sau 100 giây

export async function loadZaloLib() {
  const m = await import('zca-js');
  return { Zalo: m.Zalo, ThreadType: m.ThreadType, LoginQRCallbackEventType: m.LoginQRCallbackEventType };
}

const KIND_BY_MSGTYPE = {
  webchat: 'text',
  'chat.link': 'text',
  'chat.photo': 'image',
  'chat.gif': 'image',
  'chat.doodle': 'image',
  'chat.sticker': 'sticker',
  'share.file': 'file',
};

// Bridge chỉ gửi văn bản; zca-js đòi hàm này khi gửi ảnh từ đường dẫn — không hỗ trợ.
async function imageMetadataGetter() {
  throw new Error('IMAGE_SEND_UNSUPPORTED');
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export class ZaloAdapter extends EventEmitter {
  channel = 'zalo';

  constructor({ lib, sessionId, logger = silentLogger, qrMax = 5, now = Date.now, reconnectDelayMs = 5000 } = {}) {
    super();
    this.lib = lib;
    this.sessionId = sessionId;
    this.log = logger;
    this.qrMax = qrMax;
    this.now = now;
    this.reconnectDelayMs = reconnectDelayMs;
    this.state = 'idle';
    this.credential = null;
    this.api = null;
    this.ownId = '';
    this.groupNames = new Map();
    this.recent = new RecentIds(2000);
    this.qrCount = 0;
    this.qrActions = null;
    this.cancelled = false;
  }

  /** Đăng nhập: credential {imei, cookie, userAgent} → phiên đã lưu; null → QR. Resolve khi active hoặc ended. */
  async login(credential) {
    this.lib ||= await loadZaloLib();
    this.zalo = new this.lib.Zalo({ selfListen: true, logging: false, checkUpdate: false, imageMetadataGetter });
    let api;
    if (credential) {
      if (!credential.imei || !credential.cookie || !credential.userAgent) {
        return this.#end('expired', 'CREDENTIAL_INVALID');
      }
      try {
        api = await this.zalo.login(credential);
      } catch (err) {
        if (this.cancelled) return undefined;
        this.log.warn('zalo: phiên đã lưu bị từ chối', { error: errorCode(err) });
        return this.#end('expired', 'CREDENTIAL_REJECTED');
      }
      this.credential = credential;
    } else {
      this.state = 'qr';
      this.qrCount = 0;
      this.qrExhausted = false;
      try {
        api = await this.zalo.loginQR({}, (evt) => this.#onQrEvent(evt));
      } catch (err) {
        if (this.cancelled) return undefined;
        if (this.qrExhausted) return this.#end('expired', 'QR_EXPIRED');
        this.log.warn('zalo: đăng nhập QR lỗi', { error: errorCode(err) });
        return this.#end('error', 'LOGIN_FAILED');
      }
      if (!this.credential) return this.#end('error', 'NO_LOGIN_INFO');
    }
    if (this.cancelled) return undefined;
    return this.#activate(api);
  }

  #onQrEvent(evt) {
    const T = this.lib.LoginQRCallbackEventType;
    if (this.cancelled) {
      try { evt?.actions?.abort?.(); } catch { /* đã huỷ */ }
      return;
    }
    switch (evt?.type) {
      case T.QRCodeGenerated: {
        this.qrCount += 1;
        this.qrActions = evt.actions || null;
        const img = String(evt.data?.image || '');
        const image = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
        this.emit('qr', { image, expiresAt: new Date(this.now() + ZALO_QR_TTL_MS).toISOString() });
        break;
      }
      case T.QRCodeScanned:
        this.emit('scanned', { displayName: evt.data?.display_name || null });
        break;
      case T.QRCodeExpired:
      case T.QRCodeDeclined:
        // Tự xin QR mới; đủ qrMax mã mà không đăng nhập được → dừng (session.ended expired).
        if (this.qrCount >= this.qrMax) {
          this.qrExhausted = true;
          evt.actions?.abort?.();
        } else {
          evt.actions?.retry?.();
        }
        break;
      case T.GotLoginInfo:
        // evt.data = {cookie, imei, userAgent}: chỉ giữ trong RAM.
        this.credential = { ...evt.data };
        break;
      default:
        break;
    }
  }

  async #activate(api) {
    this.api = api;
    try { this.ownId = String(api.getOwnId() || ''); } catch { this.ownId = ''; }
    let name = '';
    let phone;
    try {
      const info = await api.fetchAccountInfo();
      name = info?.profile?.displayName || info?.profile?.zaloName || '';
      phone = info?.profile?.phoneNumber || undefined;
    } catch { /* không bắt buộc */ }
    if (this.cancelled) return undefined;
    this.#attach(api);
    this.state = 'active';
    const account = { id: this.ownId, name };
    if (phone) account.phone = phone;
    this.emit('active', { account, credential: this.getCredential() });
    return 'active';
  }

  #onLibEvent(raw) {
    let p;
    try { p = this.normalise(raw); } catch (err) {
      this.log.warn('zalo: không chuẩn hoá được tin', { error: errorCode(err) });
      return;
    }
    if (!p) return;
    if (!this.recent.add(`${p.kind}:${p.external_msg_id}:${p.sender_external_id}`)) return;
    this.emit('inbound', p);
  }

  #attach(api) {
    this.api = api;
    const L = api.listener;
    L.on('message', (msg) => this.#onLibEvent(msg));
    L.on('reaction', (r) => this.#onLibEvent(r));
    L.on('error', (err) => this.log.warn('zalo: websocket lỗi', { error: errorCode(err) }));
    L.on('closed', (code) => { this.#onClosed(code); });
    L.start({ retryOnClose: true });
  }

  // zca-js tự nối lại với các mã đóng tạm thời; 'closed' nghĩa là thư viện đã bỏ cuộc.
  async #onClosed(code) {
    if (this.cancelled || this.state !== 'active') return;
    this.log.warn('zalo: websocket đóng hẳn', { code });
    if (Number(code) === 3000) {
      this.#end('error', 'CONNECTION_REPLACED'); // tài khoản mở Zalo Web ở nơi khác
      return;
    }
    // Thử đăng nhập lại một lần bằng phiên trong RAM.
    this.#stopListener();
    await new Promise((r) => { setTimeout(r, this.reconnectDelayMs); });
    if (this.cancelled) return;
    try {
      const api = await this.zalo.login(this.credential);
      if (this.cancelled) return;
      this.#attach(api);
    } catch {
      this.#end('expired', 'CREDENTIAL_REJECTED');
    }
  }

  #end(reason, error) {
    if (this.state === 'ended') return 'ended';
    this.state = 'ended';
    this.#stopListener();
    this.emit('ended', { reason, error });
    return 'ended';
  }

  #stopListener() {
    const L = this.api?.listener;
    if (!L) return;
    try {
      L.removeAllListeners?.();
      L.on?.('error', () => {}); // 'error' không có người nghe sẽ làm sập tiến trình
    } catch { /* bỏ qua */ }
    try { L.stop?.(); } catch { /* đã dừng */ }
  }

  getCredential() {
    return this.credential ? { ...this.credential } : null;
  }

  /** zca-js không có API đăng xuất phía máy chủ: dừng listener, huỷ QR đang chờ, bỏ phiên khỏi RAM. */
  async logout() {
    this.close();
  }

  /** Dừng không phát sự kiện (tắt tiến trình / thay phiên). */
  close() {
    this.cancelled = true;
    try { this.qrActions?.abort?.(); } catch { /* không còn chờ */ }
    this.#stopListener();
    this.credential = null;
    this.state = 'ended';
  }

  async send(threadId, threadType, text) {
    if (this.state !== 'active' || !this.api) throw Object.assign(new Error('SESSION_NOT_ACTIVE'), { code: 'SESSION_NOT_ACTIVE' });
    const T = this.lib.ThreadType;
    const res = await this.api.sendMessage({ msg: text }, String(threadId), threadType === 'group' ? T.Group : T.User);
    const id = res?.message?.msgId;
    return id === undefined || id === null ? null : String(id);
  }

  async syncGroups() {
    const api = this.api;
    const all = await api.getAllGroups();
    const ids = Object.keys(all?.gridVerMap || {});
    const groups = [];
    for (const part of chunk(ids, 20)) {
      let info;
      try { info = await api.getGroupInfo(part); } catch (err) {
        this.log.warn('zalo: getGroupInfo lỗi', { error: errorCode(err) });
        continue;
      }
      for (const id of part) {
        const g = info?.gridInfoMap?.[id];
        if (!g) continue;
        const memberIds = (Array.isArray(g.memberIds) && g.memberIds.length
          ? g.memberIds : (g.memVerList || []).map((s) => String(s).split('_')[0])).map(String);
        const profiles = {};
        for (const ids2 of chunk(memberIds, 100)) {
          try {
            const r = await api.getGroupMembersInfo(ids2);
            Object.assign(profiles, r?.profiles || {});
          } catch { break; } // tên thành viên không bắt buộc
        }
        const name = g.name || '';
        this.groupNames.set(String(id), name);
        groups.push({
          external_id: String(id),
          name,
          member_count: Number(g.totalMember ?? memberIds.length) || memberIds.length,
          members: memberIds.map((uid) => {
            const pr = profiles[uid] || profiles[`${uid}_0`];
            return { external_id: uid, name: pr?.displayName || pr?.zaloName || '' };
          }),
        });
      }
    }
    return groups;
  }

  /** Tin/reaction zca-js → payload gh.bridge.inbound `message` (chưa kiểm tập nghe). null = bỏ qua. */
  normalise(msg) {
    if (!msg || !msg.data) return null;
    const T = this.lib.ThreadType;
    const d = msg.data;
    const isReaction = msg.type === undefined && typeof msg.isGroup === 'boolean';
    const isGroup = isReaction ? msg.isGroup : msg.type === T.Group;
    const threadId = String(msg.threadId ?? '');
    let kind;
    let body = null;
    if (isReaction) {
      kind = 'reaction';
      body = d.content?.rIcon || null;
    } else {
      kind = KIND_BY_MSGTYPE[d.msgType] || (typeof d.content === 'string' && !d.msgType ? 'text' : 'other');
      const c = d.content;
      if (typeof c === 'string') {
        body = kind === 'text' ? c : null;
      } else if (c && typeof c === 'object') {
        if (kind === 'text') body = [c.title || c.description, c.href].filter(Boolean).join(' ') || null;
        else if (kind === 'image') body = c.title || c.description || null;
        else if (kind === 'file') body = c.title || null;
      }
    }
    const mentions = Array.isArray(d.mentions) ? d.mentions : [];
    const out = {
      channel: 'zalo',
      session_id: this.sessionId,
      external_msg_id: String(d.msgId ?? d.realMsgId ?? d.cliMsgId ?? ''),
      external_group_id: isGroup ? threadId : null,
      sender_external_id: String(d.uidFrom ?? ''),
      sender_name: d.dName || '',
      occurred_at: toIso(d.ts, 'ms', this.now),
      kind,
      body_text: body,
      direction: msg.isSelf ? 'outbound' : 'inbound',
      mentions_self: Boolean(this.ownId && mentions.some((m) => String(m?.uid) === this.ownId)),
      payload: toPlain({ type: msg.type, threadId: msg.threadId, isSelf: msg.isSelf, isGroup: msg.isGroup, data: d }),
    };
    if (isGroup && this.groupNames.has(threadId)) {
      out.group_name = this.groupNames.get(threadId);
    }
    return out;
  }
}
