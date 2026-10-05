# WebSocket 分片帧与控制帧交错解析服务（离线后端）

纯后端、离线运行的 RFC 6455 基础帧格式增量解析器。输入一段**方向明确**的字节流（hex 或 Base64），
可分多次提交任意长度的块，输出完整帧、重组后的消息以及带流内字节偏移的协议错误。

不建立真实 WebSocket 连接，不实现 HTTP Upgrade、压缩扩展、广播房间或浏览器界面。

## 技术栈与前提

- Node.js >= 22.5（使用内置 `node:sqlite`，已在 Node 25 上验证）
- TypeScript，无任何运行时第三方依赖
- Windows 本地运行，不需要 Docker / WSL / 外部服务

## 命令

```powershell
npm install        # 安装 typescript / @types/node（仅开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP API（默认选择空闲端口）
npm run demo       # 演示：掩码文本分两帧 + 穿插 Ping，不同分块喂入结果一致
npm run cli -- ... # CLI
```

可配置项（环境变量）：`PORT`（端口，默认 0 即空闲端口）、`DATA_DIR`（数据目录，默认 `./data`）、
`DB_PATH`（SQLite 文件，默认 `./data/ws-parser.db`）。`npm start -- --port=8080` 也可指定端口。

## 概念模型

- **流（stream）**：一个方向明确的字节序列。`c2s` 表示客户端到服务端（帧必须带掩码），
  `s2c` 反之（帧必须不带掩码）。不同流的缓冲、方向、分片状态完全隔离。
- **块（chunk）**：每次追加的一段任意长度字节，带递增序号 `seq`（从 0 开始）。
  相同序号相同内容为幂等重放（返回空事件）；内容不同返回 `SEQ_CONFLICT`；跳号返回 `SEQ_GAP`。
  块边界与帧边界、消息边界无关。
- **帧（frame）**：RFC 6455 基础帧。字段或正文不完整时等待后续块，不提前消费；
  掩码按载荷内下标循环，跨块不会错误重置偏移。
- **消息（message）**：首帧（text/binary）+ 若干 continuation，直到 FIN 才发布。
  文本在整条消息重组后做严格 UTF-8 校验，允许多字节字符跨帧。
- **控制帧**：Ping / Pong / Close 可穿插在分片之间，必须 FIN=1 且载荷 ≤ 125 字节，
  不会拼进用户消息。服务只解析并报告，不自动应答、不模拟心跳。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/streams` | 新建流，body: `{"direction":"c2s"\|"s2c", "limits"?}` |
| GET | `/streams` / `/streams/:id` | 列出 / 查询流状态 |
| POST | `/streams/:id/chunks` | 追加块，body: `{"seq":0,"encoding":"hex"\|"base64","data":"..."}` |
| POST | `/streams/:id/finish` | 显式结束输入 |
| GET | `/streams/:id/frames` | 查询完整帧 |
| GET | `/streams/:id/messages` | 读取完整消息 |
| GET | `/streams/:id/events` | 全部事件 |
| GET | `/streams/:id/diagnostics` | 导出诊断（计数、错误、未完成消息、eof） |

错误响应统一为 `{"error":{"code","message"}}`，主要错误码：
`BAD_DIRECTION` `BAD_ENCODING` `BAD_JSON` `BAD_SEQ` `BAD_LIMITS` `NOT_FOUND`
`SEQ_CONFLICT`(409) `SEQ_GAP`(409)。

协议错误（作为事件记录，含流内字节偏移 `offset` 与已确认帧编号 `frameIndex`）：
`RSV_NONZERO` `BAD_OPCODE` `MASK_REQUIRED` `MASK_FORBIDDEN` `NON_MINIMAL_LENGTH`
`LENGTH_MSB_SET` `PAYLOAD_TOO_LARGE` `MESSAGE_TOO_LARGE` `STREAM_TOO_LARGE`
`CONTROL_FRAGMENTED` `CONTROL_TOO_LARGE` `UNEXPECTED_CONTINUATION` `MESSAGE_NOT_FINISHED`
`INVALID_UTF8` `CLOSE_LEN_ONE` `BAD_CLOSE_CODE` `CLOSE_REASON_UTF8`
`TRUNCATED_FRAME` `INPUT_AFTER_CLOSE` `INPUT_AFTER_FINISH` `STREAM_FROZEN`。

协议错误后流被**冻结**：保留已正确解析的帧与消息作为证据，后续追加一律拒绝。

## CLI

```powershell
npm run cli -- new c2s                          # 新建流，输出流 id
npm run cli -- append <id> 0 hex 8182010203     # 追加第 0 块（半个帧）
npm run cli -- append <id> 1 hex 04496b         # 追加第 1 块，输出帧与消息
npm run cli -- frames <id>                      # 查询帧（两层边界：帧偏移 + 消息）
npm run cli -- messages <id>                    # 读取完整消息
npm run cli -- diag <id>                        # 导出诊断 JSON（含错误位置）
npm run cli -- finish <id>                      # 结束输入
npm run cli -- list / status <id> / events <id>
```

## 完整字节样本

手工构造（掩码键 `01020304`，`'H'^01=49`，`'i'^02=6b`）：

```
81 82 01 02 03 04 49 6b
└┬┘ └┬┘ └──┬──────┘ └┬─┘
帧头  掩码  掩码键     载荷 = "Hi"
```

分片 + 穿插 Ping（见 `npm run demo`，流 hex 拼接）：

```
01 83 11223344 59475f    text fin=0 掩码 "Hel"
89 84 55667788 250919ef  ping 掩码 "pong"
80 82 a0b0c0d0 ccdf      continuation fin=1 掩码 "lo"  => 消息 "Hello"
```

UTF-8 跨帧：`01 02 e4b8` + `80 01 ad` 重组为 `"中"`。

## 崩溃恢复

所有已接收字节块、解析器状态（含未完成的半个头部/半个帧缓冲、分片消息缓冲、
帧编号、字节偏移）与事件都在每次追加的事务中原子写入 SQLite。
重启进程后直接用同一 `DB_PATH` 启动，按 `nextSeq` 继续追加即可从半个头部续传：

```powershell
npm run cli -- status <id>     # 查看 nextSeq 与当前偏移
npm run cli -- append <id> <nextSeq> hex <后续字节>
```

`finish` 的语义：干净边界（`eof: clean`）、半个帧（`TRUNCATED_FRAME` 错误）、
未结束消息（`incomplete-message` 事件 + `eof: open-message`，不会输出伪造的完整文本）。
合法 Close 帧使流关闭，之后输入返回 `INPUT_AFTER_CLOSE`。

## 限制

- 只实现 RFC 6455 基础帧格式：无扩展（RSV 必须为零）、无 HTTP Upgrade、无网络连接。
- 单帧完整后才消费（掩码偏移因此始终以载荷起点为 0），超大单帧会占用内存；
  默认上限：累计 16 MiB / 单帧 1 MiB / 单消息 4 MiB，可在新建流时通过 `limits` 覆盖。
- Close 状态码校验公开基础范围：1000–1003、1007–1015、3000–4999。
- 长度编码要求最小化：126 不得用于 <126，127 不得用于 <65536，64 位长度最高位必须为零。
- `node:sqlite` 在 Node 25 仍标记为 experimental（仅警告，不影响功能）。

## 测试

`npm test` 运行 27 个用例：空载荷、边界长度（125/126/65536）、非最小长度编码、
64 位长度最高位、跨块掩码（逐切分点全枚举）、UTF-8 跨帧、非法 UTF-8、非法 continuation、
分片中插新首帧、RSV、未掩码客户端帧、控制帧分片/超限、Close 各类校验、
单帧/消息/流超限、文件尾截断、冻结后拒绝、幂等/冲突/跳号、重启续传、流间隔离。
夹具均为手工构造的已知字节并核对解掩码明文，不是编码器与解析器互相验证。
