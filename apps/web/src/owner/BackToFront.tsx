/**
 * v0.1.55 (G5) — nút "← Về Mặt tiền" ở đầu header của Console: CHỈ Owner thấy. Từ Mặt tiền, "Cài đặt nâng cao" và các link
 * sâu mở Console đầy đủ; nút này đưa Sếp về `/owner`. Trên điện thoại chỉ còn mũi tên (chữ vẫn là tên truy cập được).
 */
import { Link } from 'react-router-dom';
import { useMe } from '../lib/queries';
import { BACK_TO_FRONT_LABEL, OWNER_HOME } from './ownerModel';
import './owner.css';

export function BackToFront() {
  const owner = useMe().data?.role?.code === 'owner';
  if (!owner) return null;
  return (
    <Link to={OWNER_HOME} className="hd-back" aria-label={BACK_TO_FRONT_LABEL} data-testid="back-to-front">
      <span aria-hidden>←</span>
      <span className="hd-back__text" aria-hidden>
        {' '}
        {BACK_TO_FRONT_LABEL}
      </span>
    </Link>
  );
}
