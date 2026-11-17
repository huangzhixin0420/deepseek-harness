---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-15-unified-tool-include-own

[English](2026-11-15-unified-tool-include-own.md) | 中文

## 概述

为持久化的子 agent 工具限制增加可选字段 includeOwn。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-15-unified-tool-include-own
baseline: false
changes:
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "4e0a4d434b7b9623312e634c4f5099627cbb1f2657cd532a31290d2e50e50181"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 descriptor 在缺少 includeOwn 时仍表示只过滤继承工具。旧读取方保留历史记录，并在应用前拒绝未识别的 toolFilter 字段，因此写入方启用 includeOwn 不会静默改变旧读取方的行为。新读取方把缺失的 includeOwn 保持为 false，且保持 allow 与 deny 不变。

<a id="verification"></a>
## 验证

pnpm run verify-persistence-catalog 与 pnpm run verify-translation-pairing 通过。dsh-tools 定向回归 216/216 个测试通过；doc-sync 校验重新生成的 schema 与双语记录。

<a id="dev-note"></a>
## 开发备注

无。
