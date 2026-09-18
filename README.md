# 危险废物电子联单交接

服务维护联单、运输分段和多方交接签名。一个联单可以拆分为若干运输分段，各分段分别完成发运、到场称重、接收、拒收或退运；联单总量与分段重量之间应保持可核对关系。

`src/manifest-store.js` 管理联单数据，`src/handover-service.js` 推进交接，`src/audit-view.js` 生成监管视图，`src/custody.js` 维护签名材料与保管链。签名材料使用明确版本，真实签名密钥通过运行环境提供（`new HandoverService(store, { signer })`，或由调用方传入签名值）。Node.js 20 及以上版本可运行 `npm test`。

## 分段生命周期

每个分段独立推进，互不影响：

```
prepared --dispatch--> dispatched --weigh--> arrived --accept--> accepted
                                                    \-reject--> rejected --returnSegment--> returned
```

- `handover` 记录途中交接（承运人变更），分段保持 `dispatched`。
- `accepted`、`returned` 为终态：迟到事件一律返回 `conflict`，不入链、不改写已签署历史。
- 称重或接收时差异超过 `toleranceKg`：该分段被冻结（`frozen`），其余分段不受影响；`unfreeze` 解冻后方可继续。
- 同一分段只能由一个处置点接收：目的处置点不符直接冲突，已接收后任何再次接收都被终态保护拒绝。

## 联单状态（派生口径）

联单状态不单独维护，统一由分段状态派生（store、service、view 同一口径）：

- `completed`：全部分段均已接收；
- `closed`：全部分段到达终态但含退运；
- `in-transit`：其余情况。单个分段的接收、拒收都不会误判整单完成，未闭合余量始终保留在监管视图中。

## 签名与保管链

- 每次签名只覆盖签署时可见的材料版本：联单版本号、总量与容差、被操作分段的快照，记录为 `manifestVersion` 与 `materialHash`。
- 事件追加式写入 `manifest.events` 并以前序哈希链接；`verifyManifest` 校验哈希链、签名材料摘要、版本一致性与派生状态一致性，任何对已签署历史的篡改都会被发现。
- `ManifestStore.snapshot()` / `ManifestStore.restore()` 支持服务恢复，恢复后保管链可继续验证、分段可继续推进。

## 监管视图

`manifestView(manifest)` 输出：`declaredKg` 原始总量、`segments` 各分段去向（状态、目的/实际处置点、冻结标记）、`remainingKg` 未闭合余量、`signatures` 每次签名摘要，以及 `custodyVerified` 保管链校验结果。
