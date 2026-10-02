import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AboutInfo } from '@gen-harness/contracts';
import { Button, Card, Icon } from '@gen-harness/ui';
import { api } from '../lib/api';
import { useGenStore } from '../gen/genStore';
import { can } from '../lib/permissions';
import { useMe } from '../lib/queries';
import { toast } from '../lib/toast';
import { CardError, SkeletonLines } from '../screens/common';
import { ScreenTitle } from '../screens/ScreenPage';
import { UpdateCard } from '../update/UpdateCard';
import { GENH_COMMANDS, diagnosticText } from './helpModel';
import { roleLabel } from '../screens/system/systemModel';

/**
 * v0.1.36 (F-46): thêm phiên bản ảnh + genh vào thông tin báo lỗi (ngay sau dòng "Phiên bản:" của `diagnosticText`) —
 * hai số có thể lệch nhau (genh cũ, ảnh mới) và người hỗ trợ cần cả hai.
 */
function withVersions(text: string, about: AboutInfo | undefined): string {
  const extra = `Phiên bản ảnh: ${about?.image_version || '—'} · genh: ${about?.genh_version ?? '—'}`;
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('Phiên bản:'));
  lines.splice(i < 0 ? 1 : i + 1, 0, extra);
  return lines.join('\n');
}

const GEN_EXAMPLES = ['Hôm nay có gì gấp?', 'Chỉ em chỗ thêm khoá Jev', 'Sao lưu ở đâu?', 'Mời nhân viên mới thế nào?'];

/** Trợ giúp / Giới thiệu (`/help`, v0.1.22 — Đợt B3). Ai đăng nhập cũng mở được. */
export function HelpPage() {
  const me = useMe();
  const about = useQuery({ queryKey: ['system', 'about'], queryFn: ({ signal }) => api.about(signal) });
  const setGenOpen = useGenStore((s) => s.setOpen);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = 'Trợ giúp · Gen-Harness';
  }, []);

  const canGuide = can(me.data, 'system.manage');
  const genOn = !!me.data?.features?.gen;
  // v0.1.28 (UX N9): trang theo vai trò — lệnh genh chạy trên máy chủ chỉ dành cho Owner (người cài), Gen chỉ hiện
  // khi vai trò có Gen; vai trò khác thấy cách nhờ Owner (đặt lại mật khẩu, mở quyền).
  const isOwner = me.data?.role?.code === 'owner';

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(withVersions(diagnosticText(about.data, me.data), about.data));
      setCopied(true);
      toast('Đã chép thông tin báo lỗi — dán vào tin nhắn gửi người hỗ trợ.');
    } catch {
      toast('Không chép được — trình duyệt chặn bộ nhớ tạm.', 'warn');
    }
  };

  return (
    <div className="screen help">
      <ScreenTitle title="Trợ giúp" description={isOwner ? "Phiên bản đang chạy, cách hỏi Gen, các lệnh genh hay dùng và cách báo lỗi." : "Phiên bản đang chạy, cách nhờ Owner khi cần và cách báo lỗi."} maxWidth={640} />
      <div className="acct-grid">
        <Card title="Giới thiệu" kicker="Gen-Harness · Genesis Harness OS" data-gen-target="help.version">
          {about.isPending ? (
            <SkeletonLines rows={3} />
          ) : about.isError ? (
            <CardError error={about.error} onRetry={() => void about.refetch()} retrying={about.isFetching} />
          ) : (
            <div className="summary help-about">
              <span className="summary__k">phiên bản</span>
              <span className="summary__v mono">{about.data.version ?? 'bản phát triển'}</span>
              {/* v0.1.36 (F-46): bản máy chủ (ảnh Docker) đang chạy và genh có thể lệch nhau — hiện cả hai. */}
              <span className="summary__k">phiên bản máy chủ</span>
              <span className="summary__v mono" data-testid="about-image-version">{about.data.image_version || '—'}</span>
              <span className="summary__k">genh</span>
              <span className="summary__v mono">{about.data.genh_version ?? '—'}</span>
              <span className="summary__k">tổ chức</span>
              <span className="summary__v">{about.data.org_name}</span>
              <span className="summary__k">múi giờ</span>
              <span className="summary__v">{about.data.timezone}</span>
              <span className="summary__k">vai trò</span>
              <span className="summary__v">{roleLabel(about.data.role.code, about.data.role.name)}</span>
            </div>
          )}
        </Card>

        {genOn ? (
          <Card title="Hỏi Gen" kicker="Trợ lý quản trị trong app" data-gen-target="help.ask_gen">
            <p className="help-text">
              Bấm nút{' '}
              <span className="help-inline-icon" aria-label="Gen">
                <Icon name="ph ph-sparkle" size={13} />
              </span>{' '}
              ở góc trên bên phải để mở khung Gen, gõ câu hỏi bằng tiếng Việt. Gen tra số liệu, mở đúng màn và khoanh sáng
              chỗ cần bấm — Gen không tự thay đổi dữ liệu.
            </p>
            <ul className="help-examples">
              {GEN_EXAMPLES.map((q) => (
                <li key={q}>“{q}”</li>
              ))}
            </ul>
            {me.data ? (
              <Button variant="secondary" icon="ph ph-sparkle" onClick={() => setGenOpen(me.data.id, true)}>
                Mở Gen
              </Button>
            ) : null}
          </Card>
        ) : null}

        {/* v0.1.30: mục "Cập nhật phần mềm" cố định (vai trò có system.manage). */}
        {canGuide ? <UpdateCard always /> : null}

        {canGuide ? (
          <Card title="Hướng dẫn kết nối" kicker="Kênh, nhóm, sàng lọc, agent, đội ngũ, sao lưu">
            <p className="help-text">Các việc thiết lập Sếp đã để sau — từng bước, làm lúc nào cũng được.</p>
            <Link className="gh-btn gh-btn--secondary help-link" to="/guide" data-gen-target="help.guide">
              <Icon name="ph ph-map-trifold" size={14} /> Mở Hướng dẫn kết nối
            </Link>
          </Card>
        ) : null}

        {isOwner ? (
          <Card title="Lệnh genh hay dùng" kicker="Chạy trên máy chủ cài Gen-Harness" data-gen-target="help.genh" padded={false}>
            <ul className="help-cmds">
              {GENH_COMMANDS.map((c) => (
                <li key={c.cmd}>
                  <code className="mono">{c.cmd}</code>
                  <span>{c.what}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card title="Cần giúp về tài khoản" kicker="Owner là người quản lý tài khoản của mọi người">
            <ul className="help-examples">
              <li>Quên mật khẩu: nhờ Owner vào Điều khiển hệ thống › Người dùng › Đặt lại mật khẩu, rồi đăng nhập bằng mật khẩu tạm Owner gửi.</li>
              <li>Cần xem thêm màn hoặc làm thêm việc: nhờ Owner mở quyền cho vai trò của bạn.</li>
              <li>Đổi mật khẩu, mã PIN của chính mình: menu tài khoản ở góc dưới bên trái › Tài khoản của tôi.</li>
            </ul>
          </Card>
        )}

        <Card title="Báo lỗi" kicker="Chép thông tin chẩn đoán — không kèm mật khẩu hay khoá">
          <p className="help-text">
            Gặp lỗi? Bấm nút dưới để chép phiên bản, trang đang mở, trình duyệt và thời điểm, rồi dán vào tin nhắn gửi người hỗ trợ kèm mô tả ngắn (đã bấm gì, thấy gì).
          </p>
          <Button variant="primary" icon={copied ? 'ph ph-check' : 'ph ph-bug'} onClick={() => void copyDiagnostics()} data-gen-target="help.report">
            {copied ? 'Đã chép thông tin' : 'Báo lỗi — chép thông tin'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
