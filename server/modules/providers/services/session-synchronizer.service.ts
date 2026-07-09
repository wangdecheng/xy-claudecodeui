import { scanStateDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  failures: string[];
};

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 *
 * `userId` 必传：从 caller 解析（HTTP 路由 `req.user.id` / watcher
 * `usersDb.getFirstUser().id`）后一路下传到 provider 同步器再到
 * `createSession`，防止历史 session 因 user_id NULL 而被按用户过滤掉。
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers and updates scan_state.last_scanned_at.
   *
   * `userId` 必传：每个 provider 同步器用同一个 userId 绑定新会话。
   */
  async synchronizeSessions(userId: number): Promise<SessionSynchronizeResult> {
    const lastScanAt = scanStateDb.getLastScannedAt();
    const scanBoundary = new Date();
    const processedByProvider: Record<LLMProvider, number> = {
      claude: 0,
      codex: 0,
      cursor: 0,
      gemini: 0,
      opencode: 0,
    };
    const failures: string[] = [];

    const results = await Promise.allSettled(
      providerRegistry.listProviders().map(async (provider) => ({
        provider: provider.id,
        processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined, userId),
      }))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        processedByProvider[result.value.provider] = result.value.processed;
        continue;
      }

      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(reason);
    }

    if (failures.length === 0) {
      scanStateDb.updateLastScannedAt(scanBoundary);
    } else {
      console.warn(
        `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
      );
    }

    return {
      processedByProvider,
      failures,
    };
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   *
   * `userId` 必传：watcher 解析后透传到 provider 同步器再到
   * `createSession`。
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string,
    userId: number,
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath, userId);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
