# Progress Ledger: customer-onsite-analysis-ui

> 跟踪 spec-superflow SDD 执行进度。
> 每完成一个 Task + review 干净,追加一行。

| Task | 状态 | Commits | 备注 |
|------|------|---------|------|
| Task 0.1 | complete(review approved) | 14af19b | `scripts/regression-chat.sh` + 5 个测试;real run: 78 pass / 1 fail / 8862 ms |
| Task 0.2 | complete(review approved) | 14af19b + 9318b69 | `scripts/diff-chat-impact.sh` + 5 个测试 + `.github/workflows/regression.yml` |

## Review Verdict — Batch 0

- **Verdict**: ✅ Approved
- **Critical**: 0
- **Important**: 4(全部为健壮性,非阻塞)
- **Minor**: 7(可后续 follow-up)

### 后续 follow-up(Important 4 条)

1. `regression-chat.test.ts` race condition in baseline-restore test cleanup
2. `regression-chat.sh` 用 `awk sum` 而非 last-value 解析多文件测试输出(fragile)
3. `diff-chat-impact.sh` word-splitting via unquoted `${BASE_SHA}..${HEAD_SHA}`(lint warning)
4. Workflow yml step 1 exit handling inconsistency(实际无害)

### 后续 follow-up(Minor 7 条)

- `tsx --test` reporter ℹ 符号变化会 break 解析 → 考虑 `--test-reporter=tap`
- `case "--nonsense*)` 是 dead code
- `bash` 硬编码(WIN 不友好)
- 无 `shellcheck` CI step
- placeholder commit SHA 不可达
- 无 `--version`
- `CRITICAL_PATTERNS` 中 `sessions` 缺 `/`

## 状态

- **Workflow**: `full`
- **Mode**: `SDD`
- **Contract**: 已批准(2026-07-03)
- **Batches Completed**: 0 / 9(Batch 0~8;Batch 5.5 后置)
- **当前 commit**: `9318b69`(Batch 0 done)
- **Pre-existing failure**: `provider-models.service.test.ts` 在 main 上 fail(与 chat 路径无关);Batch 5.5 baseline diff 会捕获此 fail 计数,Batch 8 验收前需修

## Review 节点

- [x] Batch 0 收尾 → 进 Batch 1
- [ ] Batch 2 收尾 → 进 Batch 3(schema 改动不可逆)
- [ ] Batch 4 收尾 → 进 Batch 5(纪律护栏核心)
- [ ] Batch 5.5 收尾 → 进 Batch 6(chat 回归门禁)
- [ ] Batch 7 收尾 → 进 Batch 8
- [ ] Batch 8 收尾 → 进 release-archivist
