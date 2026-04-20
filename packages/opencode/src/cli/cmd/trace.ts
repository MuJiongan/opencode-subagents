import type { Argv } from "yargs"
import { promises as fs } from "fs"
import * as prompts from "@clack/prompts"
import { Session } from "../../session"
import { SessionID } from "../../session/schema"
import { renderTraceHtml } from "../../session/trace-view"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"

export const TraceCommand = cmd({
  command: "trace [sessionID]",
  describe: "render an HTML trace tree of a session and every subagent it spawned",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", { describe: "root session id", type: "string" })
      .option("out", { describe: "path to write HTML (default: stdout)", type: "string" })
      .option("scope-to-turn", {
        describe: "only include subagents spawned in each session's most recent activation",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined

      if (!sessionID) {
        UI.empty()
        prompts.intro("Trace session", { output: process.stderr })

        const sessions: Session.Info[] = []
        for await (const session of Session.list()) {
          sessions.push(session)
        }
        if (sessions.length === 0) {
          prompts.log.error("No sessions found", { output: process.stderr })
          prompts.outro("Done", { output: process.stderr })
          return
        }
        sessions.sort((a, b) => b.time.updated - a.time.updated)

        const selected = await prompts.autocomplete({
          message: "Select root session",
          maxItems: 10,
          options: sessions.map((s) => ({
            label: s.title,
            value: s.id,
            hint: `${new Date(s.time.updated).toLocaleString()} • ${s.id.slice(-8)}${s.parentID ? " • child" : ""}`,
          })),
          output: process.stderr,
        })
        if (prompts.isCancel(selected)) throw new UI.CancelledError()
        sessionID = selected as SessionID
        prompts.outro("Building trace…", { output: process.stderr })
      }

      try {
        const { html } = await renderTraceHtml(sessionID, { scopeToTurn: args["scope-to-turn"] as boolean })
        if (args.out) {
          await fs.writeFile(args.out, html, "utf8")
          process.stderr.write(`Wrote trace to ${args.out}\n`)
        } else {
          process.stdout.write(html)
        }
      } catch (err) {
        UI.error(`Failed to render trace: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })
  },
})
