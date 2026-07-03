/**
 * OnsiteWatcher — wraps chokidar to watch ONSITE_ROOT for problem-directory
 * changes. Coalesces a burst of file events into one `problems:changed`
 * callback per ~1 second.
 *
 * Why a debounce: chokidar fires a flurry of events for every save
 * (atomic-rename yields add+unlink, editor saves yield multiple change
 * events, etc). Without debouncing, every save would trigger a redundant
 * DB roundtrip and a WS broadcast.
 *
 * Usage:
 *   startOnsiteWatcher();              // begins watching ONSITE_ROOT
 *   const off = onWatcherChange(cb);   // subscribe; returns unsubscribe
 *   ...
 *   stopOnsiteWatcher();               // tear down
 */

import chokidar, { type FSWatcher } from 'chokidar';

import { resolveOnsiteRoot } from './problem.service.js';

const DEBOUNCE_MS = 1000;

let activeWatcher: FSWatcher | null = null;
let watchedPath: string | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let pendingFire = false;

type ChangeListener = () => void | Promise<void>;
const listeners = new Set<ChangeListener>();

function fireDebounced(): void {
  pendingFire = true;
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (!pendingFire) return;
    pendingFire = false;
    for (const listener of listeners) {
      try {
        const result = listener();
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((err: unknown) => {
            console.warn('[onsite-watcher] listener threw:', err);
          });
        }
      } catch (err: unknown) {
        console.warn('[onsite-watcher] listener threw:', err);
      }
    }
  }, DEBOUNCE_MS);
}

/**
 * Start (or restart) the watcher on ONSITE_ROOT. Idempotent: calling
 * twice in a row replaces the previous watcher.
 */
export function startOnsiteWatcher(): void {
  const root = resolveOnsiteRoot();

  if (activeWatcher && watchedPath === root) {
    return;
  }

  if (activeWatcher) {
    void activeWatcher.close().catch(() => undefined);
    activeWatcher = null;
  }

  watchedPath = root;

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    depth: 4, // YYYYMMDD-* / unpacked-* / *.log — three levels is enough
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
    ignored: [
      '**/.DS_Store',
      '**/node_modules/**',
      // Per-batch brief: ignore unpacked-*/ and analysis/ subtrees
      '**/unpacked-*/**',
      '**/analysis/**',
    ],
  });

  const onAnyEvent = () => fireDebounced();
  watcher.on('add', onAnyEvent);
  watcher.on('change', onAnyEvent);
  watcher.on('unlink', onAnyEvent);
  watcher.on('addDir', onAnyEvent);
  watcher.on('unlinkDir', onAnyEvent);

  watcher.on('error', (err: unknown) => {
    console.warn('[onsite-watcher] error:', err);
  });

  activeWatcher = watcher;
}

/**
 * Subscribe to debounced `problems:changed` notifications. Returns an
 * unsubscribe function — callers MUST invoke it on teardown to avoid
 * leaks across tests / hot-reloads.
 */
export function onWatcherChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tear down the watcher and clear all subscribers. Safe to call multiple
 * times. Callers in tests should invoke this in `finally` to avoid
 * dangling FS handles across runs.
 */
export function stopOnsiteWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingFire = false;
  if (activeWatcher) {
    void activeWatcher.close().catch(() => undefined);
    activeWatcher = null;
  }
  watchedPath = null;
  listeners.clear();
}