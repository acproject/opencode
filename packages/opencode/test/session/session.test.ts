import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.started event", () => {
  test("should emit session.started event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: Session.Info | undefined

        const unsub = Bus.subscribe(Session.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as Session.Info
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(session.id)
        expect(receivedInfo?.projectID).toBe(session.projectID)
        expect(receivedInfo?.directory).toBe(session.directory)
        expect(receivedInfo?.title).toBe(session.title)

        await Session.remove(session.id)
      },
    })
  })

  test("session.started event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubStarted = Bus.subscribe(Session.Event.Created, () => {
          events.push("started")
        })

        const unsubUpdated = Bus.subscribe(Session.Event.Updated, () => {
          events.push("updated")
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsubStarted()
        unsubUpdated()

        expect(events).toContain("started")
        expect(events).toContain("updated")
        expect(events.indexOf("started")).toBeLessThan(events.indexOf("updated"))

        await Session.remove(session.id)
      },
    })
  })
})

describe("Session.importData", () => {
  test("should import exportData into current project and emit events", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await Session.create({})

        const userMessageID = Identifier.ascending("message")
        const userMessage: MessageV2.User = {
          id: userMessageID,
          role: "user",
          sessionID: created.id,
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        }
        await Session.updateMessage(userMessage)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessageID,
          sessionID: created.id,
          type: "text",
          text: "hello",
        })

        const exported = await Session.exportData(created.id)
        const newSessionID = Identifier.descending("session")

        let createdEvent = false
        let updatedEvent = false
        const unsubCreated = Bus.subscribe(Session.Event.Created, (evt) => {
          if (evt.properties.info.id === newSessionID) createdEvent = true
        })
        const unsubUpdated = Bus.subscribe(Session.Event.Updated, (evt) => {
          if (evt.properties.info.id === newSessionID) updatedEvent = true
        })

        const imported = await Session.importData({
          data: {
            ...exported,
            info: {
              ...exported.info,
              id: newSessionID,
              projectID: "other-project",
              directory: "/tmp",
              share: { url: "https://example.com" },
              revert: { messageID: "msg_fake" },
            },
          },
        })

        await new Promise((resolve) => setTimeout(resolve, 50))
        unsubCreated()
        unsubUpdated()

        expect(imported.id).toBe(newSessionID)
        expect(createdEvent).toBe(true)
        expect(updatedEvent).toBe(true)

        const reloaded = await Session.get(newSessionID)
        expect(reloaded.projectID).toBe(Instance.project.id)
        expect(reloaded.directory).toBe(Instance.directory)
        expect(reloaded.share).toBeUndefined()
        expect(reloaded.revert).toBeUndefined()

        const importedMessages = await Session.messages({ sessionID: newSessionID })
        expect(importedMessages.length).toBeGreaterThan(0)
        expect(importedMessages[0].info.sessionID).toBe(newSessionID)
        expect(importedMessages[0].parts.length).toBeGreaterThan(0)

        await Session.remove(created.id)
        await Session.remove(newSessionID)
      },
    })
  })
})
