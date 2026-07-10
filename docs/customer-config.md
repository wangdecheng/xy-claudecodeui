# 客户/迭代配置（Onsite Analysis）

> 新增客户 / 迭代 → 改这一个文件即可，UI 不允许手动输入。

## 真相源

**唯一配置**：`config/customer-analysis.json`

```
{
  "customers": [{ "label": "山西公安", "branch": "master_5.2_3.2" }, ...],
  "iterations": ["release_5.2_3.2_20260327", ...]
}
```

- 客户端 / 服务端都从这里读，下拉永远由它驱动。
- Schema 校验：`config/json-schemas/customer-analysis.schema.json`（首项必须是「其他问题」且 `branch=null`）。
- Lint 兜底：`scripts/validate-no-hardcoded-customers.sh` —— **禁止**在 `src/` `server/` `design-prototypes/onsite-analysis/` 三处源码里手写客户名/迭代名字面量，否则会被 CI 拦下。

## 新增客户（推荐：用脚本）

```bash
./scripts/add-customer.sh "<label>" <branch>

# 示例
./scripts/add-customer.sh "招商银行" zs_401425
./scripts/add-customer.sh --label "新客户名" --branch new-customer-branch
```

脚本行为：
1. 校验 `branch` 匹配 schema（`^[A-Za-z0-9_][A-Za-z0-9_.-]*$`，首字符字母数字下划线）
2. 去重（label 已存在则 exit 2）
3. 备份原文件到 `.bak`、jq append、JSON 自检、原子替换；失败自动回滚
4. 打印后续 checklist

跑完后**必须**做：

- 检查 `server/modules/onsite-analysis/tests/config.service.test.ts` —— 第 36 / 40 行有硬编码 `customers.length`，每加一条 +1
- 跑 `./scripts/validate-no-hardcoded-customers.sh` —— 应输出 `✓ validate-no-hardcoded-customers 0 violations`
- `git diff config/customer-analysis.json` 复核
- commit 后跑全量测试 `npx vitest run server/modules/onsite-analysis/tests/config.*.test.ts`

## 新增客户（手工改 JSON）

如果不便跑脚本（如 IDE 内联编辑 + 批量调整），直接编辑 `config/customer-analysis.json`：

```json
{
  "customers": [
    { "label": "其他问题", "branch": null },
    ...已有...
    { "label": "招商银行", "branch": "zs_401425" }   ← 新增（必须在末尾追加，不要插到中间）
  ],
  "iterations": [...]
}
```

**不要**：
- 删 / 改首项"其他问题"（schema 强校验）
- 把新条目插到数组中间（按"其他问题 → 已有客户 → 新客户"的有序习惯，方便阅读）

手工改完后跑同样的 checklist（测试硬编码 +1、lint 兜底、复核 diff）。

## 新增迭代

迭代必须匹配 schema 的 `^(master|release)_.+`（`master_5.2_3.2` 或 `release_5.2_3.2_20260327` 这种）。

手工编辑 `iterations` 数组追加即可。**注意**：通常一加就是一整个新 VR 日期的迭代条，而不是只加一条；迭代列表应保持"近期在顶、远期在底"的顺序，方便 UI 默认显示最新。

## 跨仓同步

xy-claudecodeui 的客户表只是 onsite-analysis 工作台 UI 的下拉选项。

如果客户**也**走 third-bridge（即分支命名用 `master_*/release_*/<短标识>` 这种），还需要同步更新 `~/work/projects/third-bridge/.claude/claude.md` 的「已知客户分支对照表」（`claude.md` 是小写，不是 `CLAUDE.md`）。该文件当前未纳入 git 跟踪（`??` 状态），改完记得 `cd third-bridge && git add .claude/claude.md && git commit`。

## 常见踩坑

| 现象 | 原因 | 处理 |
|---|---|---|
| UI 下拉没有新客户 | 改了文件但服务没重启 | `npm run server:dev` 重启后端，或 `pkill -f tsx` 后 `npm run dev` |
| `validate-no-hardcoded-customers` 报错 | 源码里手写了"招商银行"等字面量 | 把字面量改成读 `getConfig().data.customers` / `iterations` |
| `loadConfig` 报 `InvalidConfigError` | 改了 schema 必填字段（如 `branch` 漏写、label 空） | 看 schema 文件 `customer-analysis.schema.json` 的 `required` 列表 |
| 测试报 "expected 16 to equal 15" | 加客户没同步改测试硬编码数量 | 改 `config.service.test.ts` 第 40 行 `customers.length` |

## 关联文件

- 配置：`config/customer-analysis.json`
- Schema：`config/json-schemas/customer-analysis.schema.json`
- 脚本：`scripts/add-customer.sh` / `scripts/validate-no-hardcoded-customers.sh`
- 测试：`server/modules/onsite-analysis/tests/config.service.test.ts`
- 模块文档：`docs/onsite-analysis.md`
