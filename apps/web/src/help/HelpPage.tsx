import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Icon } from '@gen-harness/ui';
import { api } from '../lib/api';
import { useGenStore } from '../gen/genStore';
import { can } from '../lib/permissions';
import { useMe } from '../lib/queries';
import { toast } from '../lib/toast';
import { CardError, SkeletonLines } from '../screens/common';
import { ScreenTitle } from '../screens/ScreenPage';
import { GENH_COMMANDS, diagnosticText } from './helpModel';

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

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticText(about.data, me.data));
      setCopied(true);
      toast('Đã chép thông tin báo lỗi — dán vào tin nhắn gửi người hỗ trợ.');
    } catch {
      toast('Không chép được — trình duyệt chặn bộ nhớ tạm.', 'warn');
    }
  };

  return (
    <div className="screen help">
      <ScreenTitle title="Trợ giúp" description="Phiên bản đang chạy, cách hỏi Gen, các lệnh genh hay dùng và cách báo lỗi." maxWidth={640} />
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
              <span className="summary__k">tổ chức</span>
              <span className="summary__v">{about.data.org_name}</span>
              <span className="summary__k">múi giờ</span>
              <span className="summary__v">{about.data.timezone}</span>
              <span className="summary__k">vai trò</span>
              <span className="summary__v">{about.data.role.name}</span>
            </div>
          )}
        </Card>

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
          {genOn && me.data ? (
            <Button variant="secondary" icon="ph ph-sparkle" onClick={() => setGenOpen(me.data.id, true)}>
              Mở Gen
            </Button>
          ) : (
            <p className="muted-note">Gen chưa bật cho vai trò của bạn.</p>
          )}
        </Card>

        {canGuide ? (
          <Card title="Hướng dẫn kết nối" kicker="Kênh, nhóm, sàng lọc, agent, đội ngũ, sao lưu">
            <p className="help-text">Các việc thiết lập Sếp đã để sau — từng bước, làm lúc nào cũng được.</p>
            <Link className="gh-btn gh-btn--secondary help-link" to="/guide" data-gen-target="help.guide">
              <Icon name="ph ph-map-trifold" size={14} /> Mở Hướng dẫn kết nối
            </Link>
          </Card>
        ) : null}

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
