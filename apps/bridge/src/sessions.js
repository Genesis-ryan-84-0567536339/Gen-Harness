// Sổ phiên: xử lý lệnh gh.bridge.control / gh.bridge.outbound, nối sự kiện adapter → gh.bridge.status /
// .inbound / .directory, heartbeat từng phiên, đồng bộ danh bạ định kỳ. Credential chỉ nằm trong RAM.
import { STREAMS } from './envelope.js';
import { PERMIT_ERRORS, checkPermit } from './crypto.js';
import { silentLogger } from './log.js';
import { errorCode } from './util.js';

export const QR_MAX = 5;
export const CREDENTIAL_COALESCE_MS = 5000;
// Quét danh bạ + thành viên của MỌI nhóm là việc nặng với tài khoản cá nhân ⇒ chu kỳ dài (2 giờ). Nhóm mới không phải chờ
// chu kỳ: tin đầu tiên từ nhóm lạ phát `group.discovered` ngay, rồi quét lại sau DISCOVER_DELAY_MS (cách lần quét trước
// ít nhất DISCOVER_MIN_GAP_MS); Sếp cũng có nút "Cập nhật danh sách nhóm" (lệnh `directory.sync`).
export const DIRECTORY_MS = 2 * 60 * 60 * 1000;
export const DISCOVER_DELAY_MS = 5000;
export const DISCOVER_MIN_GAP_MS = 10 * 60 * 1000;
// Mọi lượt quét (chu kỳ, nhóm mới, nối lại sau mất mạng) cách lần BẮT ĐẦU trước ít nhất DISCOVER_MIN_GAP_MS — trừ lần đầu
// sau đăng nhập. Nút «Cập nhật danh sách nhóm» do Sếp bấm nên giãn ngắn hơn (5 phút) nhưng vẫn có: bấm dồn không
// được biến thành dồn yêu cầu lên nền tảng.
export const DIRECTORY_MANUAL_GAP_MS = 5 * 60 * 1000;
// Lượt quét lỗi/thiếu (nền tảng từ chối, có thể là hãm tốc) ⇒ lùi lịch gấp đôi chu kỳ mỗi lần liên tiếp, tối đa 8 giờ.
export const DIRECTORY_MAX_BACKOFF_MS = 8 * 60 * 60 * 1000;

const keyOf = (channel, sessionId) => `${channel}:${sessionId}`;

export class SessionManager {
  /**
   * @param {object} o
   * @param {object} o.bus  publish · isListening · listenDirect · claimNonce · ping · setHeartbeat
   * @param {import('./crypto.js').Keyring} o.keyring
   * @param {(channel: string, opts: object) => object} o.createAdapter
   */
  constructor({
    bus, keyring, createAdapter, channels = ['zalo', 'whatsapp'], logger = silentLogger, orgId = '',
    heartbeatMs = 15000, directoryMs = DIRECTORY_MS, qrMax = QR_MAX,
    credentialCoalesceMs = CREDENTIAL_COALESCE_MS, now = Date.now,
    discoverDelayMs = DISCOVER_DELAY_MS, discoverMinGapMs = DISCOVER_MIN_GAP_MS,
    manualMinGapMs = DIRECTORY_MANUAL_GAP_MS,
  }) {
    Object.assign(this, {
      bus, keyring, createAdapter, channels, log: logger, orgId, heartbeatMs, directoryMs, qrMax, credentialCoalesceMs, now,
      discoverDelayMs, discoverMinGapMs, manualMinGapMs,
    });
    this.sessions = new Map();
    this.controlChains = new Map();
    this.sendChains = new Map();
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  #publish(stream, type, payload, s, correlationId) {
    return this.bus.publish(stream, type, payload, {
      actor: `bridge:${payload.channel}`,
      orgId: s?.orgId || this.orgId,
      correlationId: correlationId || s?.correlationId,
    }).catch((err) => this.log.error('publish lỗi', { stream, type, error: err.message }));
  }

  #ended(channel, sessionId, reason, error, ctx) {
    const payload = { channel, session_id: sessionId, reason };
    if (error) payload.error = error;
    this.log.info('phiên kết thúc', { channel, session_id: sessionId, reason, error: error || null });
    return this.#publish(STREAMS.status, 'session.ended', payload, ctx);
  }

  #encrypt(s, credential) {
    return this.keyring.encryptTransport(JSON.stringify(credential), keyOf(s.channel, s.sessionId));
  }

  /** Chuỗi hoá các việc theo một khoá (giữ thứ tự login/logout của cùng một phiên). */
  #chain(map, key, fn) {
    const prev = map.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    map.set(key, next);
    next.finally(() => { if (map.get(key) === next) map.delete(key); }).catch(() => {});
    return next;
  }

  #teardown(s) {
    clearTimeout(s.dirTimer);
    clearTimeout(s.credTimer);
    clearTimeout(s.discoverTimer);
    s.dirTimer = null;
    s.credTimer = null;
    s.discoverTimer = null;
    s.adapter.removeAllListeners();
    if (this.sessions.get(s.key) === s) this.sessions.delete(s.key);
  }

  // ─── gh.bridge.control ──────────────────────────────────────────────────────

  handleControl(evt) {
    const p = evt?.payload || {};
    const channel = p.channel;
    const sessionId = p.session_id ? String(p.session_id) : '';
    if (!this.channels.includes(channel) || !sessionId) {
      this.log.warn('lệnh control không hợp lệ', { type: evt?.type, channel: channel ?? null });
      return Promise.resolve();
    }
    const ctx = { orgId: evt.org_id || this.orgId, correlationId: evt.correlation_id };
    return this.#chain(this.controlChains, keyOf(channel, sessionId), async () => {
      switch (evt.type) {
        case 'session.login': return this.#login(channel, sessionId, p.credential ?? null, ctx);
        case 'session.logout': return this.#logout(channel, sessionId, ctx);
        case 'session.close': return this.#close(channel, sessionId);
        case 'directory.sync': {
          const s = this.sessions.get(keyOf(channel, sessionId));
          if (s?.state === 'active') await this.syncDirectory(s, 'manual');
          else this.log.warn('directory.sync cho phiên chưa hoạt động', { channel, session_id: sessionId });
          return undefined;
        }
        default:
          this.log.warn('loại lệnh control không hỗ trợ', { type: evt.type });
          return undefined;
      }
    });
  }

  async #login(channel, sessionId, credentialBlob, ctx) {
    const key = keyOf(channel, sessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      this.#teardown(existing);
      existing.adapter.close();
    }
    if (!this.keyring.enabled) {
      // Không có khoá bridge: không thể mã hoá phiên để trả về lõi → không đăng nhập.
      await this.#ended(channel, sessionId, 'error', 'BRIDGE_KEY_MISSING', ctx);
      return;
    }
    let credential = null;
    if (credentialBlob) {
      try {
        credential = JSON.parse(this.keyring.decryptTransport(credentialBlob, key).toString('utf8'));
      } catch {
        await this.#ended(channel, sessionId, 'expired', 'CREDENTIAL_UNREADABLE', ctx);
        return;
      }
    }
    const logger = this.log.child({ channel, session_id: sessionId });
    let adapter;
    try {
      adapter = this.createAdapter(channel, { sessionId, logger, qrMax: this.qrMax });
    } catch (err) {
      await this.#ended(channel, sessionId, 'error', 'CHANNEL_UNAVAILABLE', ctx);
      this.log.error('không tạo được adapter', { channel, error: err.message });
      return;
    }
    const s = {
      key, channel, sessionId, adapter, state: 'starting', orgId: ctx.orgId, correlationId: ctx.correlationId,
      queued: 0, lastCredAt: 0, credTimer: null, dirTimer: null, inbound: 0, dropped: 0,
      knownGroups: new Set(), discoverTimer: null, pendingDiscover: false, syncing: null, lastSyncAt: 0,
      syncFailures: 0, nextSyncDelayMs: this.directoryMs, dirComplete: false,
    };
    this.sessions.set(key, s);
    this.#wire(s);
    this.log.info('bắt đầu đăng nhập', { channel, session_id: sessionId, mode: credential ? 'resume' : 'qr' });
    s.loginPromise = Promise.resolve()
      .then(() => adapter.login(credential))
      .catch((err) => {
        this.log.error('đăng nhập lỗi', { channel, session_id: sessionId, error: errorCode(err) });
        if (this.sessions.get(key) === s && s.state !== 'ended') {
          s.state = 'ended';
          this.#teardown(s);
          adapter.close();
          return this.#ended(channel, sessionId, 'error', 'LOGIN_FAILED', s);
        }
        return undefined;
      });
  }

  #wire(s) {
    const { adapter, channel, sessionId } = s;
    const base = { channel, session_id: sessionId };
    adapter.on('qr', ({ image, expiresAt }) => {
      s.state = 'qr';
      this.#publish(STREAMS.status, 'session.qr', { ...base, image, expires_at: expiresAt }, s);
    });
    adapter.on('scanned', ({ displayName } = {}) => {
      const payload = { ...base };
      if (displayName) payload.display_name = displayName;
      this.#publish(STREAMS.status, 'session.scanned', payload, s);
    });
    adapter.on('active', ({ account, credential }) => {
      let blob;
      try { blob = this.#encrypt(s, credential); } catch (err) {
        s.state = 'ended';
        this.#teardown(s);
        adapter.close();
        this.#ended(channel, sessionId, 'error', 'BRIDGE_KEY_MISSING', s);
        return;
      }
      s.state = 'active';
      s.lastCredAt = this.now();
      clearTimeout(s.dirTimer); // nối lại sau mất mạng: không để lại bộ đếm cũ
      this.log.info('phiên hoạt động', base);
      this.#publish(STREAMS.status, 'session.active', { ...base, account, credential: blob }, s);
      this.syncDirectory(s, 'login'); // lần đầu sau đăng nhập quét ngay; nối lại sau mất mạng thì phải đủ giãn cách
    });
    // Mất mạng/máy chủ nền tảng chưa tới: phiên vẫn còn (credential giữ nguyên), adapter tự thử lại. Báo lõi để thẻ kênh
    // nói đúng "đang nối lại" thay vì giữ "Đang kết nối"; ngừng heartbeat cho tới khi nối lại (session.active).
    adapter.on('retrying', ({ error } = {}) => {
      if (s.state === 'ended') return;
      s.state = 'retrying';
      clearTimeout(s.dirTimer);
      clearTimeout(s.credTimer);
      clearTimeout(s.discoverTimer);
      s.dirTimer = null;
      s.credTimer = null;
      s.discoverTimer = null;
      this.log.warn('phiên mất kết nối, đang thử nối lại', base);
      this.#publish(STREAMS.status, 'session.reconnecting', { ...base, error: error || 'NETWORK_UNAVAILABLE' }, s);
    });
    adapter.on('credential', () => this.#credentialChanged(s));
    adapter.on('ended', ({ reason, error }) => {
      s.state = 'ended';
      this.#teardown(s);
      this.#ended(channel, sessionId, reason, error, s);
    });
    adapter.on('inbound', (payload) => { this.#inbound(s, payload); });
  }

  /** Gộp creds.update: tối đa một session.credential mỗi credentialCoalesceMs. */
  #credentialChanged(s) {
    if (s.state !== 'active' || s.credTimer) return;
    const wait = Math.max(0, s.lastCredAt + this.credentialCoalesceMs - this.now());
    s.credTimer = setTimeout(() => {
      s.credTimer = null;
      if (s.state !== 'active') return;
      const credential = s.adapter.getCredential();
      if (!credential) return;
      s.lastCredAt = this.now();
      let blob;
      try { blob = this.#encrypt(s, credential); } catch { return; }
      this.#publish(STREAMS.status, 'session.credential', { channel: s.channel, session_id: s.sessionId, credential: blob }, s);
    }, wait);
    s.credTimer.unref?.();
  }

  /**
   * Khoá cứng: chỉ XADD tin của nhóm trong gh:bridge:listen:<channel>, tin 1-1 trừ khi Sếp chọn "không lưu"
   * (gh:bridge:listen_direct = "0"). Tin của nhóm LẠ (chưa từng thấy trong danh bạ) KHÔNG đi luồng inbound mà báo
   * `group.discovered` kèm chính tin đó (`first_message`): lõi tạo nhóm rồi chỉ lưu tin khi nhóm mới vào chế độ nghe
   * (mặc định «Lắng nghe im lặng», QĐ 17/10); nhóm chờ chọn / không nghe thì lõi bỏ, không lưu nội dung.
   */
  async #inbound(s, payload) {
    try {
      const allowed = payload.external_group_id
        ? await this.bus.isListening(s.channel, payload.external_group_id)
        : await this.bus.listenDirect(s.channel);
      if (!allowed) {
        s.dropped += 1;
        if (payload.external_group_id) await this.#discovered(s, payload);
        return;
      }
      s.inbound += 1;
      await this.bus.publish(STREAMS.inbound, 'message', payload, { actor: `bridge:${s.channel}`, orgId: s.orgId || this.orgId });
    } catch (err) {
      this.log.error('không đẩy được tin vào', { channel: s.channel, session_id: s.sessionId, error: err.message });
    }
  }

  /**
   * Nhóm chưa có trong danh bạ của phiên: báo lõi một lần, rồi hẹn quét lại để lấy thành viên. Tin ĐẦU TIÊN đi kèm
   * (`first_message`, cùng dạng tin inbound) để không mất khi lõi cho nhóm vào chế độ nghe; các tin sau chờ tập nghe
   * được đồng bộ như thường. Không ghi nội dung tin vào log.
   * Nội dung tin nằm lại trong stream (AOF, có thể sang .dlq) nên CHỈ gắn khi chắc chắn lõi sẽ lưu nó: (1) danh bạ
   * của phiên đã quét xong (chưa quét ⇒ nhóm "Không nghe" cũ cũng trông như nhóm lạ), và (2) cờ
   * `gh:bridge:new_group_mode:<kênh>` là `silent` (chưa có cờ = lõi cũ ⇒ coi như mặc định `silent`; `ask`/`off` ⇒ không gắn).
   */
  async #discovered(s, payload) {
    const gid = String(payload.external_group_id);
    if (s.knownGroups.has(gid)) return;
    s.knownGroups.add(gid);
    const body = {
      channel: s.channel, session_id: s.sessionId, group_id: gid, name: payload.group_name || '', member_count: null,
    };
    if (s.dirComplete) {
      try {
        if (((await this.bus.newGroupMode(s.channel)) ?? 'silent') === 'silent') body.first_message = payload;
      } catch { /* không đọc được cờ ⇒ không gắn nội dung tin */ }
    }
    this.#publish(STREAMS.directory, 'group.discovered', body, s);
    this.log.info('phát hiện nhóm mới', { channel: s.channel, session_id: s.sessionId });
    s.pendingDiscover = true;
    this.#armDiscover(s);
  }

  /**
   * Hẹn quét lại để lấy thành viên nhóm mới. Thời gian chờ tính lại LÚC TỚI HẠN (lượt quét khác có thể đã chạy xen
   * giữa): còn trong giãn cách thì hẹn tiếp phần còn lại; lượt quét khác đã chạy sau lúc phát hiện thì không quét thừa.
   */
  #armDiscover(s) {
    if (s.state !== 'active' || s.discoverTimer) return;
    const wait = Math.max(this.discoverDelayMs, this.#syncWaitMs(s, 'discover'));
    s.discoverTimer = setTimeout(() => {
      s.discoverTimer = null;
      if (s.state !== 'active' || !s.pendingDiscover) return;
      if (this.#syncWaitMs(s, 'discover') > 0) { this.#armDiscover(s); return; }
      this.syncDirectory(s, 'discover');
    }, wait);
    s.discoverTimer.unref?.();
  }

  async #logout(channel, sessionId, ctx) {
    const s = this.sessions.get(keyOf(channel, sessionId));
    if (s) {
      s.state = 'ended';
      this.#teardown(s);
      try { await s.adapter.logout(); } catch (err) {
        this.log.warn('logout lỗi', { channel, session_id: sessionId, error: errorCode(err) });
      }
    }
    await this.#ended(channel, sessionId, 'logged_out', null, ctx);
  }

  /** Đóng kết nối trong RAM, KHÔNG đăng xuất nền tảng và KHÔNG phát session.ended (lõi đã tự ghi phiên đó là xong). */
  async #close(channel, sessionId) {
    const s = this.sessions.get(keyOf(channel, sessionId));
    if (!s) return;
    this.log.info('đóng phiên cũ theo lệnh lõi', { channel, session_id: sessionId });
    s.state = 'ended';
    this.#teardown(s);
    try { s.adapter.close(); } catch (err) {
      this.log.warn('close lỗi', { channel, session_id: sessionId, error: errorCode(err) });
    }
  }

  /**
   * Chu kỳ quét hiện tại: chu kỳ gốc, gấp đôi mỗi lần lỗi liên tiếp, tối đa 8 giờ (không bao giờ ngắn hơn chu kỳ gốc).
   */
  #intervalMs(s) {
    return Math.min(this.directoryMs * 2 ** s.syncFailures, Math.max(DIRECTORY_MAX_BACKOFF_MS, this.directoryMs));
  }

  /**
   * Còn phải chờ bao lâu (ms) mới được quét tiếp. 0 = quét được ngay. Giãn cách tính từ lúc BẮT ĐẦU lượt quét trước
   * (kể cả lượt lỗi); lần đầu sau đăng nhập (chưa quét lần nào) không phải chờ.
   * Nguồn `manual` (nút của Sếp) giãn ngắn; các nguồn còn lại giãn dài hơn, và đang lùi lịch vì lỗi thì nhóm mới /
   * nối lại cũng chờ hết chu kỳ lùi — không hỏi dồn nền tảng đang từ chối.
   */
  #syncWaitMs(s, source) {
    if (!s.lastSyncAt) return 0;
    let gap = this.discoverMinGapMs;
    if (source === 'manual') gap = this.manualMinGapMs;
    else if (source !== 'timer' && s.syncFailures > 0) gap = Math.max(gap, this.#intervalMs(s));
    return Math.max(0, s.lastSyncAt + gap - this.now());
  }

  /** Quét danh bạ đầy đủ. Hai lệnh gần nhau (chu kỳ + nút làm mới) dùng chung MỘT lượt quét. */
  syncDirectory(s, source = 'timer') {
    if (s.state !== 'active') return Promise.resolve();
    if (s.syncing) return s.syncing;
    const wait = this.#syncWaitMs(s, source);
    if (wait > 0) {
      this.log.info('chưa đủ giãn cách giữa hai lượt quét danh bạ — bỏ qua', {
        channel: s.channel, session_id: s.sessionId, source, wait_ms: wait,
      });
      if (source !== 'manual') this.#scheduleSync(s);
      return Promise.resolve();
    }
    s.lastSyncAt = this.now(); // lúc BẮT ĐẦU (kể cả lượt lỗi) — giãn cách thật, không thể "quét lại ngay" khi lỗi
    s.pendingDiscover = false; // lượt này sẽ thấy mọi nhóm đã phát hiện trước đó
    s.syncing = this.#syncDirectory(s).finally(() => {
      s.syncing = null;
      this.#scheduleSync(s);
    });
    return s.syncing;
  }

  /**
   * Hẹn lượt quét định kỳ kế tiếp: cách lần BẮT ĐẦU trước đúng một chu kỳ (chu kỳ gốc khi lượt trước đủ, lùi gấp đôi mỗi
   * lần lỗi liên tiếp — tối đa 8 giờ), và không sớm hơn giãn cách tối thiểu.
   */
  #scheduleSync(s) {
    clearTimeout(s.dirTimer);
    s.dirTimer = null;
    if (s.state !== 'active') return;
    s.nextSyncDelayMs = this.#intervalMs(s);
    const wait = Math.max(this.#syncWaitMs(s, 'timer'), s.lastSyncAt + s.nextSyncDelayMs - this.now());
    s.dirTimer = setTimeout(() => { s.dirTimer = null; this.syncDirectory(s, 'timer'); }, wait);
    s.dirTimer.unref?.();
  }

  async #syncDirectory(s) {
    let ok = false;
    try {
      const groups = await s.adapter.syncGroups();
      if (s.state !== 'active') return;
      s.knownGroups = new Set(groups.map((g) => String(g.external_id)));
      // `groups_complete`: lượt quét không lỗi và có nhóm ⇒ lõi mới được coi nhóm vắng là "đã rời".
      ok = s.adapter.lastSyncComplete !== false;
      s.dirComplete = ok; // lượt quét lỗi/thiếu ⇒ danh bạ không đủ để khẳng định "nhóm lạ"
      const groupsComplete = groups.length > 0 && ok;
      await this.#publish(STREAMS.directory, 'groups',
        { channel: s.channel, session_id: s.sessionId, groups, groups_complete: groupsComplete }, s);
      this.log.info('đồng bộ danh bạ', { channel: s.channel, session_id: s.sessionId, groups: groups.length, complete: ok });
    } catch (err) {
      this.log.warn('đồng bộ danh bạ lỗi', { channel: s.channel, session_id: s.sessionId, error: errorCode(err) });
    } finally {
      s.syncFailures = ok ? 0 : s.syncFailures + 1;
    }
  }

  // ─── gh.bridge.outbound ─────────────────────────────────────────────────────

  handleOutbound(evt) {
    if (evt?.type !== 'message.send') {
      this.log.warn('loại lệnh outbound không hỗ trợ', { type: evt?.type });
      return Promise.resolve();
    }
    const p = evt.payload || {};
    const key = keyOf(p.channel, p.session_id);
    const s = this.sessions.get(key);
    if (s) s.queued += 1;
    return this.#chain(this.sendChains, key, async () => {
      try {
        return await this.#send(evt);
      } finally {
        if (s) s.queued -= 1;
      }
    });
  }

  async #send(evt) {
    const p = evt.payload || {};
    const result = { nonce: null, draft_id: null, channel: p.channel ?? null, ok: false };
    const finish = (extra) => {
      Object.assign(result, extra);
      if (!result.ok) this.log.warn('không gửi tin', { channel: result.channel, session_id: p.session_id ?? null, error: result.error });
      const s = this.sessions.get(keyOf(p.channel, p.session_id));
      return this.bus.publish(STREAMS.status, 'send.result', result, {
        actor: `bridge:${p.channel}`, orgId: evt.org_id || s?.orgId || this.orgId, correlationId: evt.correlation_id,
      }).catch((err) => this.log.error('publish send.result lỗi', { error: err.message }));
    };
    if (!this.keyring.enabled) return finish({ error: PERMIT_ERRORS.invalid });
    const chk = checkPermit(this.keyring, p, this.now() / 1000);
    // Claims chưa xác thực chỉ dùng để lõi đối chiếu bản nháp; không dùng để quyết định gửi.
    if (chk.claims && typeof chk.claims === 'object') {
      result.nonce = typeof chk.claims.nonce === 'string' ? chk.claims.nonce : null;
      result.draft_id = chk.claims.draft_id ?? null;
    }
    if (!chk.ok) return finish({ error: chk.error });
    const s = this.sessions.get(keyOf(p.channel, p.session_id));
    if (!s || s.state !== 'active') return finish({ error: 'SESSION_NOT_ACTIVE' });
    let fresh;
    try { fresh = await this.bus.claimNonce(chk.claims.nonce); } catch (err) {
      this.log.error('không kiểm được nonce', { error: err.message });
      return finish({ error: 'NONCE_CHECK_FAILED' });
    }
    if (!fresh) return finish({ error: PERMIT_ERRORS.reused });
    try {
      const id = await s.adapter.send(p.thread_id, p.thread_type, p.text);
      const extra = { ok: true };
      if (id) extra.external_msg_id = id;
      this.log.info('đã gửi tin', { channel: s.channel, session_id: s.sessionId });
      return finish(extra);
    } catch (err) {
      this.log.warn('nền tảng từ chối gửi', { channel: s.channel, session_id: s.sessionId, error: errorCode(err) });
      return finish({ error: 'SEND_FAILED' });
    }
  }

  // ─── heartbeat / health / shutdown ──────────────────────────────────────────

  async heartbeat() {
    const at = new Date(this.now()).toISOString();
    await this.bus.setHeartbeat(at, 45).catch((err) => this.log.error('heartbeat key lỗi', { error: err.message }));
    let latency = null;
    try { latency = await this.bus.ping(); } catch { latency = null; }
    for (const s of this.sessions.values()) {
      if (s.state !== 'active') continue;
      await this.#publish(STREAMS.status, 'heartbeat', {
        channel: s.channel, session_id: s.sessionId, latency_ms: latency, queued: s.queued,
      }, s);
    }
  }

  health() {
    return [...this.sessions.values()].map((s) => ({
      channel: s.channel, session_id: s.sessionId, state: s.state, queued: s.queued, inbound: s.inbound, dropped: s.dropped,
    }));
  }

  /** Tắt tiến trình: dừng kết nối, KHÔNG đăng xuất (lõi sẽ gửi lại session.login sau bridge.hello). */
  shutdown() {
    for (const s of [...this.sessions.values()]) {
      this.#teardown(s);
      s.adapter.close();
    }
  }
}
