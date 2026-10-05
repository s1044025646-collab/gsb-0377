# WebSocket 分片帧与控制帧交错解析后端（离线版）

一个纯本地运行的 RFC 6455 基础帧流解析服务：输入一段**方向明确**的字节流（可分多次、任意长度提交），增量输出**完整帧**、**重组后的完整消息**以及**带流内字节偏移的协议错误**。只做解析与报告，不建立真实连接、不实现 HTTP Upgrade、压缩扩展、广播或浏览器界面。

## 技术栈与前提

- Node.js ≥ 22.5（使用内置 `node:sqlite`，无需原生编译、无需 Docker/WSL/外部服务）
- TypeScript（`typescript` + `@types/node` 为仅有的开发依赖）
- SQLite 持久化，数据目录默认在项目内 `./data`

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node --test）
npm run demo       # 演示：掩码文本分两片 + 中间穿插 Ping，四种切块方案结果一致
npm start          # 启动 HTTP API（默认端口 0 = 自动选空闲端口，启动时打印实际端口）
```

CLI 直接使用（每次调用独立进程，状态经 SQLite 恢复）：

```powershell
node dist/cli.js create c2s myflow          # 新建解析流（方向 c2s 或 s2c）
node dist/cli.js append myflow 0 hex 8182   # 追加字节块（seq 从 0 递增）
node dist/cli.js append myflow 1 hex 37fa213d7f93
node dist/cli.js frames myflow              # 查看帧（含流内字节偏移、掩码键、解掩码载荷）
node dist/cli.js messages myflow            # 查看完整重组消息
node dist/cli.js diag myflow                # 导出诊断（状态/错误/全部事件）
node dist/cli.js finish myflow              # 显式结束输入
node dist/cli.js serve --port 8080          # 指定端口启动 HTTP API
```

环境变量：`WSP_DATA_DIR`（数据目录，默认 `./data`）、`WSP_DB`（数据库文件路径）、`PORT`（API 端口）。

## 完整字节样本

演示脚本使用的 c2s 字节流（48 字节，文本 "你好，WebSocket 分片！" 分两帧，中间穿插 Ping）：

```
018737fa213dd34781d89247ce 8982aabbccddc2d2 809511223344adae642173715c277a474764f4aab5a398a5dcf890
```

- 帧#0 `@字节0`：`01 87` + 掩码键 `37fa213d` + 7 字节掩码载荷 → 解掩码 `e4bda0e5a5bdef`（"你好，"加一个跨帧字符的前半，FIN=0）
- 帧#1 `@字节13`：`89 82` + 掩码键 `aabbccdd` + 2 字节 → 解掩码 `6869`（Ping "hi"，FIN=1，不拼入用户消息）
- 帧#2 `@字节21`：`80 95` + 掩码键 `11223344` + 21 字节 → continuation（FIN=1），重组后消息为 `你好，WebSocket 分片！`

更小的已知样本：掩码文本帧 "Hi" = `8182 37fa213d 7f93`（`'H'^0x37=0x7f`，`'i'^0xfa=0x93`，测试夹具手工核对）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/streams` | 新建流，body：`{"direction":"c2s"\|"s2c", "id"?, "limits"?}` |
| POST | `/streams/:id/chunks` | 追加字节，body：`{"seq":0,"encoding":"hex"\|"base64","data":"..."}` |
| POST | `/streams/:id/finish` | 显式结束输入 |
| GET | `/streams/:id` | 流状态 |
| GET | `/streams/:id/frames` | 已解析帧 |
| GET | `/streams/:id/messages` | 完整重组消息 |
| GET | `/streams/:id/diagnostics` | 诊断（状态 + 错误 + 全部事件） |

错误响应统一为 `{"error":{"code","message","details"}}`，HTTP 状态：参数错误 400、不存在 404、序号冲突 409、流已关闭/冻结 410。

错误码：`INVALID_INPUT`、`ENCODING_ERROR`、`NOT_FOUND`、`SEQ_CONFLICT`、`STREAM_CLOSED`、`STREAM_FROZEN`、`LIMIT_EXCEEDED`、`PROTOCOL_ERROR`（解析事件内还可能出现 `TRUNCATED_FRAME`、`UNFINISHED_MESSAGE`）。

## 解析规则要点

- **两层状态**：帧层增量等待头部（2/4/10 字节）+ 掩码键 + 载荷完整后才消费；消息层维护分片重组状态，直到 FIN 才发布消息。字节块边界与帧/消息边界无关。
- **掩码**：c2s 必须带掩码、s2c 必须不带；4 字节掩码按载荷内下标 `i % 4` 循环，因载荷完整后才解掩码，跨块不会错误重置偏移。
- **长度**：支持 7 位基本长度、16 位与 64 位扩展长度；拒绝不规范的短长度长编码（如用 126 编码 <126）、64 位长度最高位置位、超过上限的载荷。
- **控制帧**：Ping/Pong/Close 必须 FIN=1 且载荷 ≤125，可穿插在分片之间，不拼入用户消息；只报告，不做任何网络应答或心跳模拟。
- **文本**：整条消息重组后用严格 UTF-8 校验（`TextDecoder fatal`），允许多字节字符跨帧。
- **Close**：载荷长度 1 拒绝；状态码限 1000–1014（不含 1004/1005/1006/1015）与 3000–4999；原因须合法 UTF-8。合法 Close 关闭流，之后输入被拒绝；若仍有未结束分片，记录 `UNFINISHED_MESSAGE`，不输出伪造完整文本。
- **结束输入**：区分干净边界、`TRUNCATED_FRAME`（半个帧）与 `UNFINISHED_MESSAGE`（未结束消息）。
- **错误定位**：错误事件含 `byteOffset`（违规帧的流内起始偏移）与 `frameIndex`（已确认帧编号）。
- **冻结**：协议错误/超限后流冻结，拒绝后续追加，已正确解析的帧与消息作为证据保留可查。

## 幂等与持久化

- 每次追加携带递增序号 `seq`：同序号同内容（SHA-256 校验）幂等返回，同序号不同内容报 `SEQ_CONFLICT`，跳号报不连续。
- 字节块、事件与解析器状态在同一 SQLite 事务中原子提交；进程重启后自动从上次状态（包括半个头部、未结束分片）继续。
- 不同流的缓冲、方向与分片状态完全隔离。

## 恢复步骤（重启续传）

1. 用同一数据目录重启：`node dist/cli.js status myflow` 查看 `nextSeq` 与缓冲字节数。
2. 从 `nextSeq` 继续 `append` 即可，例如上例中 `append myflow 0 hex 8182` 只提交了半个头部，重启后 `append myflow 1 hex 37fa213d7f93` 即完成该帧。
3. 用 `diag` 导出全部事件核对证据。

## 默认限制（建流时可覆盖）

- `maxTotalBytes`：16 MiB（单流累计字节）
- `maxFramePayload`：1 MiB（单帧载荷）
- `maxMessageSize`：4 MiB（重组消息）

## 已知限制

- 仅 RFC 6455 基础帧格式：不支持扩展（RSV 必须为零）、不支持 HTTP Upgrade、不校验真实握手。
- 单方向解析：一条流只解析一个方向的字节，双向会话需建两条流。
- 文本校验在消息重组完成后进行，不对单帧做增量 UTF-8 校验。
- 事件与原始字节全量存于 SQLite，超大流量场景需自行清理。
