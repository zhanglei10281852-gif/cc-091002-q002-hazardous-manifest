# 危险废物电子联单交接

服务维护联单、运输分段和多方交接签名。一个联单可以拆分为若干运输分段，各分段分别完成发运、途中交接、到场称重、接收、拒收或退运；联单总量与分段重量之间保持可核对关系。

## 模块

- `src/domain.js` — 分段状态机、容差规则、签名主体、材料摘要与事件归约器（唯一口径来源）
- `src/manifest-store.js` — 仅追加事件存储；事件以 `prevHash/hash` 串成保管链，支持 `events()` 导出与 `restore()` 恢复、`verify()` 验链
- `src/handover-service.js` — 围绕**每个分段**推进交接：`split / dispatch / handover / arrive / accept / reject / returnToGenerator / release`
- `src/audit-view.js` — 监管视图：原始总量、已接收量、退运量、未闭合余量、各处置点去向、每次签名摘要
- `src/signing.js` — HMAC 签名构造与校验；密钥只从运行环境 `HAZWASTE_SIGNING_SECRET` 读取

## 规则

- 一张联单可拆多车（多分段），分段申报量合计必须等于联单原始总量；某一分段接收不会把整单置为完成，全部分段进入终态（`accepted`/`returned`）才完成。
- 分段状态机：`prepared → dispatched → arrived → accepted`，或 `arrived → rejected → returned`；途中可在承运方之间 `handed-over`。
- 称重差异超出 `toleranceKg` 时只冻结相关分段（`frozen`），不牵连已完成分段；监督方可 `release` 解冻后复磅。
- 迟到事件（对终态/错误状态的重复发运、到场、接收、拒收）一律拒绝，终态不倒退；同一分段只能被到场登记的处置点接收一次。
- 签名值为 `HMAC-SHA256(secret, 材料摘要)`，材料按签署时链上快照构造（分段签名带分段内版本号）；材料版本过期、签名伪造、签名主体越权都会被拒。历史事件只追加不修改，篡改任何一环都会在 `verify()`/`restore()` 时暴露。

Node.js 20 及以上版本运行 `npm test`。
