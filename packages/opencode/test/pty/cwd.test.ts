import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import { Shell } from "../../src/shell/shell"
import { tmpdir } from "../fixture/fixture"

describe("pty.cwd", () => {
  test("connect directory can switch cwd repeatedly", async () => {
    await using tmp = await tmpdir({ git: true, config: { lsp: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dir1 = path.join(tmp.path, "dir1")
        const dir2 = path.join(tmp.path, "dir2")
        await fs.mkdir(dir1, { recursive: true })
        await fs.mkdir(dir2, { recursive: true })

        const info = await Pty.create({ command: Shell.preferred() })

        try {
          const ws1 = { readyState: 1, send: (_data: any) => {}, close: () => {} }
          Pty.connect(info.id, ws1 as any, { directory: dir1 })
          expect(Pty.get(info.id)?.cwd).toBe(dir1)

          const ws2 = { readyState: 1, send: (_data: any) => {}, close: () => {} }
          Pty.connect(info.id, ws2 as any, { directory: dir2 })
          expect(Pty.get(info.id)?.cwd).toBe(dir2)

          const ws3 = { readyState: 1, send: (_data: any) => {}, close: () => {} }
          Pty.connect(info.id, ws3 as any, { directory: `${dir1}\nINJECT` })
          expect(Pty.get(info.id)?.cwd).toBe(dir2)
        } finally {
          await Pty.remove(info.id)
        }
      },
    })
  }, 30000)
})

