import { Icon } from '@gen-harness/ui';

/**
 * The design names `ph-radar`, which Phosphor 2.1 does not ship, so the design
 * itself renders an empty glowing tile. LOGO_ICON keeps that class so the
 * product matches the design pixel-for-pixel; swap it for a real glyph once the
 * owner picks one (see the phase-1 report).
 */
export const LOGO_ICON = 'ph ph-radar';

export function Logo({ wide }: { wide: boolean }) {
  return (
    <div className="sb-logo">
      <div className="sb-logo__tile" aria-hidden>
        <Icon name={LOGO_ICON} size={15} />
      </div>
      {wide ? (
        <div className="sb-logo__text">
          <div className="sb-logo__name">GEN&#8209;HARNESS</div>
          <div className="sb-logo__sub">Genesis Harness OS · v2.2</div>
        </div>
      ) : (
        <span className="visually-hidden">Gen-Harness</span>
      )}
    </div>
  );
}
