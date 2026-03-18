import z from "zod"
import { Tool } from "./tool"
import { Pty } from "@/pty"
import { Instance } from "@/project/instance"
import { Shell } from "@/shell/shell"

const DEFAULT_IDLE_MS = 250
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_CAPTURE_CHARS = 200_000
const MIN_CAPTURE_MS = 1500

function detectShellKind(shellPath: string) {
  const s = shellPath.toLowerCase()
  if (s.includes("powershell") || s.endsWith("pwsh")) return "powershell"
  if (s.endsWith("cmd.exe") || s.endsWith("\\cmd") || s.endsWith("/cmd")) return "cmd"
  return "posix"
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export const TerminalTool = Tool.define("terminal", {
  description:
    "Runs a shell command in a reusable terminal (PTY) session. Use this for interactive tools, long-running processes, and when you want subsequent commands to share shell state.",
  parameters: z.object({
    command: z.string().describe("Command to run in the terminal session"),
    cwd: z.string().optional().describe("Working directory for a new terminal session"),
    ptyID: z.string().optional().describe("Existing terminal session ID to reuse"),
    shell: z.string().optional().describe("Shell program to start for a new terminal session"),
    timeoutMs: z.number().optional().describe("Overall capture timeout in milliseconds (default 15000)"),
    idleMs: z.number().optional().describe("Stop capturing after idle milliseconds (default 250)"),
    keepAlive: z.boolean().optional().describe("Keep the terminal session alive (default true)"),
  }),
  async execute(params, ctx) {
    const command = params.command.trim()
    if (!command) throw new Error("command is required")

    await ctx.ask({
      permission: "bash",
      patterns: [command],
      always: ["*"],
      metadata: {
        command,
      },
    })

    const idleMs = Math.max(50, params.idleMs ?? DEFAULT_IDLE_MS)
    const timeoutMs = Math.max(250, params.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const stopOnIdle = params.idleMs !== undefined
    const keepAlive = params.keepAlive ?? true

    let info: Pty.Info | undefined
    if (params.ptyID) {
      info = Pty.get(params.ptyID)
      if (!info) {
        throw new Error(`Terminal session not found: ${params.ptyID}`)
      }
    } else {
      const shell = params.shell || Shell.preferred()
      const cwd = params.cwd || Instance.directory
      info = await Pty.create({
        command: shell,
        args: [],
        cwd,
        title: `Terminal ${command.split(/\s+/)[0] ?? "cmd"}`,
      })
    }

    const ptyID = info.id
    const shellKind = detectShellKind(info.command)
    const marker = `__opencode_done_${crypto.randomUUID()}__`
    const trimmed = command.replace(/[\r\n]+$/, "")
    const commandWithMarker =
      shellKind === "cmd"
        ? `${trimmed} & echo ${marker}`
        : shellKind === "powershell"
          ? `${trimmed}; Write-Output ${marker}`
          : `${trimmed}; printf "\\n${marker}\\n"`
    const enter = shellKind === "cmd" ? "\r\n" : "\r"
    const withEnter = commandWithMarker + enter

    let output = ""
    let timedOut = false

    await new Promise<void>((resolve) => {
      const startedAt = Date.now()
      let idleTimer: NodeJS.Timeout | undefined
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        cleanup()
        resolve()
      }, timeoutMs)

      const bumpIdle = () => {
        if (!stopOnIdle) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          const elapsed = Date.now() - startedAt
          const min = Math.min(MIN_CAPTURE_MS, timeoutMs)
          if (elapsed < min) {
            bumpIdle()
            return
          }
          cleanup()
          resolve()
        }, idleMs)
      }

      const onData = (data: string) => {
        output += data
        if (output.length > MAX_CAPTURE_CHARS) {
          output = output.slice(-MAX_CAPTURE_CHARS)
        }

        const markerMatch = output.match(new RegExp(String.raw`(?:\r?\n)${escapeRegExp(marker)}(?:\r?\n)`))
        const markerIndex = markerMatch?.index ?? -1
        if (markerIndex >= 0) output = output.slice(0, markerIndex)

        ctx.metadata({
          metadata: {
            output: output.trimEnd(),
            ptyID,
          },
        })

        if (markerIndex >= 0) {
          cleanup()
          resolve()
          return
        }

        bumpIdle()
      }

      const unsubscribe = Pty.listen(ptyID, onData)

      const cleanup = () => {
        clearTimeout(timeoutTimer)
        if (idleTimer) clearTimeout(idleTimer)
        unsubscribe?.()
      }

      Pty.write(ptyID, withEnter)
    })

    if (!keepAlive) {
      await Pty.remove(ptyID)
    }

    return {
      title: `Terminal: ${command.split(/\s+/)[0] ?? "command"}`,
      output: output.trimEnd(),
      metadata: {
        output: output.trimEnd(),
        ptyID,
        timedOut,
      },
    }
  },
})
