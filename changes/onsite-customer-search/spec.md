# 客户下拉列表模糊搜索

## Problem Statement

在新建客户现场问题时，客户字段目前使用原生下拉列表。客户目录较长，用户需要滚动查找目标客户，定位效率低，尤其当用户只记得客户名称的一部分或三平台分支标识时更明显。

## Solution

将客户字段升级为受控 Combobox。用户可以输入临时搜索词，在客户目录中按客户名称或三平台分支进行标准化后的连续子串筛选，再从候选项中确认客户。客户目录仍是唯一有效来源，搜索词不能直接作为客户提交。

## User Stories

1. As a现场问题分析人员, I want to search customers by part of the customer name, so that I can locate a customer without scrolling through the full directory.
2. As a现场问题分析人员, I want to search customers by part of the three-platform branch, so that I can find a customer when I remember the branch identifier instead of the display name.
3. As a现场问题分析人员, I want matching to ignore letter case and leading or trailing spaces, so that ordinary input variations do not hide valid results.
4. As a现场问题分析人员, I want matching to use continuous substring matching, so that the result rule is predictable and explainable.
5. As a现场问题分析人员, I want the full customer list to appear when I open the field, so that I can still browse customers when I do not know a search term.
6. As a现场问题分析人员, I want the search input to receive focus when the field opens, so that I can start narrowing results immediately.
7. As a现场问题分析人员, I want the currently confirmed customer to remain highlighted when I reopen the field, so that I can see the current business value before changing it.
8. As a现场问题分析人员, I want to move through candidates with the arrow keys and confirm one with Enter, so that I can complete selection without a mouse.
9. As a现场问题分析人员, I want Esc or an outside click to close the candidate panel without applying an unconfirmed search, so that temporary search state does not alter the form.
10. As a现场问题分析人员, I want selecting a candidate to close the panel and update the customer field, so that the form has one clear confirmed value.
11. As a现场问题分析人员, I want an explicit no-match message, so that I know the search produced no configured customer rather than assuming the list failed to load.
12. As a现场问题分析人员, I want no-match searches to leave the previously confirmed customer unchanged, so that an unsuccessful search cannot invalidate a required field accidentally.
13. As a现场问题分析人员, I want to see the customer name together with its three-platform branch suffix, so that similarly named customers can be distinguished before selection.
14. As a现场问题分析人员, I want the form to submit only the customer name, so that display-only branch text does not corrupt the existing problem contract.
15. As a现场问题分析人员, I want the candidate order to remain the configured order, so that curated ordering and the special first customer remain stable.
16. As a现场问题分析人员, I want long candidate lists to scroll inside the panel, so that the new control does not push the modal footer off screen.
17. As a现场问题分析人员, I want the control to remain disabled when customer configuration is unavailable or invalid, so that I cannot submit an untrusted customer value.
18. As a keyboard-only user, I want standard Combobox keyboard semantics and focus states, so that I can discover, navigate, confirm, and dismiss the control reliably.
19. As a screen-reader user, I want the control, list, selected option, and no-match state to expose standard accessible semantics, so that I can understand and operate the customer selector.
20. As a现场问题分析人员, I want iteration and database selectors to remain unchanged, so that this improvement stays focused on the customer lookup problem.

## Implementation Decisions

- The customer selector is the only field changed; iteration and database selectors retain their current behavior.
- The selector becomes a controlled Combobox with a separate temporary search state and confirmed customer state.
- Search candidates come exclusively from the configured customer directory.
- Search matches the customer label or its optional three-platform branch using case-insensitive continuous substring matching after trimming the search term.
- The result order is the original customer-directory order; no relevance or alphabetical reordering is introduced.
- Candidate display retains the current customer-name-plus-branch-suffix format. The confirmed form value remains only the customer label.
- Selecting a candidate confirms the customer and closes the panel. Arrow keys navigate, Enter confirms, and Esc dismisses.
- Opening the control shows all candidates, focuses the search input, and highlights the confirmed customer when one exists.
- Outside click and Esc discard unconfirmed search text while preserving the confirmed customer. There is no clear-search button and no free-text customer submission path.
- No-match state displays “无匹配客户” and does not change the confirmed customer or submission validity.
- Invalid, missing, or empty customer configuration keeps the control disabled and preserves the existing configuration error message.
- Long result sets scroll inside a bounded candidate panel so the surrounding modal layout remains usable.
- The control follows standard Combobox, listbox, and option accessibility semantics, including selected and highlighted states.
- No API, storage schema, customer configuration schema, or server-side problem contract changes are required.

## Testing Decisions

- Tests verify externally observable behavior rather than the internal filtering data structure or component implementation.
- The primary seam is the customer-selector behavior module. It should cover matching by customer label and branch, normalization, configured ordering, selection confirmation, keyboard navigation, Escape/outside dismissal, no-match behavior, long-list scrolling hooks, disabled configuration states, and accessibility attributes.
- The new selector tests should follow the repository’s existing Node `node:test` conventions and React static-rendering/source-contract patterns used by the onsite frontend tests.
- The new-issue wizard contract should verify that a confirmed customer submits its label only, preserves existing branch handling, and never submits an unconfirmed search term or display suffix.
- Regression coverage should confirm that iteration and database selectors are unaffected and that the existing configuration-driven customer guard remains effective.
- Focused frontend tests are sufficient for this change; backend route and database tests are not expected to change because the API and storage contracts remain unchanged.

## Out of Scope

- Fuzzy typo tolerance, pinyin conversion, character-skipping matching, or ranking by relevance.
- Creating, editing, or manually entering customers from the form.
- Adding a clear button or allowing the required customer field to submit an arbitrary search term.
- Applying the searchable Combobox to iteration or database fields.
- Changing customer configuration, branch mappings, server APIs, persistence, or validation rules.
- Supporting configuration changes while the form is already open.
- Publishing or synchronizing customer data to another system.

## Further Notes

- The domain glossary calls the configured set the “客户目录” and the branch mapping the “三平台分支”; the implementation should use those terms consistently in user-facing behavior and tests.
- The accepted architectural choice is recorded in the customer-selector ADR.
- The issue-tracker publish step is pending because this workspace has no configured issue-tracker integration, authentication, or confirmed target repository/label vocabulary.
