import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util"
import { FileWatcher } from "@/file/watcher"
import { ShareNext } from "@/share"
import * as Effect from "effect/Effect"
import { Config } from "@/config"
import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { writeAndOpenTrace } from "../session/trace-view"
import { AppRuntime } from "@/effect/app-runtime"

export const InstanceBootstrap = Effect.gen(function* () {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  // everything depends on config so eager load it for nice traces
  yield* Config.Service.use((svc) => svc.get())
  // Plugin can mutate config so it has to be initialized before anything else.
  yield* Plugin.Service.use((svc) => svc.init())
  yield* Effect.all(
    [
      LSP.Service,
      ShareNext.Service,
      Format.Service,
      File.Service,
      FileWatcher.Service,
      Vcs.Service,
      Snapshot.Service,
    ].map((s) => Effect.forkDetach(s.use((i) => i.init()))),
  ).pipe(Effect.withSpan("InstanceBootstrap.init"))

  yield* Bus.Service.use((svc) =>
    svc.subscribeCallback(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        Project.setInitialized(Instance.project.id)
      }
    }),
  )

  // Auto-open HTML trace when a root session finishes a turn that spawned subagents.
  // Disabled by setting OPENCODE_AUTO_TRACE=0; also disabled under CI/tests.
  if (
    process.env.OPENCODE_AUTO_TRACE !== "0" &&
    process.env.CI !== "true" &&
    process.env.NODE_ENV !== "test" &&
    process.env.BUN_ENV !== "test"
  ) {
    yield* Bus.Service.use((bus) =>
      bus.subscribeCallback(SessionStatus.Event.Idle, async (payload) => {
        const sessionID = payload.properties.sessionID
        try {
          const info = await AppRuntime.runPromise(Session.Service.use((s) => s.get(sessionID))).catch(() => undefined)
          if (!info || info.parentID) return
          const messages = await AppRuntime.runPromise(
            Session.Service.use((s) => s.messages({ sessionID })),
          ).catch(() => [] as never[])
          const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant")
          if (!lastAssistant) return
          const spawnedSubagent = lastAssistant.parts.some((p) => p.type === "tool" && p.tool === "task")
          if (!spawnedSubagent) return
          const filepath = await writeAndOpenTrace(sessionID)
          process.stderr.write(`\n[auto-trace] ${filepath}\n`)
          Log.Default.info("auto-trace opened", { sessionID, filepath })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          Log.Default.warn("auto-trace failed", { sessionID, error: msg })
          process.stderr.write(`\n[auto-trace] failed: ${msg}\n`)
        }
      }),
    )
  }
}).pipe(Effect.withSpan("InstanceBootstrap"))
