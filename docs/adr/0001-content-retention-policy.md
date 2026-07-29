---
title: 自动内容保留策略
category: overview
summary: 每日清理七天无活动内容，同时保护 Claude Code 文件和系统基础数据
owner: xy-claudecodeui
last_reviewed: 2026-07-29
---

# 自动内容保留策略

应用每天按服务器本地时间 12:00 清理最后活动时间超过 7×24 小时的聊天会话索引和现场分析内容。现场目录先删除、成功后删除 SQLite 索引；Claude Code 的 `~/.claude/` 文件、项目索引及账号/凭据/配置等系统基础数据永久保留。这个边界优先保证 Claude Code 原始资料和应用可运行性，接受 Claude 文件后续被修改时可能重新建立索引的行为。
