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
 *  - **no-third-party cwd resolution**: when matched.branch is null
 *    (e.g. "不涉及三方对接"), we send `cwd: customer` (the label).
 *    The server's `assertCwdUnderRoot` resolves that against
 *    `~/work/customer-onsite-analysis/`, which yields a path that IS
 *    under root (no `..` segment), so no throw. The directory name then
 *    becomes `YYYYMMDD-<label>`. Verified in Batch 8 I2 — not a bug.
 *  - LogUploader is optional and only rendered after the problem is created
 *    (hidden before that — was previously shown as a disabled drop-zone, but
 *    that confused users into thinking the uploader was broken).
 *  - submit → POST /problems → on success reload list (modal stays open so
 *    user can immediately upload logs).
 *
 * Layout (three-section modal, see pattern in TaskHelpModal.tsx):
 *  - header (sticky): title + X + subtitle — always visible
 *  - body (scrollable): first 4 fields laid out as a 2-col grid
 *    (Customer+Date on row 1 with 2fr/1fr; Iteration+Database on row 2);
 *    description textarea + success/error/LogUploader full width below
 *  - footer (sticky): "返回" + (创建前)"提交" — always visible
 *  This solves the prior bug where, after creation, the rendered
 *    LogUploader pushed the footer off-screen so users couldn't close
 *    the modal from the buttons.
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
  const todayIso = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const [date, setDate] = useState(todayIso);
  const [description, setDescription] = useState('');
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
    setDate(todayIso);
    setDescription('');
    setErrorMsg(null);
    setCreatedId(null);
  }, [open, loadConfig, loadProblems]);

  // ESC 关闭 modal(REQ-1.11)
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const configOk = config?.status === 'OK';
  const customers = config?.data.customers ?? [];
  const isFirstCustomer = useMemo(() => {
    if (!customer || customers.length === 0) return false;
    return customer === customers[0]?.label;
  }, [customer, customers]);

  const canSubmit =
    configOk &&
    customer.length > 0 &&
    iteration.length > 0 &&
    database.length > 0 &&
    date.length > 0 &&
    description.trim().length > 0 &&
    !creating;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const matched = customers.find((c) => c.label === customer);
    const body: Record<string, string> = {
      customer,
      iteration,
      database,
      date,
      description: description.trim().slice(0, 2000),
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
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-xl"
      >
        {/* Sticky header — 标题 + X 关闭按钮始终可见,不被滚动条吞掉 */}
        <header className="flex flex-col gap-1 border-b border-border p-5 pb-3">
          <div className="flex items-center justify-between">
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
          </div>
          <p
            data-testid="onsite-wizard-subtitle"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {t('onsite:wizard.subtitle')}
          </p>
        </header>

        {/* Scrollable body — 前 4 项两列布局(创建后 LogUploader 也不会顶飞底部按钮) */}
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
            <CustomerSelect config={config} value={customer} onChange={setCustomer} />
            <div className="flex flex-col gap-1">
              <label htmlFor="onsite-date-input" className="text-xs font-medium text-foreground">
                {t('onsite:wizard.date', { defaultValue: '问题日期' })}
              </label>
              <input
                id="onsite-date-input"
                data-testid="onsite-date-input"
                type="date"
                value={date}
                max={todayIso}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <NoThirdPartyHint visible={isFirstCustomer} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <IterationSelect config={config} value={iteration} onChange={setIteration} />
            <DatabaseSelect value={database} onChange={setDatabase} />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="onsite-description-input" className="text-xs font-medium text-foreground">
              {t('onsite:wizard.descriptionField', { defaultValue: '问题描述' })}
              <span className="ml-0.5 text-destructive">*</span>
            </label>
            <textarea
              id="onsite-description-input"
              data-testid="onsite-description-input"
              value={description}
              maxLength={2000}
              rows={4}
              placeholder={t('onsite:wizard.descriptionPlaceholder', {
                defaultValue: '尽量精确:大概时间点、用户、碰到了什么问题',
              })}
              onChange={(e) => setDescription(e.target.value)}
              className="resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {description.trim().length === 0 && (
              <span data-testid="onsite-description-required" className="text-[11px] text-amber-700 dark:text-amber-300">
                {t('onsite:wizard.descriptionRequired', { defaultValue: '问题描述为必填项' })}
              </span>
            )}
          </div>

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

          {createdId && <LogUploader problemId={createdId} />}
        </div>

        {/* Sticky footer — "返回/提交" 始终可见,创建后也能点 X 或"返回"关掉 modal */}
        <div className="flex justify-end gap-2 border-t border-border bg-card px-5 py-3">
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