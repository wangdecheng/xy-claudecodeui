/**
 * NoThirdPartyHint — amber banner shown when the selected customer is
 * the first option (= "不涉及三方对接" / "no third-party branch").
 *
 * Semantics (server contract, see config.service.ts):
 *   config.data.customers[0].branch === null
 *
 * Behavior:
 *   - When shown, NewIssueWizard MUST omit the `third_bridge_branch`
 *     field from POST /problems (server validation treats an explicit
 *     null differently from "missing"). The wizard handles that.
 *   - This component only renders the visible hint.
 */

import { useTranslation } from 'react-i18next';

export interface NoThirdPartyHintProps {
  visible: boolean;
  className?: string;
}

export default function NoThirdPartyHint({ visible, className }: NoThirdPartyHintProps) {
  const { t } = useTranslation(['onsite']);
  if (!visible) return null;

  return (
    <div
      data-testid="onsite-no-third-party-hint"
      className={
        'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200 ' +
        (className ?? '')
      }
    >
      <strong className="font-semibold">{t('onsite:wizard.noThirdParty')}: </strong>
      {t('onsite:wizard.thirdPartyHint')}
    </div>
  );
}