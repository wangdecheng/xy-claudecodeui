/**
 * NewIssueWizard — modal for creating a new customer onsite problem.
 *
 * Behavior:
 *  - opens from IssueListSidebar's "+" button.
 *  - on open: loadConfig + loadProblems so the form starts fresh.
 *  - three required selects (Customer / Iteration / Database). All
 *    disabled until config.status === 'OK'.
 *  - when selectedCustomer is the first option (branch === null), omit
 *    `third_bridge_branch` from POST /problems (server treats explicit
 *    null differently from missing — see problem.service.ts).
 *  - LogUploader is optional and disabled until the problem exists.
 *  - submit → POST /problems → on success reload list and close.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { authenticatedFetch } from '../../utils/api';
import { useOnsiteStore } from '../../stores/onsiteStore';
import CustomerSelect from './CustomerSelect';
import IterationSelect from './IterationSelect';
import DatabaseSelect from './DatabaseSelect';
import NoThirdPartyHint from './NoThirdPartyHint';
import LogUploader from './LogUploader';

export interface NewIssueWizardProps {
  open: boolean;
  onClose: () => void;
}

interface CreateResponse {
  id?: string;
  error?: string;
  message?: string;
}

export default function NewIssueWizard({ open, onClose }: NewIssueWizardProps) {
  const { t } = useTranslation(['onsite', 'common']);
  const store = useOnsiteStore();
  const config = store.config;
  const loadConfig = store.loadConfig;
  const loadProblems = store.loadProblems;

  const [customer, setCustomer] = useState('');
  const [iteration, setIteration] = useState('');
  const [database, setDatabase] = useState('');
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadConfig();
    void loadProblems();
    // reset draft when reopened
    setCustomer('');
    setIteration('');
    setDatabase('');
    setErrorMsg(null);
    setCreatedId(null);
  }, [open, loadConfig, loadProblems]);

  const configOk = config?.status === 'OK';
  const customers = config?.data.customers ?? [];
  const isFirstCustomer = useMemo(() => {
    if (!customer || customers.length === 0) return false;
    return customer === customers[0]?.label;
  }, [customer, customers]);

  const canSubmit =
    configOk && customer.length > 0 && iteration.length > 0 && database.length > 0 && !creating;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const matched = customers.find((c) => c.label === customer);
    const body: Record<string, string> = {
      customer,
      iteration,
      database,
      cwd: matched?.branch ?? customer, // fallback to customer label; server validates cwd
    };
    // CRITICAL: when the customer is "no third-party", omit branch entirely.
    if (matched && matched.branch !== null) {
      body.third_bridge_branch = matched.branch;
    }

    setCreating(true);
    setErrorMsg(null);
    try {
      const res = await authenticatedFetch('/api/onsite/problems', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as CreateResponse;
      if (!res.ok) {
        setErrorMsg(json.message ?? `${t('onsite:wizard.createFailed')} (HTTP ${res.status})`);
        return;
      }
      setCreatedId(json.id ?? null);
      void loadProblems();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  return (
    <div
      data-testid="onsite-new-issue-wizard"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            {t('onsite:wizard.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('onsite:common.back', { defaultValue: 'close' })}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <CustomerSelect config={config} value={customer} onChange={setCustomer} />
        <NoThirdPartyHint visible={isFirstCustomer} />
        <IterationSelect config={config} value={iteration} onChange={setIteration} />
        <DatabaseSelect value={database} onChange={setDatabase} />

        {createdId && (
          <div
            data-testid="onsite-wizard-created"
            className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-700 dark:bg-green-900/20 dark:text-green-200"
          >
            {t('onsite:wizard.createSuccess')} — id={createdId}
          </div>
        )}

        {errorMsg && (
          <div
            data-testid="onsite-wizard-error"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {errorMsg}
          </div>
        )}

        {createdId && (
          <LogUploader problemId={createdId} />
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            {t('onsite:common.back')}
          </button>
          {!createdId && (
            <button
              type="submit"
              data-testid="onsite-wizard-submit"
              disabled={!canSubmit}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? t('onsite:common.loading') : t('onsite:wizard.submit')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}