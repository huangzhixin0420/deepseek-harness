---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-15-unified-tool-include-own

English | [中文](2026-11-15-unified-tool-include-own.zh.md)

## Summary

Adds the optional includeOwn field to the persisted subagent tool restriction.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing descriptors keep the inherited-only restriction meaning when includeOwn is absent. Older readers preserve historical records and reject an unknown toolFilter field before applying it, so a writer that enables includeOwn does not silently change old reader behavior. New readers preserve the absence of includeOwn as false and keep allow and deny unchanged.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-catalog and pnpm run verify-translation-pairing pass. The dsh-tools focused regression passed 216/216 tests; doc-sync verifies the regenerated schema and bilingual records.

<a id="dev-note"></a>
## Dev Note

None.
