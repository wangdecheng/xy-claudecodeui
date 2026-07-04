/**
 * onsite-path-blacklist — SDK 层硬拦截黑名单(5.1)。
 *
 * Spec:specs/discipline-write-protection.md REQ-10.x + design.md §D-7.1
 *
 * 设计:
 *  - toDisallowPatterns(globs):纯函数,把 glob 翻译成 SDK `disallowedTools`
 *    接受的字符串 pattern 列表。
 *  - 每个 glob 生成 Bash 写动作 + Write + Edit 的所有组合 pattern。
 *  - 跨 glob 自动 dedupe(同一 pattern 不重复)。
 *  - 注入点:onsite 路径 spawn Claude 前调用,chat 路径**不调**(硬保证零侵入)。
 *
 * 为什么需要这一层:
 *  Batch 4 加的 discipline-write-protection 是软审计(WS 出站路径检测 +
 *  落 discipline_log + UI 提示)。它**不阻断** Claude 实际执行 rm / sed -i。
 *  本 service 走 SDK `canUseTool` 的 `isDisallowed` 分支,是真正的硬层。
 *  软+硬两层就位后,raw-log 写动作会被双拦截(SDK 直接拒绝,即使绕过
 *  WS middleware,工具调用本身就不会被允许)。
 */

export const ONSITE_PROTECTED_GLOBS: readonly string[] = [
  '*.log',
  '*.log.gz',
  '*.jsonl',
  'unpacked-*',
  'problem.json',
  '*.tar.gz',
  '*.tgz',
] as const;

export const ONSITE_PROTECTED_GLOBS_LIST: string[] = [...ONSITE_PROTECTED_GLOBS];

// Bash 写动作的子动作(对应 soft-audit regex 的写动作子集)
// 注意:与 discipline-write-protection.middleware 的 WRITE_ACTION_REGEX 保持一致,
// 但去掉了 > 重定向(SDK 不需要拦截 >,因为 SDK 自己处理 shell 重定向);
// 也保留了 rm -rf / tee / sed -i / awk -i / cp -f / mv(SDK 接受的常见 bash 子动作)。
const BASH_WRITE_ACTIONS: readonly string[] = [
  'rm',
  'rm -rf',
  'tee',
  'sed -i',
  'awk -i',
  'cp -f',
  'mv',
] as const;

const FILE_WRITE_ACTIONS: readonly string[] = [
  'Write',
  'Edit',
] as const;

function globToWriteTargets(glob: string): string[] {
  // unpacked-* 是目录模式 — Write/Edit 针对目录内容
  if (glob === 'unpacked-*') {
    return ['**/unpacked-*/**', '**/unpacked-*'];
  }
  return [`**/${glob}`];
}

/**
 * 把 glob 翻译成 SDK disallowedTools 的字符串 pattern 列表。
 *
 * 输入:glob 数组(如 ['*.log', 'problem.json'])
 * 输出:每 glob × (Bash 写动作 + Write + Edit) 的所有 pattern,dedupe。
 *
 * 实现要点:
 *  - '*.log' → Bash(rm ** / *.log), Bash(tee ** / *.log), ...
 *              Write(** / *.log), Edit(** / *.log)
 *  - 'unpacked-*' → Bash(rm ** / unpacked-* / **),
 *                  Write(** / unpacked-* / **), Edit(** / unpacked-* / **)
 *  - 'problem.json' → Write(** / problem.json), Edit(** / problem.json)
 *  - 跨 glob dedupe(防 Write(** / *.log) 在两个 glob 里都出现)
 */
export function toDisallowPatterns(globs: readonly string[]): string[] {
  const patterns = new Set<string>();

  for (const glob of globs) {
    const targets = globToWriteTargets(glob);
    const isDir = glob === 'unpacked-*';

    // Bash 写动作 — 对每个 target 生成 pattern
    for (const action of BASH_WRITE_ACTIONS) {
      for (const target of targets) {
        // 目录模式用 /** 通配;文件模式直接用
        const finalTarget = isDir ? target : target;
        patterns.add(`Bash(${action} ${finalTarget})`);
      }
    }

    // Write/Edit — 同样对每个 target
    for (const action of FILE_WRITE_ACTIONS) {
      for (const target of targets) {
        patterns.add(`${action}(${target})`);
      }
    }
  }

  return [...patterns];
}

/**
 * 把生成的 pattern 注入到 sdkOptions.disallowedTools(若尚不存在)。
 * 纯函数,chat 路径不会调用这个函数。
 */
export function injectOnsiteBlacklist<T extends { disallowedTools?: string[] }>(
  sdkOptions: T,
  globs: readonly string[] = ONSITE_PROTECTED_GLOBS,
): T {
  const patterns = toDisallowPatterns(globs);
  sdkOptions.disallowedTools = [
    ...(sdkOptions.disallowedTools ?? []),
    ...patterns,
  ];
  return sdkOptions;
}