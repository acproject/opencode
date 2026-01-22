import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("tui.selectSession endpoint", () => {
  test("should return 200 when called with valid session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // #given
        const session = await Session.create({})

        // #when
        const app = Server.App()
        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })

        // #then
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("should return 404 when session does not exist", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // #given
        const nonExistentSessionID = "ses_nonexistent123"

        // #when
        const app = Server.App()
        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: nonExistentSessionID }),
        })

        // #then
        expect(response.status).toBe(404)
      },
    })
  })

  test("should return 400 when session ID format is invalid", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // #given
        const invalidSessionID = "invalid_session_id"

        // #when
        const app = Server.App()
        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: invalidSessionID }),
        })

        // #then
        expect(response.status).toBe(400)
      },
    })
  })
})

describe("owiseman ollama passthrough endpoints", () => {
  test("GET /provider includes owiseman in connect list", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/provider", { method: "GET" })
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.all.some((p: any) => p.id === "owiseman")).toBe(true)
      },
    })
  })

  test("POST /api/v1/ollama/chat injects api-key and default model (non-stream)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const oldFetch = globalThis.fetch
        process.env["OWISEMAN_API_KEY"] = "test-key"
        try {
          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe("https://www.owiseman.com/api/v1/ollama/chat")
            expect(init?.method).toBe("POST")
            expect(init?.headers).toMatchObject({ "Content-Type": "application/json" })
            expect(init?.signal).toBeDefined()
            expect((init?.signal as AbortSignal).aborted).toBe(false)
            const parsed = JSON.parse(String(init?.body ?? "null"))
            expect(parsed["api-key"]).toBe("test-key")
            expect(parsed.model).toBe("nemotron-3-nano:30b")
            expect(parsed.stream).toBe(false)
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }) as typeof fetch

          const app = Server.App()
          const response = await app.request("/api/v1/ollama/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: "Count 1 to 10." }],
              stream: false,
            }),
          })

          expect(response.status).toBe(200)
          expect(response.headers.get("content-type")).toContain("application/json")
          expect(await response.json()).toEqual({ ok: true })
        } finally {
          globalThis.fetch = oldFetch
          delete process.env["OWISEMAN_API_KEY"]
        }
      },
    })
  })

  test("POST /api/v1/ollama/chat forwards api-key from request body when provided", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const oldFetch = globalThis.fetch
        try {
          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe("https://www.owiseman.com/api/v1/ollama/chat")
            expect(init?.signal).toBeDefined()
            expect((init?.signal as AbortSignal).aborted).toBe(false)
            const parsed = JSON.parse(String(init?.body ?? "null"))
            expect(parsed["api-key"]).toBe("request-key")
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }) as typeof fetch

          const app = Server.App()
          const response = await app.request("/api/v1/ollama/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              "api-key": "request-key",
              messages: [{ role: "user", content: "Count 1 to 10." }],
              stream: false,
            }),
          })

          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ ok: true })
        } finally {
          globalThis.fetch = oldFetch
        }
      },
    })
  })

  test("POST /api/v1/ollama/chat streams NDJSON passthrough by default", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const oldFetch = globalThis.fetch
        process.env["OWISEMAN_API_KEY"] = "test-key"
        try {
          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe("https://www.owiseman.com/api/v1/ollama/chat")
            expect(init?.method).toBe("POST")
            expect(init?.signal).toBeDefined()
            expect((init?.signal as AbortSignal).aborted).toBe(false)
            const parsed = JSON.parse(String(init?.body ?? "null"))
            expect(parsed["api-key"]).toBe("test-key")
            expect(parsed.model).toBe("nemotron-3-nano:30b")
            expect(parsed.stream).not.toBe(false)
            return new Response("line1\nline2\n", {
              status: 200,
              headers: { "Content-Type": "application/x-ndjson" },
            })
          }) as typeof fetch

          const app = Server.App()
          const response = await app.request("/api/v1/ollama/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: "Count 1 to 10." }],
            }),
          })

          expect(response.status).toBe(200)
          expect(response.headers.get("content-type")).toContain("application/x-ndjson")
          expect(await response.text()).toBe("line1\nline2\n")
        } finally {
          globalThis.fetch = oldFetch
          delete process.env["OWISEMAN_API_KEY"]
        }
      },
    })
  })

  test("POST /api/v1/ollama/generate injects api-key and default model (non-stream)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const oldFetch = globalThis.fetch
        process.env["OWISEMAN_API_KEY"] = "test-key"
        try {
          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe("https://www.owiseman.com/api/v1/ollama/generate")
            expect(init?.method).toBe("POST")
            expect(init?.signal).toBeDefined()
            expect((init?.signal as AbortSignal).aborted).toBe(false)
            const parsed = JSON.parse(String(init?.body ?? "null"))
            expect(parsed["api-key"]).toBe("test-key")
            expect(parsed.model).toBe("nemotron-3-nano:30b")
            expect(parsed.stream).toBe(false)
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }) as typeof fetch

          const app = Server.App()
          const response = await app.request("/api/v1/ollama/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: "Count 1 to 10.",
              stream: false,
            }),
          })

          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ ok: true })
        } finally {
          globalThis.fetch = oldFetch
          delete process.env["OWISEMAN_API_KEY"]
        }
      },
    })
  })

  test("GET /api/v1/ollama/models proxies to owiseman", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const oldFetch = globalThis.fetch
        process.env["OWISEMAN_API_KEY"] = "test-key"
        try {
          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe("https://www.owiseman.com/api/v1/ollama/models")
            expect(init?.method).toBe("GET")
            expect(init?.signal).toBeDefined()
            expect((init?.signal as AbortSignal).aborted).toBe(false)
            const headers = new Headers(init?.headers)
            expect(headers.get("api-key")).toBe("test-key")
            return new Response(JSON.stringify({ models: ["m1"] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }) as typeof fetch

          const app = Server.App()
          const response = await app.request("/api/v1/ollama/models", { method: "GET" })
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ models: ["m1"] })
        } finally {
          globalThis.fetch = oldFetch
          delete process.env["OWISEMAN_API_KEY"]
        }
      },
    })
  })
})
