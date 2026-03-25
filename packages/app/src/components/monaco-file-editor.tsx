import { createEffect, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useFile, type SelectedLineRange } from "@/context/file"

import "monaco-editor/min/vs/editor/editor.main.css"
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker"

type CompletionResponse = {
  items: {
    label: string
    insertText: string
  }[]
}

type MonacoFileEditorProps = {
  path: string
  contents: string
  cacheKey?: string
  class?: string
}

function getColorScheme() {
  const scheme = document.documentElement.dataset.colorScheme
  if (scheme === "dark" || scheme === "light") return scheme
  return "light"
}

function languageFromPath(path: string) {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf(".")
  const ext = dot === -1 ? "" : lower.slice(dot + 1)
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript"
    case "js":
    case "jsx":
      return "javascript"
    case "json":
    case "jsonc":
      return "json"
    case "css":
      return "css"
    case "scss":
      return "scss"
    case "less":
      return "less"
    case "html":
    case "htm":
      return "html"
    case "md":
    case "mdx":
      return "markdown"
    case "yml":
    case "yaml":
      return "yaml"
    case "sh":
    case "bash":
      return "shell"
    case "py":
      return "python"
    case "go":
      return "go"
    case "rs":
      return "rust"
    case "java":
      return "java"
    default:
      return "plaintext"
  }
}

const globalSelf = globalThis as any
if (!globalSelf.MonacoEnvironment) {
  globalSelf.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      if (label === "typescript" || label === "javascript") return new tsWorker()
      return new editorWorker()
    },
  }
}

let completionProviderRegistered = false
const completionLanguages = [
  "typescript",
  "javascript",
  "json",
  "css",
  "scss",
  "less",
  "html",
  "markdown",
  "yaml",
  "shell",
  "python",
  "go",
  "rust",
  "java",
  "plaintext",
]

export const MonacoFileEditor: Component<MonacoFileEditorProps> = (props) => {
  const sdk = useSDK()
  const file = useFile()

  const language = createMemo(() => languageFromPath(props.path))

  let container!: HTMLDivElement
  let monaco: typeof import("monaco-editor") | undefined
  let editor: import("monaco-editor").editor.IStandaloneCodeEditor | undefined
  let model: import("monaco-editor").editor.ITextModel | undefined
  let decorations: string[] = []
  let lastSavedValue = props.contents
  let saving = false

  const apiBase = createMemo(() => sdk.url.replace(/\/+$/, ""))

  const save = async () => {
    if (!editor || !model) return
    if (saving) return
    saving = true
    try {
      const content = model.getValue()
      const res = await fetch(`${apiBase()}/file/content`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": sdk.directory,
        },
        body: JSON.stringify({ path: props.path, content }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(text || `HTTP ${res.status}`)
      }
      lastSavedValue = content
      showToast({ variant: "success", title: "Saved", description: props.path })
    } catch (e: any) {
      showToast({ variant: "error", title: "Save failed", description: e?.message ?? String(e) })
    } finally {
      saving = false
    }
  }

  const postCompletion = async (input: {
    path: string
    language: string
    before: string
    after: string
    line: number
    column: number
    maxItems?: number
  }) => {
    const res = await fetch(`${apiBase()}/experimental/editor/completion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": sdk.directory,
      },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { items: [] } satisfies CompletionResponse
    return (await res.json().catch(() => ({ items: [] }))) as CompletionResponse
  }

  const applySelectionDecoration = (range: SelectedLineRange | null) => {
    if (!editor || !monaco) return
    decorations = editor.deltaDecorations(
      decorations,
      range
        ? [
            {
              range: new monaco.Range(range.start, 1, range.end, 1),
              options: {
                isWholeLine: true,
                className: "bg-surface-raised-base",
              },
            },
          ]
        : [],
    )
    if (range) {
      const line = Math.min(range.start, range.end)
      editor.revealLineInCenter(line)
    }
  }

  onMount(async () => {
    monaco = await import("monaco-editor")

    monaco.editor.setTheme(getColorScheme() === "dark" ? "vs-dark" : "vs")

    model = monaco.editor.createModel(
      props.contents,
      language(),
      monaco.Uri.from({ scheme: "opencode", path: `/${props.path}` }),
    )

    editor = monaco.editor.create(container, {
      model,
      minimap: { enabled: false },
      automaticLayout: true,
      readOnly: false,
      wordWrap: "off",
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      fontSize: 13,
      lineNumbers: "on",
      glyphMargin: false,
      fixedOverflowWidgets: true,
    })

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())

    editor.onDidScrollChange((e: { scrollTop: number; scrollLeft: number }) => {
      file.setScrollTop(props.path, e.scrollTop)
      file.setScrollLeft(props.path, e.scrollLeft)
    })

    editor.onDidChangeCursorSelection(() => {
      const sel = editor?.getSelection()
      if (!sel) return
      const start = Math.min(sel.startLineNumber, sel.endLineNumber)
      const end = Math.max(sel.startLineNumber, sel.endLineNumber)
      if (start === end && sel.startColumn === sel.endColumn) {
        file.setSelectedLines(props.path, null)
        return
      }
      file.setSelectedLines(props.path, { start, end })
    })

    const initialTop = file.scrollTop(props.path) ?? 0
    const initialLeft = file.scrollLeft(props.path) ?? 0
    editor.setScrollTop(initialTop)
    editor.setScrollLeft(initialLeft)

    applySelectionDecoration(file.selectedLines(props.path) ?? null)

    if (!completionProviderRegistered) {
      completionProviderRegistered = true

      for (const lang of completionLanguages) {
        monaco.languages.registerCompletionItemProvider(lang, {
          triggerCharacters: [".", "(", "[", "{", " ", "\n"],
          provideCompletionItems: async (
            m: import("monaco-editor").editor.ITextModel,
            position: import("monaco-editor").Position,
          ) => {
            const offset = m.getOffsetAt(position)
            const before = m.getValue().slice(Math.max(0, offset - 8000), offset)
            const after = m.getValue().slice(offset, Math.min(m.getValue().length, offset + 2000))

            const filePath =
              m.uri.scheme === "opencode" ? m.uri.path.replace(/^\//, "") : props.path

            const response = await postCompletion({
              path: filePath,
              language: m.getLanguageId(),
              before,
              after,
              line: position.lineNumber,
              column: position.column,
              maxItems: 5,
            })

            const word = m.getWordUntilPosition(position)
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            }

            return {
              suggestions: response.items.map((item) => ({
                label: item.label,
                kind: monaco!.languages.CompletionItemKind.Snippet,
                insertText: item.insertText,
                range,
              })),
            }
          },
        })
      }
    }

    onCleanup(() => {
      editor?.dispose()
      model?.dispose()
    })
  })

  createEffect(() => {
    if (!monaco || !model) return
    if (language() !== model.getLanguageId()) {
      monaco.editor.setModelLanguage(model, language())
    }
  })

  createEffect(() => {
    if (!editor || !monaco) return
    monaco.editor.setTheme(getColorScheme() === "dark" ? "vs-dark" : "vs")
  })

  createEffect(() => {
    if (!editor || !model) return
    if (props.cacheKey) {
      const value = props.contents
      if (value !== model.getValue()) {
        const prevTop = editor.getScrollTop()
        const prevLeft = editor.getScrollLeft()
        model.setValue(value)
        lastSavedValue = value
        editor.setScrollTop(prevTop)
        editor.setScrollLeft(prevLeft)
      }
    }
  })

  createEffect(() => {
    applySelectionDecoration(file.selectedLines(props.path) ?? null)
  })

  return <div ref={container} class={props.class} />
}
