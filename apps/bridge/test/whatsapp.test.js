import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppAdapter, memoryAuthState } from '../src/channels/whatsapp.js';
import { STREAMS } from '../src/envelope.js';
import { BufferJSON, ctl, makeBaileysLib, setup, tick, waitFor, waMessage } from './fakes.js';

function adapter() {
  const a = new WhatsAppAdapter({ lib: makeBaileysLib().lib, sessionId: 'w1' });
  a.own = { jid: '84909999999@s.whatsapp.net', lid: '7777@lid', name: 'Kho Gen' };
  return a;
}

test('chuẩn hoá: tin văn bản trong nhóm (conversation)', () => {
  const a = adapter();
  a.groupNames.set('120363@g.us', 'Nhóm kho');
  const p = a.normalise(waMessage());
  assert.deepEqual({ ...p, payload: undefined }, {
    channel: 'whatsapp', session_id: 'w1', external_msg_id: 'ABCD1', external_group_id: '120363@g.us', group_name: 'Nhóm kho',
    sender_external_id: '84901111111@s.whatsapp.net', sender_name: 'Minh', sender_phone: '+84901111111',
    occurred_at: new Date(1758600000 * 1000).toISOString(), kind: 'text', body_text: 'chào cả nhà',
    direction: 'inbound', mentions_self: false, payload: undefined,
  });
  assert.equal(p.payload.key.remoteJid, '120363@g.us');
  assert.equal(p.payload.message.conversation, 'chào cả nhà');
});

test('chuẩn hoá: extendedTextMessage có nhắc tới mình (jid có thiết bị / lid)', () => {
  const a = adapter();
  const p = a.normalise(waMessage({ message: { extendedTextMessage: { text: '@Kho kiểm hàng', contextInfo: { mentionedJid: ['84909999999:3@s.whatsapp.net'] } } } }));
  assert.deepEqual([p.kind, p.body_text, p.mentions_self], ['text', '@Kho kiểm hàng', true]);
  const byLid = a.normalise(waMessage({ message: { extendedTextMessage: { text: 'x', contextInfo: { mentionedJid: ['7777@lid'] } } } }));
  assert.equal(byLid.mentions_self, true);
  const other = a.normalise(waMessage({ message: { extendedTextMessage: { text: 'x', contextInfo: { mentionedJid: ['8411@s.whatsapp.net'] } } } }));
  assert.equal(other.mentions_self, false);
});

test('chuẩn hoá: ảnh, sticker, tệp, reaction, 1-1, tin của mình, bọc ephemeral, bỏ status/protocol', () => {
  const a = adapter();
  const img = a.normalise(waMessage({ message: { imageMessage: { caption: 'hàng về', mimetype: 'image/jpeg', mediaKey: new Uint8Array([1, 2, 3]) } } }));
  assert.deepEqual([img.kind, img.body_text], ['image', 'hàng về']);
  assert.equal(img.payload.message.imageMessage.mediaKey, 'AQID'); // Uint8Array → base64
  const noCap = a.normalise(waMessage({ message: { imageMessage: { mimetype: 'image/jpeg' } } }));
  assert.equal(noCap.body_text, null);

  const st = a.normalise(waMessage({ message: { stickerMessage: { mimetype: 'image/webp' } } }));
  assert.deepEqual([st.kind, st.body_text], ['sticker', null]);

  const doc = a.normalise(waMessage({ message: { documentMessage: { fileName: 'hoa-don.pdf' } } }));
  assert.deepEqual([doc.kind, doc.body_text], ['file', 'hoa-don.pdf']);

  const rx = a.normalise(waMessage({ message: { reactionMessage: { key: { id: 'ABCD0' }, text: '👍' } } }));
  assert.deepEqual([rx.kind, rx.body_text], ['reaction', '👍']);

  const direct = a.normalise(waMessage({ remoteJid: '84903333333@s.whatsapp.net', participant: null }));
  assert.equal(direct.external_group_id, null);
  assert.equal(direct.sender_external_id, '84903333333@s.whatsapp.net');
  assert.equal(direct.sender_phone, '+84903333333');

  const lidDirect = a.normalise({ key: { remoteJid: '5555@lid', remoteJidAlt: '84904444444@s.whatsapp.net', fromMe: false, id: 'L1' }, pushName: 'Hà', message: { conversation: 'hi' }, messageTimestamp: 1758600000 });
  assert.equal(lidDirect.sender_external_id, '5555@lid');
  assert.equal(lidDirect.sender_phone, '+84904444444');

  const mine = a.normalise(waMessage({ fromMe: true, pushName: undefined }));
  assert.equal(mine.direction, 'outbound');
  assert.equal(mine.sender_external_id, '84909999999@s.whatsapp.net');
  assert.equal(mine.sender_name, 'Kho Gen');

  const eph = a.normalise(waMessage({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'tự huỷ' } } } } }));
  assert.deepEqual([eph.kind, eph.body_text], ['text', 'tự huỷ']);

  const withSkd = a.normalise(waMessage({ message: { senderKeyDistributionMessage: { groupId: 'x' }, conversation: 'kèm khoá' } }));
  assert.equal(withSkd.body_text, 'kèm khoá');

  assert.equal(a.normalise(waMessage({ remoteJid: 'status@broadcast' })), null);
  assert.equal(a.normalise(waMessage({ message: { protocolMessage: { type: 3 } } })), null);
  assert.equal(a.normalise(waMessage({ message: { protocolMessage: { type: 0, key: { id: 'x' } } } })).kind, 'system');
  assert.equal(a.normalise({ ...waMessage({ message: null }), messageStubType: 27 }).kind, 'system');
});

test('trạng thái xác thực trong RAM: tuần tự hoá ↔ khôi phục, keys get/set', async () => {
  const { lib } = makeBaileysLib();
  const a = memoryAuthState(lib, null);
  a.state.creds.me = { id: '849@s.whatsapp.net' };
  await a.state.keys.set({ 'pre-key': { 1: { public: Buffer.from([9]) }, 2: null }, session: { x: Buffer.from('s') } });
  const ser = a.serialize();
  assert.deepEqual(JSON.parse(JSON.stringify(ser)), ser); // JSON thuần
  const b = memoryAuthState(lib, ser);
  assert.deepEqual(b.state.creds.noiseKey.public, Buffer.from([1, 2, 3]));
  assert.deepEqual(await b.state.keys.get('pre-key', ['1', '2']), { 1: { public: Buffer.from([9]) }, 2: null });
  assert.deepEqual((await b.state.keys.get('session', ['x'])).x, Buffer.from('s'));
  assert.equal(BufferJSON.replacer('', Buffer.from([1])).type, 'Buffer');
});

test('QR: mỗi mã qr → session.qr data URL; ghép cặp → scanned; restartRequired → nối lại; open → active', async () => {
  const { bus, mgr, keyring, wa } = await setup();
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w1', credential: null }));
  const sock = await waitFor(() => wa.ctrl.last());
  assert.equal(sock.config.printQRInTerminal, false);
  assert.equal(sock.config.markOnlineOnConnect, false);
  sock.ev.emit('connection.update', { qr: '2@abc,def,ghi' });
  const qr = await waitFor(() => bus.of(STREAMS.status, 'session.qr')[0]);
  assert.match(qr.payload.image, /^data:image\/png;base64,/);
  assert.equal(qr.actor, 'bridge:whatsapp');

  sock.config.auth.creds.me = { id: '84909999999:3@s.whatsapp.net', name: 'Kho Gen' };
  sock.ev.emit('connection.update', { isNewLogin: true, qr: undefined });
  const sc = await waitFor(() => bus.of(STREAMS.status, 'session.scanned')[0]);
  assert.equal(sc.payload.display_name, 'Kho Gen');
  sock.close(515);
  await waitFor(() => wa.ctrl.sockets.length === 2);
  const sock2 = wa.ctrl.last();
  assert.equal(sock2.config.auth.creds, sock.config.auth.creds); // cùng trạng thái trong RAM
  sock2.open();
  const act = await waitFor(() => bus.of(STREAMS.status, 'session.active')[0]);
  assert.deepEqual(act.payload.account, { id: '84909999999@s.whatsapp.net', name: 'Kho Gen', phone: '+84909999999' });
  const cred = JSON.parse(keyring.decryptTransport(act.payload.credential, 'whatsapp:w1'));
  assert.equal(cred.creds.me.id, '84909999999:3@s.whatsapp.net');
  assert.deepEqual(cred.creds.noiseKey.public, { type: 'Buffer', data: 'AQID' });
  const dir = await waitFor(() => bus.of(STREAMS.directory, 'groups')[0]);
  assert.deepEqual(dir.payload.groups[0].members, [
    { external_id: '84901111111@s.whatsapp.net', name: '', phone: '+84901111111' },
    { external_id: '5555@lid', name: '', phone: '+84902222222' },
  ]);
  mgr.shutdown();
});

test('QR: 5 mã hết hạn → session.ended expired (kể cả khi socket hết lượt ref)', async () => {
  const { bus, mgr, wa } = await setup();
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w1', credential: null }));
  const s1 = await waitFor(() => wa.ctrl.last());
  for (let i = 1; i <= 3; i += 1) s1.ev.emit('connection.update', { qr: `ref${i}` });
  await waitFor(() => bus.of(STREAMS.status, 'session.qr').length === 3);
  s1.close(408); // "QR refs attempts ended" → socket mới
  await waitFor(() => wa.ctrl.sockets.length === 2);
  const s2 = wa.ctrl.last();
  s2.ev.emit('connection.update', { qr: 'ref4' });
  s2.ev.emit('connection.update', { qr: 'ref5' });
  await waitFor(() => bus.of(STREAMS.status, 'session.qr').length === 5);
  s2.ev.emit('connection.update', { qr: 'ref6' }); // mã thứ 5 đã hết hạn
  const ended = await waitFor(() => bus.of(STREAMS.status, 'session.ended')[0]);
  assert.deepEqual(ended.payload, { channel: 'whatsapp', session_id: 'w1', reason: 'expired', error: 'QR_EXPIRED' });
  assert.equal(bus.of(STREAMS.status, 'session.qr').length, 5);
  assert.ok(s2.ended >= 1);
});

test('resume bằng credential; creds.update gộp → session.credential; loggedOut → expired', async () => {
  const { bus, mgr, keyring, wa } = await setup({ credentialCoalesceMs: 40 });
  const { lib } = makeBaileysLib();
  const st = memoryAuthState(lib, null);
  st.state.creds.me = { id: '84909999999:3@s.whatsapp.net', name: 'Kho Gen' };
  const blob = keyring.encryptTransport(JSON.stringify(st.serialize()), 'whatsapp:w1');
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w1', credential: blob }));
  const sock = await waitFor(() => wa.ctrl.last());
  assert.equal(sock.config.auth.creds.me.id, '84909999999:3@s.whatsapp.net');
  sock.open();
  await waitFor(() => bus.of(STREAMS.status, 'session.active')[0]);
  for (let i = 0; i < 5; i += 1) {
    sock.config.auth.creds.accountSyncCounter = i;
    sock.ev.emit('creds.update', { accountSyncCounter: i });
  }
  await tick(15);
  assert.equal(bus.of(STREAMS.status, 'session.credential').length, 0);
  const c = await waitFor(() => bus.of(STREAMS.status, 'session.credential')[0]);
  await tick(60);
  assert.equal(bus.of(STREAMS.status, 'session.credential').length, 1);
  assert.equal(JSON.parse(keyring.decryptTransport(c.payload.credential, 'whatsapp:w1')).creds.accountSyncCounter, 4);

  sock.close(401);
  const ended = await waitFor(() => bus.of(STREAMS.status, 'session.ended')[0]);
  assert.deepEqual([ended.payload.reason, ended.payload.error], ['expired', 'LOGGED_OUT_REMOTELY']);
  assert.equal(mgr.health().length, 0);
});

test('resume: credential chưa ghép cặp hoặc bị máy chủ từ chối → expired', async () => {
  const { bus, mgr, keyring, wa } = await setup();
  const { lib } = makeBaileysLib();
  const unpaired = keyring.encryptTransport(JSON.stringify(memoryAuthState(lib, null).serialize()), 'whatsapp:w1');
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w1', credential: unpaired }));
  const e1 = await waitFor(() => bus.of(STREAMS.status, 'session.ended')[0]);
  assert.deepEqual([e1.payload.reason, e1.payload.error], ['expired', 'CREDENTIAL_INVALID']);

  const st = memoryAuthState(lib, null);
  st.state.creds.me = { id: '849:1@s.whatsapp.net' };
  const paired = keyring.encryptTransport(JSON.stringify(st.serialize()), 'whatsapp:w2');
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w2', credential: paired }));
  const sock = await waitFor(() => wa.ctrl.last());
  sock.close(401);
  const e2 = await waitFor(() => bus.of(STREAMS.status, 'session.ended').find((e) => e.payload.session_id === 'w2'));
  assert.deepEqual([e2.payload.reason, e2.payload.error], ['expired', 'CREDENTIAL_REJECTED']);
});

test('mất kết nối tạm thời → nối lại, không phát ended; logout → sock.logout + logged_out', async () => {
  const { bus, mgr, keyring, wa } = await setup();
  const { lib } = makeBaileysLib();
  const st = memoryAuthState(lib, null);
  st.state.creds.me = { id: '849:1@s.whatsapp.net' };
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w1',
    credential: keyring.encryptTransport(JSON.stringify(st.serialize()), 'whatsapp:w1') }));
  const s1 = await waitFor(() => wa.ctrl.last());
  s1.open();
  await waitFor(() => bus.of(STREAMS.status, 'session.active')[0]);
  s1.close(428);
  await waitFor(() => wa.ctrl.sockets.length === 2);
  const s2 = wa.ctrl.last();
  s2.open();
  await tick(5);
  assert.equal(bus.of(STREAMS.status, 'session.active').length, 1);
  assert.equal(bus.of(STREAMS.status, 'session.ended').length, 0);

  await mgr.handleControl(ctl('session.logout', { channel: 'whatsapp', session_id: 'w1' }));
  assert.equal(s2.loggedOut, 1);
  assert.ok(s2.ended >= 1);
  const ended = bus.of(STREAMS.status, 'session.ended');
  assert.deepEqual(ended.map((e) => e.payload.reason), ['logged_out']);
  s2.close(401); // sự kiện muộn sau logout bị bỏ qua
  await tick(5);
  assert.equal(bus.of(STREAMS.status, 'session.ended').length, 1);
});

test('messages.upsert: chỉ type notify; gửi tin trả key.id', async () => {
  const { bus, mgr, keyring, wa } = await setup();
  bus.listen.whatsapp = new Set(['120363@g.us']);
  const { lib } = makeBaileysLib();
  const st = memoryAuthState(lib, null);
  st.state.creds.me = { id: '849:1@s.whatsapp.net' };
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w1',
    credential: keyring.encryptTransport(JSON.stringify(st.serialize()), 'whatsapp:w1') }));
  const sock = await waitFor(() => wa.ctrl.last());
  sock.open();
  await waitFor(() => bus.of(STREAMS.status, 'session.active')[0]);
  sock.ev.emit('messages.upsert', { type: 'append', messages: [waMessage({ id: 'H1' })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [waMessage({ id: 'N1' }), waMessage({ id: 'N1' })] });
  await waitFor(() => bus.of(STREAMS.inbound).length === 1);
  await tick(5);
  assert.deepEqual(bus.of(STREAMS.inbound).map((e) => e.payload.external_msg_id), ['N1']);
  const a = mgr.sessions.get('whatsapp:w1').adapter;
  assert.equal(await a.send('120363@g.us', 'group', 'ok'), '3EB01');
  assert.deepEqual(sock.sent, [{ jid: '120363@g.us', content: { text: 'ok' } }]);
  mgr.shutdown();
});
