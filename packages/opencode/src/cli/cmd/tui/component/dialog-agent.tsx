import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useRenderer } from "@opentui/solid"
import { Editor } from "@tui/util/editor"
import open from "open"
import path from "path"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()
  const sync = useSync()
  const renderer = useRenderer()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: item.native ? "native" : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title="Select agent"
      current={local.agent.current().name}
      options={options()}
      keybind={[
        {
          keybind: { name: "e", ctrl: false, meta: false, shift: false, super: false, leader: false },
          title: "Edit",
          onTrigger: async (option) => {
            const agent = local.agent.list().find((x) => x.name === option.value)
            if (!agent) return
            if (agent.native) {
              toast.show({
                variant: "warning",
                message: `Cannot edit native agent: ${agent.name}`,
                duration: 3000,
              })
              return
            }

            const filepath = path.join(process.cwd(), ".opencode", "agent", ...agent.name.split("/")) + ".md"
            dialog.clear()

            if (process.env["VISUAL"] || process.env["EDITOR"]) {
              await Editor.openFile({ filepath, renderer })
              await sdk.client.instance.dispose()
              await sync.bootstrap()
              local.agent.set(agent.name)
              toast.show({
                variant: "info",
                message: `Updated agent: ${agent.name}`,
                duration: 3000,
              })
              return
            }

            await open(filepath).catch(() => {})
            toast.show({
              variant: "info",
              message: `Opened agent file: ${agent.name}`,
              duration: 3000,
            })
          },
        },
      ]}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
