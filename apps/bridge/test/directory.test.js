// v0.1.65 (F1a) — danh bạ: thu thành viên MỌI nhóm (kể cả "Không nghe"), vai trò admin, cờ "danh sách đủ", giãn cách,
// nhóm mới báo `group.discovered` (không lưu tin), quét lại có giới hạn tần suất, lệnh directory.sync dùng chung một lượt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREAMS } from '../src/envelope.js';
import { ZaloAdapter } from '../src/channels/zalo.js';
import { WhatsAppAdapter } from '../src/channels/whatsapp.js';
import { createLogger } from '../src/log.js';
import {
  ctl, makeBaileysLib, makeZaloApi, makeZaloLib, setup, tick, waitFor, zaloMessage, waMessage,
} from './fakes.js';

const GROUPS = {
  G1: { name: 'Nhóm sỉ', totalMember: 3, creatorId: '111', adminIds: ['222'], memVerList: ['111_0', '222_0', '333_0'] },
  G2: { name: 'Nội bộ (Không nghe)', totalMember: 2, memVerList: ['444_0', '555_0'] },
};

async function loginZalo(api, opts = {}) {
  const env = await setup({ zalo: makeZaloLib({ api }), ...opts });
  const blob = env.keyring.encryptTransport(JSON.stringify({ imei: 'i', cookie: [], userAgent: 'u' }), 'zalo:s1');
  await env.mgr.handleControl(ctl('session.login', { channel: 'zalo', session_id: 's1', credential: blob }));
  await waitFor(() => env.bus.of(STREAMS.status, 'session.active')[0]);
  return env;
}

test('Zalo: thu thành viên MỌI nhóm kể cả nhóm không nằm trong tập nghe; creator/admin có role, nhóm không có thông tin thì không gán role', async () => {
  const api = makeZaloApi({ groups: GROUPS });
  const { bus, mgr } = await loginZalo(api);
  const dir = await waitFor(() => bus.of(STREAMS.directory, 'groups')[0]);
  assert.equal(bus.listen.zalo, undefined); // không nhóm nào trong tập nghe
  const [g1, g2] = dir.payload.groups;
  assert.deepEqual(g1.members.map((m) => [m.external_id, m.role]), [['111', 'admin'], ['222', 'admin'], ['333', 'member']]);
  assert.deepEqual(g2.members.map((m) => [m.external_id, m.role]), [['444', undefined], ['555', undefined]]);
  assert.equal(g2.members.length, 2);
  assert.equal(g1.members_complete, true);
  assert.equal(dir.payload.groups_complete, true);
  mgr.shutdown();
});

test('Zalo: thiếu thành viên so với số nền tảng báo ⇒ members_complete = false; nhóm lỗi getGroupInfo ⇒ groups_complete = false', async () => {
  const api = makeZaloApi({ groups: { G1: { name: 'A', totalMember: 5, memVerList: ['1_0', '2_0'] } } });
  const first = await loginZalo(api);
  const d1 = await waitFor(() => first.bus.of(STREAMS.directory, 'groups')[0]);
  assert.equal(d1.payload.groups[0].members_complete, false);
  assert.equal(d1.payload.groups_complete, true);
  first.mgr.shutdown();

  const api2 = makeZaloApi({ groups: GROUPS });
  let calls = 0;
  const real = api2.getGroupInfo;
  api2.getGroupInfo = async (ids) => { calls += 1; if (calls === 1) throw new Error('mạng'); return real(ids); };
  const second = await loginZalo(api2);
  const d2 = await waitFor(() => second.bus.of(STREAMS.directory, 'groups')[0]);
  assert.deepEqual(d2.payload.groups, []);
  assert.equal(d2.payload.groups_complete, false); // rỗng + lỗi ⇒ lõi không được coi là "rời hết"
  second.mgr.shutdown();
});

test('Zalo: có giãn cách giữa các lần hỏi nền tảng khi quét thành viên', async () => {
  const api = makeZaloApi({ groups: GROUPS });
  const stamps = [];
  const info = api.getGroupMembersInfo;
  api.getGroupMembersInfo = async (ids) => { stamps.push(Date.now()); return info(ids); };
  const a = new ZaloAdapter({ lib: makeZaloLib({ api }).lib, sessionId: 's1', directoryGapMs: 30 });
  a.api = api;
  const groups = await a.syncGroups();
  assert.equal(groups.length, 2);
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 25, `khoảng cách ${stamps[1] - stamps[0]}ms quá ngắn`);
  assert.equal(a.lastSyncComplete, true);
});

test('WhatsApp: role admin/member + cờ danh sách đủ', async () => {
  const wa = makeBaileysLib();
  const a = new WhatsAppAdapter({ lib: wa.lib, sessionId: 'w1' });
  a.sock = { groupFetchAllParticipating: async () => ({
    '1@g.us': { id: '1@g.us', subject: 'N1', size: 3, participants: [{ id: 'a@s.whatsapp.net', admin: 'superadmin' }, { id: 'b@s.whatsapp.net', admin: null }, { id: 'c@lid' }] },
    '2@g.us': { id: '2@g.us', subject: 'N2', size: 9, participants: [{ id: 'x@s.whatsapp.net', admin: 'admin' }] },
  }) };
  const [g1, g2] = await a.syncGroups();
  assert.deepEqual(g1.members.map((m) => m.role), ['admin', 'member', 'member']);
  assert.equal(g1.members_complete, true);
  assert.equal(g2.members_complete, false);
  assert.equal(a.lastSyncComplete, true);
});

test('tin từ nhóm LẠ: không lưu, phát group.discovered đúng một lần (không kèm nội dung), rồi quét lại danh bạ', async () => {
  const lines = [];
  const api = makeZaloApi({ groups: GROUPS });
  const { bus, mgr } = await loginZalo(api, { logger: createLogger((l) => lines.push(l)), discoverDelayMs: 10, discoverMinGapMs: 0 });
  await waitFor(() => bus.of(STREAMS.directory, 'groups')[0]);
  // G9 chưa có trong danh bạ vừa quét
  api.listener.emit('message', zaloMessage({ threadId: 'G9', content: 'bí mật khách lạ', msgId: '91' }));
  api.listener.emit('message', zaloMessage({ threadId: 'G9', content: 'tin thứ hai', msgId: '92' }));
  const found = await waitFor(() => bus.of(STREAMS.directory, 'group.discovered')[0]);
  assert.deepEqual(found.payload, { channel: 'zalo', session_id: 's1', group_id: 'G9', name: '', member_count: null });
  await waitFor(() => bus.of(STREAMS.directory, 'groups').length === 2); // quét lại sau khi phát hiện
  await tick(20);
  assert.equal(bus.of(STREAMS.directory, 'group.discovered').length, 1);
  assert.equal(bus.of(STREAMS.inbound).length, 0); // tin KHÔNG vào Kho
  assert.ok(!lines.some((l) => l.includes('bí mật') || l.includes('thứ hai')));
  // nhóm đã có trong danh bạ (G1, "Không nghe") bị bỏ tin nhưng KHÔNG báo lại là nhóm mới
  api.listener.emit('message', zaloMessage({ threadId: 'G1', msgId: '93' }));
  await tick(30);
  assert.equal(bus.of(STREAMS.directory, 'group.discovered').length, 1);
  assert.equal(bus.of(STREAMS.inbound).length, 0);
  mgr.shutdown();
});

test('quét lại sau phát hiện bị giới hạn tần suất: không quét hai lần trong discoverMinGapMs', async () => {
  const api = makeZaloApi({ groups: GROUPS });
  const { bus, mgr } = await loginZalo(api, { discoverDelayMs: 5, discoverMinGapMs: 400 });
  await waitFor(() => bus.of(STREAMS.directory, 'groups')[0]);
  api.listener.emit('message', zaloMessage({ threadId: 'G8', msgId: '81' }));
  await waitFor(() => bus.of(STREAMS.directory, 'group.discovered').length === 1);
  await tick(60);
  assert.equal(bus.of(STREAMS.directory, 'groups').length, 1); // chưa tới hạn: mới có lượt quét lúc đăng nhập
  mgr.shutdown();
});

test('directory.sync (nút "Cập nhật danh sách nhóm") và chu kỳ chạm nhau dùng chung MỘT lượt quét', async () => {
  const api = makeZaloApi({ groups: GROUPS });
  let scans = 0;
  const real = api.getAllGroups;
  api.getAllGroups = async () => { scans += 1; await tick(20); return real(); };
  const { bus, mgr } = await loginZalo(api);
  await waitFor(() => bus.of(STREAMS.directory, 'groups')[0]);
  const before = scans;
  await Promise.all([
    mgr.handleControl(ctl('directory.sync', { channel: 'zalo', session_id: 's1' })),
    mgr.syncDirectory(mgr.sessions.get('zalo:s1')),
  ]);
  assert.equal(scans - before, 1);
  assert.equal(bus.of(STREAMS.directory, 'groups').length, 2);
  mgr.shutdown();
});

test('WhatsApp: tin từ nhóm lạ cũng báo group.discovered (kèm tên nếu biết)', async () => {
  const { bus, mgr, wa } = await setup();
  await mgr.handleControl(ctl('session.login', { channel: 'whatsapp', session_id: 'w1', credential: null }));
  const sock = await waitFor(() => wa.ctrl.last());
  sock.config.auth.creds.me = { id: '84909999999:3@s.whatsapp.net', name: 'Kho Gen' };
  sock.ev.emit('connection.update', { isNewLogin: true, qr: undefined });
  sock.open();
  await waitFor(() => bus.of(STREAMS.directory, 'groups')[0]);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [waMessage({ remoteJid: '999@g.us', id: 'Z1' })] });
  const found = await waitFor(() => bus.of(STREAMS.directory, 'group.discovered')[0]);
  assert.equal(found.payload.group_id, '999@g.us');
  assert.equal(bus.of(STREAMS.inbound).length, 0);
  mgr.shutdown();
});
