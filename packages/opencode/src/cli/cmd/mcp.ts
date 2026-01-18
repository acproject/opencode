import { cmd } from "./cmd"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "../../config/config"
import { Instance } from "../../project/instance"
import { Installation } from "../../installation"
import path from "path"
import { Global } from "../../global"
import fs from "fs/promises"
import { parse as parseJsonc, printParseErrorCode, type ParseError as JsoncParseError } from "jsonc-parser"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "○"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

type McpEntry = NonNullable<Config.Info["mcp"]>[string]

type McpConfigured = Config.Mcp
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function parseCommandLine(input: string): string[] {
  const out: string[] = []

  let cur = ""
  let quote: "'" | '"' | null = null
  let escaped = false

  const push = () => {
    if (!cur) return
    out.push(cur)
    cur = ""
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    cur += ch
  }
  push()

  return out
}

function parseEnvironmentPairs(input: string): Record<string, string> {
  const trimmed = input.trim()
  if (!trimmed) return {}

  const out: Record<string, string> = {}
  for (const partRaw of trimmed.split(",").map((s) => s.trim())) {
    if (!partRaw) continue
    const eqIndex = partRaw.indexOf("=")
    if (eqIndex <= 0) continue
    const key = partRaw.slice(0, eqIndex).trim()
    const value = partRaw.slice(eqIndex + 1).trim()
    if (!key) continue
    out[key] = value
  }
  return out
}

async function readJsoncObject(filepath: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(filepath)
    .text()
    .catch((err) => {
      if (err?.code === "ENOENT") return ""
      throw err
    })
  if (!text.trim()) return {}

  const errors: JsoncParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const first = errors[0]
    const before = text.slice(0, first.offset)
    const line = before.split("\n").length
    const col = before.split("\n").at(-1)!.length + 1
    const code = printParseErrorCode(first.error)
    throw new Error(`Invalid JSONC in ${filepath} (${code} at ${line}:${col})`)
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  return data as Record<string, unknown>
}

async function writeJsonObject(filepath: string, data: Record<string, unknown>) {
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, JSON.stringify(data, null, 2))
}

async function upsertMcpIntoFile(opts: { filepath: string; name: string; entry: Config.Mcp }) {
  const existing = await readJsoncObject(opts.filepath)
  const existingMcp = existing["mcp"]
  const mcp =
    existingMcp && typeof existingMcp === "object" && !Array.isArray(existingMcp)
      ? (existingMcp as Record<string, unknown>)
      : {}

  if (mcp[opts.name] !== undefined) {
    const overwrite = await prompts.confirm({
      message: `MCP server "${opts.name}" already exists in ${opts.filepath}. Overwrite?`,
      initialValue: false,
    })
    if (prompts.isCancel(overwrite)) throw new UI.CancelledError()
    if (!overwrite) {
      prompts.outro("Cancelled")
      return { written: false as const }
    }
  }

  const updated: Record<string, unknown> = { ...existing }
  if (!updated["$schema"]) updated["$schema"] = "https://opencode.ai/config.json"
  updated["mcp"] = { ...mcp, [opts.name]: opts.entry }

  await writeJsonObject(opts.filepath, updated)
  return { written: true as const }
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpStartCommand)
      .command(McpAddCommand)
      .command(McpImportCommand)
      .command(McpListCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpStartCommand = cmd({
  command: "start",
  describe: "start opencode as an MCP server over stdio",
  builder: (yargs) =>
    yargs
      .option("provider", {
        type: "string",
        default: "opencode",
        describe: "tool provider ID",
      })
      .option("directory", {
        type: "string",
        describe: "project directory to serve tools for",
      }),
  async handler(args) {
    if (process.stderr.isTTY) {
      console.error("Starting OpenCode MCP server over stdio")
      console.error("This process stays running until the client disconnects")
      console.error('Note: MCP stdio is non-interactive; configure opencode.json "permission" to allow tools')
    }
    await Instance.provide({
      directory: args.directory ?? process.cwd(),
      async fn() {
        await MCP.startLocalServer({ provider: args.provider })
      },
    })
  },
})

export const McpListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("MCP Servers")

        const config = await Config.get()
        const mcpServers = config.mcp ?? {}
        const statuses = await MCP.status()

        const servers = Object.entries(mcpServers).filter((entry): entry is [string, McpConfigured] =>
          isMcpConfigured(entry[1]),
        )

        if (servers.length === 0) {
          prompts.log.warn("No MCP servers configured")
          prompts.outro("Add servers with: opencode mcp add")
          return
        }

        for (const [name, serverConfig] of servers) {
          const status = statuses[name]
          const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
          const hasStoredTokens = await MCP.hasStoredTokens(name)

          let statusIcon: string
          let statusText: string
          let hint = ""

          if (!status) {
            statusIcon = "○"
            statusText = "not initialized"
          } else if (status.status === "connected") {
            statusIcon = "✓"
            statusText = "connected"
            if (hasOAuth && hasStoredTokens) {
              hint = " (OAuth)"
            }
          } else if (status.status === "disabled") {
            statusIcon = "○"
            statusText = "disabled"
          } else if (status.status === "needs_auth") {
            statusIcon = "⚠"
            statusText = "needs authentication"
          } else if (status.status === "needs_client_registration") {
            statusIcon = "✗"
            statusText = "needs client registration"
            hint = "\n    " + status.error
          } else {
            statusIcon = "✗"
            statusText = "failed"
            hint = "\n    " + status.error
          }

          const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
          prompts.log.info(
            `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
          )
        }

        prompts.outro(`${servers.length} server(s)`)
      },
    })
  },
})

export const McpAuthCommand = cmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("MCP OAuth Authentication")

        const config = await Config.get()
        const mcpServers = config.mcp ?? {}

        // Get OAuth-capable servers (remote servers with oauth not explicitly disabled)
        const oauthServers = Object.entries(mcpServers).filter(
          (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
        )

        if (oauthServers.length === 0) {
          prompts.log.warn("No OAuth-capable MCP servers configured")
          prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in opencode.json:")
          prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
          prompts.outro("Done")
          return
        }

        let serverName = args.name
        if (!serverName) {
          // Build options with auth status
          const options = await Promise.all(
            oauthServers.map(async ([name, cfg]) => {
              const authStatus = await MCP.getAuthStatus(name)
              const icon = getAuthStatusIcon(authStatus)
              const statusText = getAuthStatusText(authStatus)
              const url = cfg.url
              return {
                label: `${icon} ${name} (${statusText})`,
                value: name,
                hint: url,
              }
            }),
          )

          const selected = await prompts.select({
            message: "Select MCP server to authenticate",
            options,
          })
          if (prompts.isCancel(selected)) throw new UI.CancelledError()
          serverName = selected
        }

        const serverConfig = mcpServers[serverName]
        if (!serverConfig) {
          prompts.log.error(`MCP server not found: ${serverName}`)
          prompts.outro("Done")
          return
        }

        if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
          prompts.log.error(`MCP server ${serverName} is not an OAuth-capable remote server`)
          prompts.outro("Done")
          return
        }

        // Check if already authenticated
        const authStatus = await MCP.getAuthStatus(serverName)
        if (authStatus === "authenticated") {
          const confirm = await prompts.confirm({
            message: `${serverName} already has valid credentials. Re-authenticate?`,
          })
          if (prompts.isCancel(confirm) || !confirm) {
            prompts.outro("Cancelled")
            return
          }
        } else if (authStatus === "expired") {
          prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
        }

        const spinner = prompts.spinner()
        spinner.start("Starting OAuth flow...")

        try {
          const status = await MCP.authenticate(serverName)

          if (status.status === "connected") {
            spinner.stop("Authentication successful!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
            prompts.log.info("Add clientId to your MCP server config:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Unexpected status: " + status.status, 1)
          }
        } catch (error) {
          spinner.stop("Authentication failed", 1)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }

        prompts.outro("Done")
      },
    })
  },
})

export const McpAuthListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("MCP OAuth Status")

        const config = await Config.get()
        const mcpServers = config.mcp ?? {}

        // Get OAuth-capable servers
        const oauthServers = Object.entries(mcpServers).filter(
          (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
        )

        if (oauthServers.length === 0) {
          prompts.log.warn("No OAuth-capable MCP servers configured")
          prompts.outro("Done")
          return
        }

        for (const [name, serverConfig] of oauthServers) {
          const authStatus = await MCP.getAuthStatus(name)
          const icon = getAuthStatusIcon(authStatus)
          const statusText = getAuthStatusText(authStatus)
          const url = serverConfig.url

          prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
        }

        prompts.outro(`${oauthServers.length} OAuth-capable server(s)`)
      },
    })
  },
})

export const McpLogoutCommand = cmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("MCP OAuth Logout")

        const authPath = path.join(Global.Path.data, "mcp-auth.json")
        const credentials = await McpAuth.all()
        const serverNames = Object.keys(credentials)

        if (serverNames.length === 0) {
          prompts.log.warn("No MCP OAuth credentials stored")
          prompts.outro("Done")
          return
        }

        let serverName = args.name
        if (!serverName) {
          const selected = await prompts.select({
            message: "Select MCP server to logout",
            options: serverNames.map((name) => {
              const entry = credentials[name]
              const hasTokens = !!entry.tokens
              const hasClient = !!entry.clientInfo
              let hint = ""
              if (hasTokens && hasClient) hint = "tokens + client"
              else if (hasTokens) hint = "tokens"
              else if (hasClient) hint = "client registration"
              return {
                label: name,
                value: name,
                hint,
              }
            }),
          })
          if (prompts.isCancel(selected)) throw new UI.CancelledError()
          serverName = selected
        }

        if (!credentials[serverName]) {
          prompts.log.error(`No credentials found for: ${serverName}`)
          prompts.outro("Done")
          return
        }

        await MCP.removeAuth(serverName)
        prompts.log.success(`Removed OAuth credentials for ${serverName}`)
        prompts.outro("Done")
      },
    })
  },
})

export const McpAddCommand = cmd({
  command: "add",
  describe: "add an MCP server",
  async handler() {
    UI.empty()
    prompts.intro("Add MCP server")

    const name = await prompts.text({
      message: "Enter MCP server name",
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(name)) throw new UI.CancelledError()

    const saveTarget = await prompts.select({
      message: "Where should this configuration be saved?",
      options: [
        {
          label: "Global",
          value: "global",
          hint: path.join(Global.Path.config, "opencode.json"),
        },
        {
          label: "Project",
          value: "project",
          hint: path.join(process.cwd(), ".opencode", "opencode.json"),
        },
        {
          label: "Print only",
          value: "print",
          hint: "Do not write files",
        },
      ],
    })
    if (prompts.isCancel(saveTarget)) throw new UI.CancelledError()

    const type = await prompts.select({
      message: "Select MCP server type",
      options: [
        {
          label: "Local",
          value: "local",
          hint: "Run a local command",
        },
        {
          label: "Remote",
          value: "remote",
          hint: "Connect to a remote URL",
        },
      ],
    })
    if (prompts.isCancel(type)) throw new UI.CancelledError()

    if (type === "local") {
      const command = await prompts.text({
        message: "Enter command to run",
        placeholder: 'e.g., node /path/to/mcp_bridge.js',
        validate: (x) => (x && x.trim().length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(command)) throw new UI.CancelledError()

      const argv = parseCommandLine(command)
      if (argv.length === 0) {
        prompts.log.error("Invalid command")
        prompts.outro("Done")
        return
      }

      const envText = await prompts.text({
        message: "Environment variables (optional, KEY=VALUE, comma-separated)",
        placeholder: "e.g., MCP_SERVER_URL=http://localhost:8086",
      })
      if (prompts.isCancel(envText)) throw new UI.CancelledError()

      const enabled = await prompts.confirm({
        message: "Enable this server now?",
        initialValue: true,
      })
      if (prompts.isCancel(enabled)) throw new UI.CancelledError()

      const environment = parseEnvironmentPairs(envText)
      const entry: Config.Mcp = {
        type: "local",
        command: argv,
        ...(Object.keys(environment).length ? { environment } : {}),
        enabled,
      }

      if (saveTarget === "print") {
        prompts.log.info(`Add this to your opencode.json:`)
        prompts.log.info(
          JSON.stringify(
            {
              mcp: {
                [name]: entry,
              },
            },
            null,
            2,
          ),
        )
        prompts.outro("Done")
        return
      }

      const filepath =
        saveTarget === "global"
          ? path.join(Global.Path.config, "opencode.json")
          : path.join(process.cwd(), ".opencode", "opencode.json")
      const { written } = await upsertMcpIntoFile({ filepath, name, entry }).catch((err) => {
        prompts.log.error(err instanceof Error ? err.message : String(err))
        return { written: false as const }
      })
      if (!written) return

      prompts.log.success(`Saved MCP server "${name}" to ${filepath}`)
      prompts.outro("MCP server added successfully")
      return
    }

    if (type === "remote") {
      const url = await prompts.text({
        message: "Enter MCP server URL",
        placeholder: "e.g., https://example.com/mcp",
        validate: (x) => {
          if (!x) return "Required"
          if (x.length === 0) return "Required"
          const isValid = URL.canParse(x)
          return isValid ? undefined : "Invalid URL"
        },
      })
      if (prompts.isCancel(url)) throw new UI.CancelledError()

      const useOAuth = await prompts.confirm({
        message: "Does this server require OAuth authentication?",
        initialValue: false,
      })
      if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

      if (useOAuth) {
        const hasClientId = await prompts.confirm({
          message: "Do you have a pre-registered client ID?",
          initialValue: false,
        })
        if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

        const enabled = await prompts.confirm({
          message: "Enable this server now?",
          initialValue: true,
        })
        if (prompts.isCancel(enabled)) throw new UI.CancelledError()

        if (hasClientId) {
          const clientId = await prompts.text({
            message: "Enter client ID",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          })
          if (prompts.isCancel(clientId)) throw new UI.CancelledError()

          const hasSecret = await prompts.confirm({
            message: "Do you have a client secret?",
            initialValue: false,
          })
          if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

          let clientSecret: string | undefined
          if (hasSecret) {
            const secret = await prompts.password({
              message: "Enter client secret",
            })
            if (prompts.isCancel(secret)) throw new UI.CancelledError()
            clientSecret = secret
          }

          const entry: Config.Mcp = {
            type: "remote",
            url,
            enabled,
            oauth: {
              clientId,
              ...(clientSecret ? { clientSecret } : {}),
            },
          }

          if (saveTarget === "print") {
            const redacted: Config.Mcp = {
              ...entry,
              oauth: {
                clientId,
                ...(clientSecret ? { clientSecret: "REDACTED" } : {}),
              },
            }
            prompts.log.info(`Add this to your opencode.json:`)
            prompts.log.info(JSON.stringify({ mcp: { [name]: redacted } }, null, 2))
            prompts.outro("Done")
            return
          }

          const filepath =
            saveTarget === "global"
              ? path.join(Global.Path.config, "opencode.json")
              : path.join(process.cwd(), ".opencode", "opencode.json")
          const { written } = await upsertMcpIntoFile({ filepath, name, entry }).catch((err) => {
            prompts.log.error(err instanceof Error ? err.message : String(err))
            return { written: false as const }
          })
          if (!written) return

          prompts.log.success(`Saved MCP server "${name}" to ${filepath}`)
        } else {
          const entry: Config.Mcp = {
            type: "remote",
            url,
            enabled,
            oauth: {},
          }

          if (saveTarget === "print") {
            prompts.log.info(`Add this to your opencode.json:`)
            prompts.log.info(JSON.stringify({ mcp: { [name]: entry } }, null, 2))
            prompts.outro("Done")
            return
          }

          const filepath =
            saveTarget === "global"
              ? path.join(Global.Path.config, "opencode.json")
              : path.join(process.cwd(), ".opencode", "opencode.json")
          const { written } = await upsertMcpIntoFile({ filepath, name, entry }).catch((err) => {
            prompts.log.error(err instanceof Error ? err.message : String(err))
            return { written: false as const }
          })
          if (!written) return

          prompts.log.success(`Saved MCP server "${name}" to ${filepath}`)
        }
      } else {
        const enabled = await prompts.confirm({
          message: "Enable this server now?",
          initialValue: true,
        })
        if (prompts.isCancel(enabled)) throw new UI.CancelledError()

        const client = new Client({
          name: "opencode",
          version: "1.0.0",
        })
        const transport = new StreamableHTTPClientTransport(new URL(url))
        await client.connect(transport)

        const entry: Config.Mcp = {
          type: "remote",
          url,
          enabled,
          oauth: false,
        }

        if (saveTarget === "print") {
          prompts.log.info(`Add this to your opencode.json:`)
          prompts.log.info(JSON.stringify({ mcp: { [name]: entry } }, null, 2))
          prompts.outro("Done")
          return
        }

        const filepath =
          saveTarget === "global"
            ? path.join(Global.Path.config, "opencode.json")
            : path.join(process.cwd(), ".opencode", "opencode.json")
        const { written } = await upsertMcpIntoFile({ filepath, name, entry }).catch((err) => {
          prompts.log.error(err instanceof Error ? err.message : String(err))
          return { written: false as const }
        })
        if (!written) return

        prompts.log.success(`Saved MCP server "${name}" to ${filepath}`)
      }
    }

    prompts.outro("MCP server added successfully")
  },
})

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

function extractMcpImportMap(input: unknown, name?: string): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) return

  const fromMcpField = (() => {
    const mcp = input["mcp"]
    if (!isPlainObject(mcp)) return
    if (name) {
      if (mcp[name] === undefined) return
      return { [name]: mcp[name] }
    }
    return mcp
  })()
  if (fromMcpField) return fromMcpField

  if (name) {
    if ("type" in input) return { [name]: input }
    const maybe = input[name]
    if (maybe !== undefined) return { [name]: maybe }
    return
  }

  const entries = Object.entries(input)
  if (entries.length === 0) return {}
  const looksLikeMap = entries.every(([, v]) => isPlainObject(v) && "type" in v)
  if (looksLikeMap) return input
}

function redactForPrint(mcp: Record<string, Config.Mcp>): Record<string, Config.Mcp> {
  const out: Record<string, Config.Mcp> = {}
  for (const [name, entry] of Object.entries(mcp)) {
    if (entry.type === "remote" && entry.oauth && typeof entry.oauth === "object") {
      const oauth = entry.oauth.clientSecret ? { ...entry.oauth, clientSecret: "REDACTED" } : entry.oauth
      out[name] = { ...entry, oauth }
      continue
    }
    out[name] = entry
  }
  return out
}

async function upsertMcpsIntoFile(opts: {
  filepath: string
  entries: Record<string, Config.Mcp>
  overwrite: boolean
}) {
  const existing = await readJsoncObject(opts.filepath)
  const existingMcp = existing["mcp"]
  const currentMcp =
    existingMcp && typeof existingMcp === "object" && !Array.isArray(existingMcp)
      ? (existingMcp as Record<string, unknown>)
      : {}

  let changed = false
  const nextMcp: Record<string, unknown> = { ...currentMcp }
  const skipped: string[] = []
  const overwritten: string[] = []
  const added: string[] = []

  for (const [name, entry] of Object.entries(opts.entries)) {
    const exists = nextMcp[name] !== undefined
    if (exists && !opts.overwrite) {
      if (!process.stderr.isTTY) {
        skipped.push(name)
        continue
      }
      const confirm = await prompts.confirm({
        message: `MCP server "${name}" already exists in ${opts.filepath}. Overwrite?`,
        initialValue: false,
      })
      if (prompts.isCancel(confirm)) throw new UI.CancelledError()
      if (!confirm) {
        skipped.push(name)
        continue
      }
    }

    nextMcp[name] = entry
    changed = true
    if (exists) overwritten.push(name)
    else added.push(name)
  }

  if (!changed) return { written: false as const, added, overwritten, skipped }

  const updated: Record<string, unknown> = { ...existing }
  if (!updated["$schema"]) updated["$schema"] = "https://opencode.ai/config.json"
  updated["mcp"] = nextMcp
  await writeJsonObject(opts.filepath, updated)

  return { written: true as const, added, overwritten, skipped }
}

export const McpImportCommand = cmd({
  command: "import",
  describe: "import MCP server config from JSON/JSONC",
  builder: (yargs) =>
    yargs
      .option("file", { type: "string", describe: "path to JSON/JSONC file" })
      .option("json", { type: "string", describe: "inline JSON/JSONC" })
      .option("name", { type: "string", describe: "server name (when importing a single entry)" })
      .option("global", { type: "boolean", describe: "save to global config" })
      .option("project", { type: "boolean", describe: "save to project config" })
      .option("print", { type: "boolean", describe: "print only; do not write files" })
      .option("overwrite", { type: "boolean", default: false, describe: "overwrite existing servers" })
      .check((args) => {
        if (!args.file && !args.json) throw new Error("Must provide either --file or --json")
        if (args.file && args.json) throw new Error("Only one of --file or --json can be provided")
        const targets = [args.global, args.project, args.print].filter(Boolean).length
        if (targets > 1) throw new Error("Only one of --global, --project, or --print can be provided")
        return true
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("Import MCP servers")

    const inputText =
      args.json ??
      (await Bun.file(args.file!)
        .text()
        .catch((err) => {
          throw new Error(`Failed to read ${args.file}: ${err instanceof Error ? err.message : String(err)}`)
        }))

    const errors: JsoncParseError[] = []
    const parsed = parseJsonc(inputText, errors, { allowTrailingComma: true })
    if (errors.length) {
      const first = errors[0]
      const before = inputText.slice(0, first.offset)
      const line = before.split("\n").length
      const col = before.split("\n").at(-1)!.length + 1
      const code = printParseErrorCode(first.error)
      prompts.log.error(`Invalid JSONC (${code} at ${line}:${col})`)
      prompts.outro("Done")
      return
    }

    const map = extractMcpImportMap(parsed, args.name)
    if (!map) {
      prompts.log.error(
        'Invalid input. Provide either {"mcp": {...}} / { "<name>": {...} } / use --name with a single MCP entry.',
      )
      prompts.outro("Done")
      return
    }

    const validated: Record<string, Config.Mcp> = {}
    const failures: Array<{ name: string; message: string }> = []
    for (const [name, raw] of Object.entries(map)) {
      const result = Config.Mcp.safeParse(raw)
      if (!result.success) {
        failures.push({
          name,
          message: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        })
        continue
      }
      validated[name] = result.data
    }

    if (failures.length) {
      for (const f of failures) prompts.log.error(`${f.name}: ${f.message}`)
      prompts.outro("Done")
      return
    }

    if (!Object.keys(validated).length) {
      prompts.log.warn("No MCP servers found to import")
      prompts.outro("Done")
      return
    }

    const saveTarget = await (async () => {
      if (args.global) return "global" as const
      if (args.project) return "project" as const
      if (args.print) return "print" as const
      const selected = await prompts.select({
        message: "Where should this configuration be saved?",
        options: [
          { label: "Global", value: "global", hint: path.join(Global.Path.config, "opencode.json") },
          { label: "Project", value: "project", hint: path.join(process.cwd(), ".opencode", "opencode.json") },
          { label: "Print only", value: "print", hint: "Do not write files" },
        ],
      })
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      return selected as "global" | "project" | "print"
    })()

    if (saveTarget === "print") {
      const redacted = redactForPrint(validated)
      prompts.log.info(`Add this to your opencode.json:`)
      prompts.log.info(JSON.stringify({ mcp: redacted }, null, 2))
      prompts.outro("Done")
      return
    }

    const filepath =
      saveTarget === "global"
        ? path.join(Global.Path.config, "opencode.json")
        : path.join(process.cwd(), ".opencode", "opencode.json")

    const result = await upsertMcpsIntoFile({ filepath, entries: validated, overwrite: !!args.overwrite }).catch((err) => {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      return undefined
    })
    if (!result) return
    if (!result.written) {
      if (result.skipped.length) prompts.log.warn(`Skipped: ${result.skipped.join(", ")}`)
      prompts.outro("Done")
      return
    }

    prompts.log.success(`Saved ${Object.keys(validated).length} MCP server(s) to ${filepath}`)
    if (result.added.length) prompts.log.info(`Added: ${result.added.join(", ")}`)
    if (result.overwritten.length) prompts.log.info(`Overwritten: ${result.overwritten.join(", ")}`)
    if (result.skipped.length) prompts.log.warn(`Skipped: ${result.skipped.join(", ")}`)
    prompts.outro("Done")
  },
})

export const McpDebugCommand = cmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("MCP OAuth Debug")

        const config = await Config.get()
        const mcpServers = config.mcp ?? {}
        const serverName = args.name

        const serverConfig = mcpServers[serverName]
        if (!serverConfig) {
          prompts.log.error(`MCP server not found: ${serverName}`)
          prompts.outro("Done")
          return
        }

        if (!isMcpRemote(serverConfig)) {
          prompts.log.error(`MCP server ${serverName} is not a remote server`)
          prompts.outro("Done")
          return
        }

        if (serverConfig.oauth === false) {
          prompts.log.warn(`MCP server ${serverName} has OAuth explicitly disabled`)
          prompts.outro("Done")
          return
        }

        prompts.log.info(`Server: ${serverName}`)
        prompts.log.info(`URL: ${serverConfig.url}`)

        // Check stored auth status
        const authStatus = await MCP.getAuthStatus(serverName)
        prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)

        const entry = await McpAuth.get(serverName)
        if (entry?.tokens) {
          prompts.log.info(`  Access token: ${entry.tokens.accessToken.substring(0, 20)}...`)
          if (entry.tokens.expiresAt) {
            const expiresDate = new Date(entry.tokens.expiresAt * 1000)
            const isExpired = entry.tokens.expiresAt < Date.now() / 1000
            prompts.log.info(`  Expires: ${expiresDate.toISOString()} ${isExpired ? "(EXPIRED)" : ""}`)
          }
          if (entry.tokens.refreshToken) {
            prompts.log.info(`  Refresh token: present`)
          }
        }
        if (entry?.clientInfo) {
          prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)
          if (entry.clientInfo.clientSecretExpiresAt) {
            const expiresDate = new Date(entry.clientInfo.clientSecretExpiresAt * 1000)
            prompts.log.info(`  Client secret expires: ${expiresDate.toISOString()}`)
          }
        }

        const spinner = prompts.spinner()
        spinner.start("Testing connection...")

        // Test basic HTTP connectivity first
        try {
          const response = await fetch(serverConfig.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "opencode-debug", version: Installation.VERSION },
              },
              id: 1,
            }),
          })

          spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)

          // Check for WWW-Authenticate header
          const wwwAuth = response.headers.get("www-authenticate")
          if (wwwAuth) {
            prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
          }

          if (response.status === 401) {
            prompts.log.warn("Server returned 401 Unauthorized")

            // Try to discover OAuth metadata
            const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined
            const authProvider = new McpOAuthProvider(
              serverName,
              serverConfig.url,
              {
                clientId: oauthConfig?.clientId,
                clientSecret: oauthConfig?.clientSecret,
                scope: oauthConfig?.scope,
              },
              {
                onRedirect: async () => {},
              },
            )

            prompts.log.info("Testing OAuth flow (without completing authorization)...")

            // Try creating transport with auth provider to trigger discovery
            const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
              authProvider,
            })

            try {
              const client = new Client({
                name: "opencode-debug",
                version: Installation.VERSION,
              })
              await client.connect(transport)
              prompts.log.success("Connection successful (already authenticated)")
              await client.close()
            } catch (error) {
              if (error instanceof UnauthorizedError) {
                prompts.log.info(`OAuth flow triggered: ${error.message}`)

                // Check if dynamic registration would be attempted
                const clientInfo = await authProvider.clientInformation()
                if (clientInfo) {
                  prompts.log.info(`Client ID available: ${clientInfo.client_id}`)
                } else {
                  prompts.log.info("No client ID - dynamic registration will be attempted")
                }
              } else {
                prompts.log.error(`Connection error: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } else if (response.status >= 200 && response.status < 300) {
            prompts.log.success("Server responded successfully (no auth required or already authenticated)")
            const body = await response.text()
            try {
              const json = JSON.parse(body)
              if (json.result?.serverInfo) {
                prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)
              }
            } catch {
              // Not JSON, ignore
            }
          } else {
            prompts.log.warn(`Unexpected status: ${response.status}`)
            const body = await response.text().catch(() => "")
            if (body) {
              prompts.log.info(`Response body: ${body.substring(0, 500)}`)
            }
          }
        } catch (error) {
          spinner.stop("Connection failed", 1)
          prompts.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
        }

        prompts.outro("Debug complete")
      },
    })
  },
})
