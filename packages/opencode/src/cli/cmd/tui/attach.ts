import { cmd } from "../cmd"
import { tui } from "./app"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      }),
  handler: async (args) => {
    if (args.dir) process.chdir(args.dir)
    const directory = (() => {
      if (args.dir) return process.cwd()
      try {
        const url = new URL(args.url)
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") return process.cwd()
      } catch {}
      return undefined
    })()
    await tui({
      url: args.url,
      args: { sessionID: args.session },
      directory,
    })
  },
})
