/**
 * OnsiteNavButton — sidebar entry for the Customer Onsite Analysis feature.
 *
 * Per the Batch 6 brief, this is a NEW component (not a Sidebar.tsx
 * modification) so the existing sidebar logic stays untouched. The
 * orchestrator wires it in AppContent alongside <Sidebar />.
 *
 * Behavior:
 *  - onClick → navigate('/onsite')
 *  - active when the current pathname starts with `/onsite` (matches both
 *    `/onsite` and `/onsite/:problemId`)
 */

import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Compass } from 'lucide-react';

import { cn } from '../../../lib/utils';

export interface OnsiteNavButtonProps {
  /** Optional click override (mostly for tests). */
  onClick?: () => void;
  /** When true, render the icon-only variant (e.g. collapsed sidebar). */
  collapsed?: boolean;
  className?: string;
}

export default function OnsiteNavButton({
  onClick,
  collapsed = false,
  className,
}: OnsiteNavButtonProps) {
  const { t } = useTranslation(['onsite', 'common']);
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = location.pathname === '/onsite' || location.pathname.startsWith('/onsite/');

  const handleClick = () => {
    if (onClick) {
      onClick();
      return;
    }
    navigate('/onsite');
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t('onsite:nav.onsite')}
      aria-current={isActive ? 'page' : undefined}
      data-testid="onsite-nav-button"
      data-active={isActive ? 'true' : 'false'}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
        isActive
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      <Compass className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      {!collapsed && (
        <span className="truncate">{t('onsite:nav.onsite')}</span>
      )}
    </button>
  );
}