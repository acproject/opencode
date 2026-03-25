import { defer } from "@/util/defer"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliRenderer } from "@opentui/core"

export namespace Editor {
  function toInt(input: unknown) {
    if (typeof input !== "number") return
    if (!Number.isFinite(input)) return
    const v = Math.trunc(input)
    if (v <= 0) return
    return v
  }

  function buildCommand(input: {
    editor: string
    filepath: string
    line?: number
    column?: number
  }): string[] {
    const parts = input.editor.split(" ").filter(Boolean)
    const bin = parts[0] ?? ""
    const line = toInt(input.line)
    const column = toInt(input.column)

    const isVSCode =
      bin === "code" || bin === "cursor" || bin === "codium" || bin === "code-insiders" || bin === "vscode"
    if (isVSCode) {
      if (line) {
        return [...parts, "--goto", `${input.filepath}:${line}${column ? ":" + column : ""}`]
      }
      return [...parts, input.filepath]
    }

    const isVim = bin === "vim" || bin === "nvim" || bin === "vi"
    if (isVim) {
      if (line && column) return [...parts, `+call cursor(${line},${column})`, input.filepath]
      if (line) return [...parts, `+${line}`, input.filepath]
      return [...parts, input.filepath]
    }

    const isHelix = bin === "hx" || bin === "helix"
    if (isHelix) {
      if (line) return [...parts, `${input.filepath}:${line}${column ? ":" + column : ""}`]
      return [...parts, input.filepath]
    }

    const isSublime = bin === "subl" || bin === "sublime_text"
    if (isSublime) {
      if (line) return [...parts, `${input.filepath}:${line}${column ? ":" + column : ""}`]
      return [...parts, input.filepath]
    }

    return [...parts, input.filepath]
  }

  export async function open(opts: { value: string; renderer: CliRenderer }): Promise<string | undefined> {
    const editor = process.env["VISUAL"] || process.env["EDITOR"]
    if (!editor) return

    const filepath = join(tmpdir(), `${Date.now()}.md`)
    await using _ = defer(async () => rm(filepath, { force: true }))

    await Bun.write(filepath, opts.value)
    opts.renderer.suspend()
    opts.renderer.currentRenderBuffer.clear()
    const parts = editor.split(" ")
    const proc = Bun.spawn({
      cmd: [...parts, filepath],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
    const content = await Bun.file(filepath).text()
    opts.renderer.currentRenderBuffer.clear()
    opts.renderer.resume()
    opts.renderer.requestRender()
    return content || undefined
  }

  export async function openFile(opts: {
    filepath: string
    renderer: CliRenderer
    line?: number
    column?: number
  }): Promise<string | undefined> {
    const editor = process.env["VISUAL"] || process.env["EDITOR"]
    if (!editor) return

    opts.renderer.suspend()
    opts.renderer.currentRenderBuffer.clear()
    const cmd = buildCommand({ editor, filepath: opts.filepath, line: opts.line, column: opts.column })
    const proc = Bun.spawn({
      cmd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
    const content = await Bun.file(opts.filepath)
      .text()
      .catch(() => "")
    opts.renderer.currentRenderBuffer.clear()
    opts.renderer.resume()
    opts.renderer.requestRender()
    return content || undefined
  }
}
