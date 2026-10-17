/**
 * v0.1.70 (E1): câu chữ sạch ở web — tên màn "API & Model" (không chỉ đường bằng tên nhóm menu "Agent & Model"),
 * «khoá» (không «khóa»), Sức khoẻ hệ thống ở Hôm nay dùng tên kênh đúng và bỏ kênh chỉ đọc, Hạn lưu dữ liệu
 * không dùng chữ "Kho" của Kho dữ liệu cho tin nhắn, múi giờ nói đúng việc nào theo giờ Việt Nam.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODEL_UNAVAILABLE_TEXT } from '../../src/lib/friendlyError';
import { EMPTY_AGENTS_TEXT, EMPTY_AGENTS_TEXT_ASK } from '../../src/lib/pickers';
import { healthChannelRows } from '../../src/screens/queue/queueModel';
import { RETENTION_LABEL } from '../../src/screens/system/systemModel';

const SRC = resolve(__dirname, '../../src');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe('tên màn "API & Model"', () => {
  it('câu lỗi và câu chỉ đường không còn "Agent & Model"', () => {
    for (const t of [MODEL_UNAVAILABLE_TEXT, EMPTY_AGENTS_TEXT, EMPTY_AGENTS_TEXT_ASK]) expect(t).not.toContain('Agent & Model');
    expect(MODEL_UNAVAILABLE_TEXT).toContain('API & Model');
    expect(EMPTY_AGENTS_TEXT).toContain('Danh tính Agent');
  });
});

describe('«khoá», không «khóa»', () => {
  it('thẻ Jev', () => {
    expect(read('screens/system/JevCard.tsx')).not.toMatch(/[Kk]hóa/);
    expect(read('screens/system/jevModel.ts')).not.toMatch(/[Kk]hóa/);
  });
});

describe('Hôm nay › Sức khoẻ hệ thống — dòng kênh', () => {
  it('tên đẹp cho mọi kênh, bỏ kênh chỉ đọc (LinkedIn), giữ thứ tự máy chủ trả', () => {
    const rows = healthChannelRows([
      { type: 'zalo', active: 1 },
      { type: 'whatsapp', active: 0 },
      { type: 'telegram', active: 0 },
      { type: 'linkedin', active: 0 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Kênh Zalo', 'Kênh WhatsApp', 'Kênh Telegram']);
    expect(rows.map((r) => r.active)).toEqual([1, 0, 0]);
  });
  it('kênh lạ: viết hoa chữ đầu, không in khoá thô chữ thường', () => {
    expect(healthChannelRows([{ type: 'viber', active: 0 }]).map((r) => r.name)).toEqual(['Kênh Viber']);
  });
});

describe('Hạn lưu dữ liệu', () => {
  it('nhãn không mượn chữ "Kho" (Kho dữ liệu của Sếp là thứ khác)', () => {
    for (const label of Object.values(RETENTION_LABEL)) expect(label).not.toMatch(/\bKho\b/);
    expect(RETENTION_LABEL['raw.events']).toMatch(/^Tin gốc/);
    expect(RETENTION_LABEL['clean.meaning_units']).toMatch(/^Tin đã lọc/);
  });
});

describe('Cài đặt › Tổ chức', () => {
  it('nói rõ Bản tin, chi phí AI và dọn dữ liệu luôn theo giờ Việt Nam', () => {
    expect(read('screens/system/OrgTab.tsx')).toMatch(/Bản tin Gen[^<]*chi phí AI[^<]*giờ Việt Nam/);
  });
});
