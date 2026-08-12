# 更新日志

所有项目重大变更都将记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目严格遵守 [语义化版本规范](https://semver.org/spec/v2.0.0.html)。

## [未发布]

## [1.6.0] - 2026-08-12
### 新增
- **esbuild 生产构建**：`npm run build` 将代理打包为单一文件 `dist/server.js`；可使用 `npm run start:prod` 或 `npm run build:start` 运行编译产物。
- **CLI 并发控制**：新增 `MAX_CONCURRENT_CLI` 限制同时运行的 CLI 子进程数量；超出限制的请求进入 FIFO 队列等待，超时后（`CLI_QUEUE_TIMEOUT_MS`，默认60秒，设置为0代表无限等待）返回 `503 proxy_busy`。
- **持久化请求记录**：单次请求运行结果存入 SQLite 数据库（`proxy.db`，使用 Node 内置 `node:sqlite`，无需额外依赖），重启后「最近请求」面板数据不会丢失。数据表记录流式模式、工具调用数量、消息条数、预估token、工具调用深度、思考强度、HTTP 状态码。旧版本数据库自动迁移；Node 版本不支持 `node:sqlite` 时降级为内存环形缓存。
- **优雅关闭**：收到 `SIGINT`/`SIGTERM` 信号时终止正在运行的 CLI 子进程、持久化统计数据、等待连接释放后关闭历史数据库，再退出程序。
- **`/health` 接口增强**：新增运行时长、后端类型、并发槽位（活跃/排队/最大上限）字段。
- **单请求独立超时覆盖**：请求头 `x-qoder-timeout: 秒数`（上限600秒），单次请求优先级高于全局 `QODERCN_TIMEOUT_MS`。
- Web 控制台：新增最近请求表格面板；仪表盘自动刷新运行时长与并发槽位；支持配置展示基础地址。
- **历史记录筛选与导出**：`/usage/recent` 支持 `endpoint`、`model`、`ok` 查询条件筛选；控制台可将筛选结果导出 CSV / JSON，点击条目打开请求详情抽屉。
- **小时级统计与趋势图表**：新增 `usage_hourly` 数据表与接口 `GET /usage/hourly?hours=`（范围1~168，数据保留7天）；用量页面展示24小时堆叠请求/成功/错误统计图。
- **活跃请求管理**：`GET /usage/active` 查询所有正在处理的请求；`DELETE /usage/active/:id` 主动取消请求并终止对应 CLI 进程，原请求端收到 `499 request_cancelled`。
- **Prometheus 监控指标**：`GET /metrics` 暴露请求计数器、延迟直方图、CLI 并发槽位指标（仅允许本地回环访问，无需鉴权）。
- **SSE 实时事件推送**：`GET /events` 持续推送 `request_completed` 事件；控制台用量页面近乎实时刷新数据。
- **自动重试与模型降级**：`RETRY_COUNT`（最大3次）对临时性 CLI 失败进行重试（流式响应仅在首个内容分片输出前重试）；配置 `QODER_MODEL_FALLBACK=原模型=备用模型,...`，请求失败后自动使用备用模型重试，响应归属最终生成内容的模型。
- **输入长度限制保护**：`MAX_INPUT_TOKENS` 在拉起 CLI 进程前拦截超长提示词，返回 `413 input_too_large`；置空或0代表关闭限制。
- **文件日志输出**：配置 `LOG_FILE`，所有日志持久写入指定文件，适合后台常驻运行。

### 调整
- 更新模型列表至当前 Qoder 可用阵容（共10个模型）；旧版带 `-effort-*` 后缀的模型ID可通过思考强度别名正常兼容。
- 非流式响应返回预估 token 使用量与独立会话/消息ID。
- 客户端主动断开连接时同步终止底层 CLI 子进程（兼容 Node 17+，该版本移除了 request `aborted` 事件）。
- 程序启动时自动清理历史崩溃残留的提示词附件文件。

### 修复
- 重启服务后 `requestsToday` 统计值不会携带昨日数据。
- 单元测试不再读写用户真实的 `usage.json` / `proxy.db`（通过 `QODER_PROXY_USAGE_FILE` / `QODER_PROXY_DB_FILE` 环境变量重定向测试库）。
- 流式链路发生异常时，正常写入用量统计与请求历史记录。
- SQLite 历史库启用 WAL 模式并设置忙等待超时，多并发写入不再出现 `SQLITE_BUSY` 丢数据问题。

## [1.5.1] - 2026-07-29
### 修复
- **Claude Code 504 超时、返回空内容问题 (#9)**
  - 在 Anthropic 消息处理与 CLI 参数构建逻辑中去重工具提示注入，避免大量工具定义（70个以上）重复加载。
  - 优化 `[工具协议]` JSON 序列化压缩，工具提示 token 占用降低约65%。
  - 新增接口路径别名（`/v1/messages`、`/messages`、`/v1/v1/messages` 等），兼容 CCSwitch / Claude Code 常见的基础路径配置错位。
  - 默认 `QODERCN_TIMEOUT_MS` 上调至300000毫秒（5分钟），适配复杂智能体任务。

## [1.5.0] - 2026-07-26
> 安全更新。所有 1.4.x 及更早版本建议升级。
### 破坏性变更
- **拒绝非本地回环域名发起的浏览器请求**。原生客户端（OpenCode、Trae、Cline、编辑器插件、curl）不会携带 Origin 请求头，不受影响。如果你使用远端网页UI（例如公网部署 LobeChat/NextChat 对接 `127.0.0.1`），这类请求会返回 `403 origin_not_allowed`。可以将域名添加至 `ALLOWED_ORIGINS` 恢复访问，请知悉风险：该域名下任意网页均可消耗你的模型配额。

### 安全加固
- **拦截跨域请求**。旧版本开启无鉴权CORS `cors({ origin: true })`，任意网页均可向后端发送请求、消耗账号配额。现在仅允许本地回环域名浏览器访问，预检请求与正式请求均会校验，非法来源返回 `403 origin_not_allowed`。
- **防御 DNS 重新绑定攻击**。请求 `Host` 头部如果指向非本地回环主机，直接返回 `403 host_not_allowed`，防止域名解析到127.0.0.1进行访问。
- **`PROXY_API_KEY` 正式生效鉴权**。自1.0版本起示例配置中存在该参数，但代码未实现校验；此前配置密钥也无法起到保护作用。现在访问 `/v1/*`、`/usage/*` 需要在 `Authorization: Bearer <密钥>` 或 `x-api-key: <key>` 携带密钥，使用常量时间对比防止时序攻击。密钥留空则保持旧版无鉴权模式，启动日志会提示当前鉴权状态。
- **服务端工具执行强制工作目录隔离**。开启 `SERVER_TOOL_EXECUTION=1` 时，文件工具原先仅简单拦截 `..` 相对路径，可以通过绝对路径读取服务器任意文件（如 `C:\Users\xxx\.ssh\id_rsa`）。现在读取/写入/编辑/遍历/检索/命令执行全部限制在 `SERVER_TOOL_WORKSPACE`（默认程序运行目录），同时校验原始路径与软链接解析后路径。
- **Bash 命令执行改为白名单模式、无Shell启动**。旧版本依靠黑名单拦截危险命令，存在大量绕过方式，搭配开放CORS存在远程代码执行风险。启用 Bash 工具必须同时开启 `SERVER_TOOL_ALLOW_BASH=1` + 配置非空 `SERVER_TOOL_BASH_ALLOWLIST`（仅填写程序名）；禁止Shell特殊字符、禁止携带路径的程序；使用 `execFileSync` 直接启动程序，不经过系统shell。
- **`GET /` 不再返回本地文件路径**。原先接口会暴露 `cli_home`（包含系统用户名）与 cli 启动命令，相关信息改为仅输出至服务端启动日志。

### 新增
- `ALLOWED_ORIGINS`、`ALLOWED_HOSTS` 环境变量，用于主动允许外部域名/主机反向代理场景。
- `SERVER_TOOL_WORKSPACE`、`SERVER_TOOL_ALLOW_BASH`、`SERVER_TOOL_BASH_ALLOWLIST`，管控服务端命令与文件工具范围。
- Web控制台配置页面新增「代理密钥」输入框，保存在浏览器 localStorage，设置密钥后网页端可以正常访问接口。
- `SECURITY.md`：提供 GitHub 私有漏洞上报渠道与威胁模型说明文档。

### 修复
- Web控制台仪表盘模型数量一直显示为 **0**：接口接收未解析的 Response 对象，模型列表始终读取 `undefined`。
- Glob 文件匹配将 `.` 当作正则通配符，导致 `*.js` 错误匹配 `bjs` 这类文件名；现已对通配符外的正则特殊字符转义。
- Glob、Grep 文件检索结果上限500条，超出后返回 `truncated` 标记，防止无限遍历目录树。

## [1.4.2] - 2026-07-20
### 新增
- **新增模型支持** ([#7])：`qwen3.8-max-preview`（支持思考强度别名）、`qwen3.7-plus`、`minimax-m2.7`，适配 Qoder CLI CN 1.1.0；下线不再提供的 `qwen3.6-plus`。
> 注意：新模型要求本地 Qoder CLI CN ≥1.1.0，执行 `qoderclicn update` 升级。

### 修复
- **OpenCode、Trae 等智能体客户端返回空白消息 (#8)**：携带 tools 参数的流式请求现在正确缓冲、解析并输出结构化工具调用；按照 OpenAI 规范下发 `delta.tool_calls`、`finish_reason: "tool_calls"`；按照 Anthropic 规范下发 `tool_use`、`input_json_delta`、`stop_reason: "tool_use"`。1.3.0 版本原始实现直接把工具调用JSON以纯文本流输出，客户端无法识别导致消息空白。
- **流式静默中断问题**：CLI 中途异常退出时，代理主动下发 SSE 错误数据包（OpenAI：`data: {"error": …}`；Anthropic：`event: error`），不再无提示切断流。
- **CLI输出无法识别导致空流**：当 `stream-json` 解析没有识别到有效消息时，自动从最后一条有效记录提取文本兜底，行为对齐非流式模式。
- **Windows cmd.exe 命令行长度限制**：通过 cmd 启动 CLI 时，超长 `--append-system-prompt` 系统提示移入附件文件规避限制（cmd.exe 命令行上限8191字符），超长智能体系统提示不再启动失败。

### 调整
- **服务端工具执行改为手动开启**（`SERVER_TOOL_EXECUTION=1`）：默认行为将工具调用返回客户端执行（符合 OpenCode 等编辑器客户端预期，在客户端工作目录运行工具）。旧版本默认在代理进程内部执行工具调用，不会把 tool_calls 下发给客户端。
- OpenAI 兼容接口支持 `developer` 角色，内部转为 system 消息处理。

## [1.4.1] - 2026-07-17
### 调整
- **模型注册表更新**：`glm-5.1` → `glm-5.2`，`kimi-k2.6` → `kimi-k2.7-code`，对齐当前 Qoder CLI 官方模型名称。
- 同步更新 `opencode.json`、中英文 README 内模型标识。

## [1.4.0] - 2026-06-06
### 新增
- **双CLI后端支持**：通过 `CLI_BACKEND` 环境变量切换 Qoder CN（国内）/ Qoder Global（国际）。
- Web控制台仪表盘展示当前启用的 CLI 后端类型。

### 调整
- **项目更名**：“Qoder CN Proxy” → “Qoder Proxy”，适配双后端定位。
- npm 包名称由 `qoder-cn-proxy` 修改为 `qoder-proxy`。

### 修复
- **Windows npm 软链接路径问题**：在 Windows 系统正确定位 `qoderclicn` / `qodercli` 程序路径。

## [1.3.0] - 2026-06-05
### 新增
- **支持携带工具的流式输出**：开启 stream 且存在工具定义时允许流式响应；流式模式暂不解析结构化工具调用，原始内容以文本分片下发；非流式模式保持完整 tool_calls / tool_use 解析。

### 修复
- **Windows 超长参数 ENAMETOOLONG 错误**：大量工具定义导致启动命令过长，超长系统提示移入附件文件，规避系统命令长度限制。
- **未知模型兜底策略**：无法识别的模型ID（例如 Claude Code 内置模型名）自动降级为 `auto`，不再直接透传给 CLI 造成请求失败。
- 增加工具调用解析日志，方便问题排查。

## [1.2.0] - 2026-06-03
### 新增
- **Web 可视化控制台**：访问 `/ui` 打开界面，包含仪表盘、模型列表、对话测试、配置总览、用量统计面板，毛玻璃UI风格。
- 明暗两套主题切换。
- **本地用量统计模块**：新增接口 `/usage/local`、`/usage/reset-local`，持久化存储 `usage.json`。
- Windows 启动脚本 `start-ui.cmd`。

## [1.1.0] - 2026-06-01
### 新增
- **原生流式输出**：`stream: true` 且不携带工具时，使用 `qoderclicn --output-format stream-json` 获取实时增量文本；内容分片收到后立即通过SSE转发，不再等待完整响应结束。
- OpenAI 工具调用支持：`/v1/chat/completions` 支持 `tools` 参数与 `role: 'tool'` 消息；模型输出工具调用时返回标准 `tool_calls`、`finish_reason: "tool_calls"`；解析失败自动降级纯文本。
- Anthropic 工具调用支持：`/v1/messages` 支持 `tools`、`input_schema`、`tool_result`；识别模型输出 `tool_use` 内容块与 `stop_reason: "tool_use"`；支持文本与工具调用混合输出。
- 公共 `tool-parser.js` 模块：统一处理工具提示注入、输出解析、ID生成、消息格式化，OpenAI / Anthropic 接口共用。
- Anthropic 多类型内容块兼容：图片、文档、思考等未知类型生成占位标签，不会直接丢弃。
- `/v1/models` 接口返回模型能力标识（推理支持、思考强度别名）。
- 工具调用JSON平衡括号提取，兼容模型不输出markdown代码块的场景。
- OpenAI `arguments` 严格按照规范返回JSON字符串，不提前解析为对象。
- Anthropic `input` 返回解析完成的JSON对象。
- 工具调用ID规范：OpenAI 使用 `call_` 前缀，Anthropic 使用 `toolu_` 前缀。
- 多轮对话工具结果使用 `<tool_result id="...">` 标签，维持调用ID关联。
- 历史消息内助手工具调用记录格式化展示，维持对话上下文连续性。
- `--append-system-prompt` 参数支持：提取客户端 system 消息传递给 CLI。
- `package.json` 添加 files 白名单，优化 npm 发布产物。

### 调整
- 默认超时由120秒上调至300秒（5分钟），适配工具密集任务。
- 请求校验不再拦截 `role: 'tool'` 消息、历史消息内的 tool_calls。
- Anthropic 请求校验支持消息数组内直接携带 system 角色。
- 开启工具时不再注入「仅文本」提示，改为注入完整工具定义提示词。
- Anthropic 消息规范化标签更新为 `<tool_result>` / `<tool_use>` 格式。
- **携带工具并且开启 stream 的请求降级为伪流式**：底层使用非流式CLI模式，封装成兼容的SSE格式下发（工具调用无法增量流式解析）。

## [1.0.0] - 2025-06-01
### 新增
- OpenAI 兼容接口 `/v1/chat/completions`，支持 SSE 流式输出。
- Anthropic 兼容接口 `/v1/messages`（初始版本仅支持纯文本，无工具调用）。
- Anthropic 分词计数接口 `/v1/messages/count_tokens`。
- 健康检测接口 `GET /health`。
- 模型列表接口 `GET /v1/models`。
- 内置9个基础模型：`qoder-cn`、`auto`、`qwen3.7-max`、`glm-5.1`、`kimi-k2.6`、`qwen3.6-plus`、`qwen3.6-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`。
- Qwen3.7-Max 思考强度别名：`qwen3.7-max-effort-low` / `-medium` / `-high` / `-max`。
- 单请求独立推理参数（`reasoning_effort`、上下文窗口、最大输出token），支持全局环境变量覆盖。
- 原生支持 OpenCode 通过项目 `opencode.json` 接入。
- 本地客户端可使用自定义 OpenAI 兼容端点接入。
- 纯文本模式支持 Anthropic 接口协议。
- Windows PowerShell 模型选择启动示例脚本。
- `start-proxy.cmd` 启动脚本，自动检测 `.env`、Token、打印访问地址，日志自动脱敏密钥。
- 冒烟测试套件：`npm run smoke` / `npm run smoke:full`，快速连通性与模型测试。
- 使用 Node 内置测试框架编写单元测试（`node --test`）。
- 中英文 README，包含部署说明、使用方式、curl 请求示例。
- `SECURITY.md`：安全边界与漏洞上报说明。
- `.env.example` 环境变量模板。
- MIT 开源协议。

### 安全措施
- 默认仅监听 `127.0.0.1`，不会对外网开放。
- 身份认证依靠环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN`。
- 日志自动脱敏 Authorization 请求头、Cookie、各类密钥 Token。
- Qoder CLI 子进程使用独立运行目录 `.runtime/`，避免读取桌面客户端本地凭证。
- 程序不会主动扫描系统目录：`%APPDATA%`、`%LOCALAPPDATA%`、`%USERPROFILE%\.qoderwork`。
- `.env`、`.runtime/`、日志文件全部写入 `.gitignore`，禁止提交密钥。