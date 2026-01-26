# 通过 local-ai-runtime 调用 LSP（opencode / MCP）

这份文档说明：你的客户端（例如 opencode）如何通过 OpenAI 兼容接口，间接调用 LSP 能力（hover / definition / diagnostics 等）。

local-ai-runtime 本身不实现 LSP，它通过 **MCP（Model Context Protocol）的 tools/list + tools/call** 去调用一个外部 MCP Server；该 MCP Server 再提供 LSP 工具。

## 1. 运行时架构

```
客户端(opencode) -> local-ai-runtime(OpenAI API) -> MCP Server -> LSP 工具
```

在 local-ai-runtime 中：

- 当启用了 MCP 时，会在启动阶段拉取 MCP tools，并把它们注册成可用工具
- 额外提供一组稳定的 IDE 入口工具（封装了路径归一化）：
  - ide.read_file -> fs.read_file
  - ide.search -> fs.search
  - ide.hover -> lsp.hover
  - ide.definition -> lsp.definition
  - ide.diagnostics -> lsp.diagnostics

对应代码实现：
- MCP 初始化与工具注册：[main.cpp](file:///d:/workspace/cpp_projects/local_ai_runtime/src/main.cpp#L143-L588)
- MCP RPC 协议（HTTP JSON-RPC）：[mcp_client.cpp](file:///d:/workspace/cpp_projects/local_ai_runtime/src/mcp_client.cpp#L60-L164)

## 2. 服务端开启 MCP（必须）

### 2.1 关键环境变量

在启动 local-ai-runtime 前，至少需要这些变量：

- MCP_HOST：指向 MCP Server，例如 `http://127.0.0.1:9000`
  - 或 MCP_HOSTS：多个 MCP Server（逗号分隔），例如 `http://127.0.0.1:9000,http://127.0.0.1:9001`
- RUNTIME_WORKSPACE_ROOT：工作区根目录（强烈建议设置）
  - ide.read_file / ide.search / ide.* 会把传入 path/uri 归一化并限制在该目录下

可选：
- RUNTIME_LISTEN_HOST / RUNTIME_LISTEN_PORT：runtime 的监听地址/端口

环境变量解析位置：
- MCP_HOST / MCP_HOSTS / RUNTIME_WORKSPACE_ROOT：[config.cpp](file:///d:/workspace/cpp_projects/local_ai_runtime/src/config.cpp#L121-L151)

### 2.2 使用 mock MCP Server 快速自测（推荐）

仓库自带一个最小 MCP Server（含 lsp.* 和 fs.* 工具）：

```powershell
python .\tools\mock_mcp_server.py --mode lsp --host 127.0.0.1 --port 9000
```

然后启动 local-ai-runtime（示例）：

```powershell
$env:RUNTIME_LISTEN_HOST="127.0.0.1"
$env:RUNTIME_LISTEN_PORT="18080"
$env:RUNTIME_WORKSPACE_ROOT="D:\workspace\cpp_projects\local_ai_runtime"
$env:MCP_HOST="http://127.0.0.1:9000"

.\build_local_ai_runtime\bin\Release\local-ai-runtime.exe
```

### 2.3 让 runtime 重新拉取 MCP 工具（热更新）

runtime 提供一个内部接口，用于重新拉取 MCP tools 并注册：

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:18080/internal/refresh_mcp_tools"
```

返回里 `registered` 大于 0，表示工具已注册成功。

## 3. 客户端请求需要怎么改（核心）

local-ai-runtime 只有在请求里显式声明允许哪些工具时，才会进入工具循环。

因此客户端需要做两件事：

1. 在请求 JSON 里带上 `tools`（至少把 ide.* 工具名字列进去）
2. 确保 `tool_choice` 不是 `none`（不传或传 `auto` 都可以）

额外建议：

- 固定并复用 `session_id`，并设置 `use_server_history=true`
  - 这样 runtime 能把工具调用/结果写入 session history，后续推理可以“看到”之前的 LSP 结果

### 3.1 推荐的 tools 列表（LSP + 文件）

最常用：

- ide.hover
- ide.definition
- ide.diagnostics

配合文件上下文时再加：

- ide.read_file
- ide.search

### 3.2 请求示例（PowerShell）

下面示例会让模型尝试调用 `ide.diagnostics`（注意：是否真的触发工具调用取决于模型与提示词；这里只展示客户端必须提供的字段形状）。

```powershell
$body = @{
  model = "ollama:qwen2.5:latest"
  session_id = "dev-1"
  use_server_history = $true
  tool_choice = "auto"
  tools = @(
    @{ type = "function"; function = @{ name = "ide.diagnostics" } }
    @{ type = "function"; function = @{ name = "ide.hover" } }
    @{ type = "function"; function = @{ name = "ide.definition" } }
    @{ type = "function"; function = @{ name = "ide.read_file" } }
    @{ type = "function"; function = @{ name = "ide.search" } }
  )
  messages = @(
    @{ role = "user"; content = "帮我查看 src/main.cpp 的诊断信息（ide.diagnostics）" }
  )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:18080/v1/chat/completions" `
  -ContentType "application/json" `
  -Body $body
```

### 3.3 ide.* 参数说明（你需要在客户端保证这些字段类型正确）

- ide.diagnostics
  - arguments：`{ "uri": "<path-or-file-uri>" }`
- ide.hover / ide.definition
  - arguments：`{ "uri": "<path-or-file-uri>", "line": <int>, "character": <int> }`

uri 推荐传法：

- 传相对路径（相对 RUNTIME_WORKSPACE_ROOT），例如：`src/main.cpp`
- 或传绝对路径，例如：`D:/workspace/cpp_projects/local_ai_runtime/src/main.cpp`

## 4. opencode 的配置建议（最少改动原则）

你的目标是让 opencode 在发起对 `/v1/chat/completions` 的请求时，能带上上一节提到的三个字段：

- tools：包含 ide.hover / ide.definition / ide.diagnostics（以及你需要的 ide.read_file / ide.search）
- tool_choice：不要是 none（建议 auto）
- session_id + use_server_history：建议开启并复用

其中 `tools` 的 schema（parameters/description）对 runtime 来说不是必需的；runtime 目前只使用 tool name 来做白名单过滤，并在服务端构造一个工具系统提示词。

## 5. 常见问题排查

1) 请求里带了 tools 但没生效  
- 检查 tool_choice 是否为 none  
- 检查 tools 里 function.name 是否与 runtime 注册名完全一致（ide.hover / ide.definition / ide.diagnostics）

2) tool not found / tool not allowed  
- MCP 没启用或 MCP Server 初始化失败：确认 MCP_HOST 可访问  
- 调用一次 `/internal/refresh_mcp_tools` 看 registered 数是否增加

3) ide.* 报 path is outside workspace root  
- 说明 RUNTIME_WORKSPACE_ROOT 已启用安全限制，uri/path 不在根目录下  
- 改为传相对路径（相对 workspace root）或把 workspace root 设为更高一级目录

