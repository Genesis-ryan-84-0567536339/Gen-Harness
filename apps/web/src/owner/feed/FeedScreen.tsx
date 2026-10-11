/**
 * v0.1.59 (G2) — KHUNG của màn Thông tin (`/owner/thong-tin`): chỉ để route, thanh điều hướng và spec chụp ảnh chạy được trước khi màn thật
 * xong. G4 GHI ĐÈ tệp này bằng màn thật (giữ `export function FeedScreen(): JSX.Element`). Không gọi API.
 */
import { useEffect } from 'react';
import { EmptyState } from '@gen-harness/ui';

export function FeedScreen(): JSX.Element {
  useEffect(() => {
    document.title = 'Thông tin · Gen-Harness';
  }, []);
  return (
    <div className="owner-screen" data-testid="owner-frame-feed">
      <EmptyState icon="ph ph-hourglass-medium" title="Đang hoàn thiện" description="Màn này đang được dựng — Sếp quay lại sau nhé." />
    </div>
  );
}
