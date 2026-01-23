import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { onMount, type JSX } from "solid-js"
import { Clipboard } from "@tui/util/clipboard"
import { useTextareaKeybindings } from "../component/textarea-keybindings"
import { useRenderer } from "@opentui/solid"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const renderer = useRenderer()
  let textarea: TextareaRenderable
  const textareaKeybindings = useTextareaKeybindings()

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      renderer.currentFocusedRenderable?.blur()
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box gap={1}>
        {props.description}
        <textarea
          onSubmit={() => {
            props.onConfirm?.(textarea.plainText)
          }}
          minHeight={3}
          maxHeight={12}
          keyBindings={textareaKeybindings()}
          onKeyDown={async (e) => {
            if (e.name === "escape") {
              e.preventDefault()
              props.onCancel?.()
              return
            }
            if (e.name === "return" && (e.shift || e.meta)) {
              e.preventDefault()
              textarea.insertText("\n")
              setTimeout(() => {
                textarea.getLayoutNode().markDirty()
                renderer.requestRender()
              }, 0)
              return
            }
            if (e.name === "v" && (e.ctrl || e.meta)) {
              const content = await Clipboard.read()
              if (content?.mime === "text/plain" && content.data) {
                e.preventDefault()
                textarea.insertText(Clipboard.sanitizeTextForTuiInput(content.data))
                setTimeout(() => {
                  textarea.getLayoutNode().markDirty()
                  textarea.gotoBufferEnd()
                }, 0)
              }
            }
          }}
          ref={(val: TextareaRenderable) => (textarea = val)}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
