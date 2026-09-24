import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildScreenTree, SCREENS } from '@gen-harness/contracts';
import { autonomyTooltip, confidencePercent } from '../../src/shell/headerModel';
import { initials, roleLine } from '../../src/shell/people';
import { safeNext } from '../../src/lib/safeNext';
import { routes } from '../../src/router';

interface DesignScreen {
  key: string;
  domain: string;
  parent: string | null;
  name: string;
  en: string;
  title: string;
  subtitle: string;
}
const design: DesignScreen[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../docs/design/screens.json'), 'utf8'),
);

describe('screen registry', () => {
  it('matches docs/design/screens.json key for key', () => {
    expect(SCREENS.filter((s) => !s.extra).map((s) => s.key)).toEqual(design.map((d) => d.key));
    for (const d of design) {
      const s = SCREENS.find((x) => x.key === d.key)!;
      expect(s.name).toBe(d.name);
      expect(s.en).toBe(d.en);
      expect(s.title).toBe(d.title);
      expect(s.subtitle).toBe(d.subtitle);
      expect(s.parent).toBe(d.parent);
      expect(s.domain).toBe(d.domain === 'Kinh doanh' ? 'business' : 'tech');
    }
  });

  it('builds one route per screen, nested domain › group › screen', () => {
    const paths: string[] = [];
    const walk = (rs: typeof routes, depth: string[]) =>
      rs.forEach((r) => {
        if (r.path && !r.path.startsWith('/') && r.path !== '*') paths.push([...depth, r.path].join(' > '));
        if (r.children) walk(r.children, r.id ? [...depth, r.id] : depth);
      });
    walk(routes, []);
    expect(paths).toHaveLength(24); // 21 màn thiết kế + 3 màn spec bổ sung (tasks, documents, deals)
    expect(paths).toContain('domain:business > group:Hàng đợi & Hành động > inbox');
    expect(paths).toContain('domain:business > graph');
    expect(paths).toContain('domain:business > group:Bản đồ quan hệ > profile');
    expect(paths).toContain('domain:tech > system');
    expect(buildScreenTree().map((d) => d.entries.length)).toEqual([7, 4]); // + Tài liệu (cấp 1, spec bổ sung)
  });
});

describe('header + footer helpers', () => {
  it('autonomy tooltip mirrors the design text', () => {
    expect(autonomyTooltip(4)).toBe('Mức tự trị hiện tại — mức 4: soạn sẵn chờ duyệt (thang 0–6)');
  });
  it('data confidence accepts a fraction or a percent', () => {
    expect(confidencePercent(0.78)).toBe(78);
    expect(confidencePercent(78)).toBe(78);
    expect(confidencePercent(null)).toBeNull();
  });
  it('avatar initials skip the honorific and nickname', () => {
    expect(initials('Anh Cơ La (Ryan)')).toBe('CL');
    expect(initials('Chị Lan Phạm')).toBe('LP');
    expect(initials('Ryan')).toBe('R');
  });
  it('owner role line matches the design', () => {
    expect(roleLine({ role: { code: 'owner', name: 'Owner — Sếp' } })).toBe('Owner · thấy toàn cảnh');
    expect(roleLine({ role: { code: 'auditor', name: 'Auditor' } })).toBe('Auditor');
  });
  it('login ?next= only accepts in-app paths', () => {
    expect(safeNext('/inbox?tab=all')).toBe('/inbox?tab=all');
    expect(safeNext('//evil.example')).toBe('/overview');
    expect(safeNext('https://evil.example')).toBe('/overview');
    expect(safeNext(null)).toBe('/overview');
  });
});
