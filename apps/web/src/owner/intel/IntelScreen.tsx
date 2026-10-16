/**
 * v0.1.59 (G2) — KHUNG của màn Tình báo (`/owner`): chỉ để route, thanh điều hướng và spec chụp ảnh chạy được trước khi màn thật
 * xong. G3 GHI ĐÈ tệp này bằng màn thật (giữ `export function IntelScreen(): JSX.Element`). Không gọi API.
 */
import { useEffect } from 'react';
import { EmptyState } from '@gen-harness/ui';

export function IntelScreen(): JSX.Element {
  useEffect(() => {
    document.title = 'Tình báo · Gen-Harness';
  }, []);
  return (
    <div className="owner-screen" data-testid="owner-frame-intel">
      <EmptyState icon="ph ph-hourglass-medium" title="Đang hoàn thiện" description="Màn này đang được dựng — Sếp quay lại sau nhé." />
    </div>
  );
}
