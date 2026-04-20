import { createMemo, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { Keybind } from "@/util"
import { TextAttributes } from "@opentui/core"

type ProviderRow = {
  id: "parallel" | "exa"
  name: string
  description: string
  envVar: string
  role: "primary" | "fallback"
}

const PROVIDERS: ProviderRow[] = [
  {
    id: "parallel",
    name: "Parallel AI",
    description: "Default web search provider. Get a key at https://parallel.ai",
    envVar: "PARALLEL_API_KEY",
    role: "primary",
  },
  {
    id: "exa",
    name: "Exa AI",
    description: "Fallback provider. Used when Parallel is not configured. https://exa.ai",
    envVar: "EXA_API_KEY",
    role: "fallback",
  },
]

function Status(props: { configured: boolean; envFallback: boolean }) {
  const { theme } = useTheme()
  if (props.configured) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Key stored</span>
  }
  if (props.envFallback) {
    return <span style={{ fg: theme.textMuted }}>env var set</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Not configured</span>
}

export function DialogWebSearch() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const [stored, setStored] = createSignal<Record<string, boolean>>({})

  const options = createMemo<DialogSelectOption<ProviderRow["id"]>[]>(() => {
    const state = stored()
    return PROVIDERS.map((p) => ({
      value: p.id,
      title: p.name,
      description: p.description,
      category: p.role === "primary" ? "Primary" : "Fallback",
      footer: <Status configured={state[p.id] ?? false} envFallback={!state[p.id] && !!process.env[p.envVar]} />,
      onSelect: () => openPrompt(p),
    }))
  })

  const keybinds = createMemo(() => [
    {
      keybind: Keybind.parse("space")[0],
      title: "clear key",
      onTrigger: async (option: DialogSelectOption<ProviderRow["id"]>) => {
        const provider = PROVIDERS.find((p) => p.id === option.value)
        if (!provider) return
        const result = await sdk.client.auth.remove({ providerID: provider.id })
        if (result.error) {
          toast.show({ variant: "error", message: `Failed to clear ${provider.name} key` })
          return
        }
        setStored((s) => ({ ...s, [provider.id]: false }))
        toast.show({ variant: "info", message: `Cleared ${provider.name} API key` })
      },
    },
  ])

  function openPrompt(provider: ProviderRow) {
    dialog.replace(() => (
      <DialogPrompt
        title={`${provider.name} API key`}
        placeholder="API key"
        onConfirm={async (value) => {
          const key = value.trim()
          if (!key) {
            dialog.clear()
            return
          }
          const result = await sdk.client.auth.set({
            providerID: provider.id,
            auth: { type: "api", key },
          })
          if (result.error) {
            toast.show({ variant: "error", message: `Failed to save ${provider.name} key` })
            dialog.clear()
            return
          }
          setStored((s) => ({ ...s, [provider.id]: true }))
          toast.show({ variant: "info", message: `${provider.name} key saved` })
          dialog.replace(() => <DialogWebSearch />)
        }}
      />
    ))
  }

  return (
    <DialogSelect
      title="Web search providers"
      options={options()}
      keybind={keybinds()}
      onSelect={(option) => {
        option.onSelect?.(dialog)
      }}
    />
  )
}
