import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { Permission } from "../permission"
import { Effect } from "effect"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"

const BASELINE_AGENT = "general"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the subagent to perform"),
  role: z
    .string()
    .describe(
      "A short role label for the subagent (e.g. 'security reviewer', 'api doc writer', 'migration planner'). Used in the session title and injected into the subagent's system context so it behaves in-character.",
    ),
  allowed_tools: z
    .array(z.string())
    .describe(
      "Allowlist of tool IDs the subagent may call (e.g. ['read','grep','glob']). When set, the subagent ONLY sees these tools; every other tool (write/edit/task/todowrite/bash/mcp/custom) is denied. Omit to use the baseline worker's default permissions — recommended only for interactive @-mention flows where the user has already picked the agent.",
    )
    .optional(),
  system_prompt: z
    .string()
    .describe(
      "System prompt defining how the subagent should behave: its goals, constraints, output format, verification steps. This fully defines the subagent — there is no pre-registered agent type to fall back to.",
    )
    .optional(),
  task_id: z
    .string()
    .describe(
      "Only set this if you mean to resume a previous task (pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one). The allowed_tools/role/system_prompt in this call update the subagent's scope going forward.",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      const baselineName =
        typeof ctx.extra?.subagentAgent === "string" && ctx.extra.subagentAgent.length > 0
          ? ctx.extra.subagentAgent
          : BASELINE_AGENT

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.role],
          always: ["*"],
          metadata: {
            description: params.description,
            role: params.role,
          },
        })
      }

      const next = yield* agent.get(baselineName)
      if (!next) {
        return yield* Effect.fail(new Error(`Baseline subagent "${baselineName}" is not registered`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      const hasAllowlist = !!params.allowed_tools && params.allowed_tools.length > 0

      if (hasAllowlist) {
        const caller = yield* agent.get(ctx.agent)
        if (!caller) {
          return yield* Effect.fail(new Error(`Calling agent "${ctx.agent}" is not registered`))
        }
        const callerSession = yield* sessions
          .get(ctx.sessionID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        const callerRuleset = Permission.merge(caller.permission, callerSession?.permission ?? [])
        const disallowed = params.allowed_tools!.filter(
          (t) => Permission.evaluate(t, "*", callerRuleset).action === "deny",
        )
        if (disallowed.length > 0) {
          return yield* Effect.fail(
            new Error(
              `Cannot delegate tools the calling agent does not own: ${disallowed.join(", ")}. ` +
                `The subagent's allowed_tools must be a subset of the calling agent's own tools.`,
            ),
          )
        }
      }

      const allowlistRules: Permission.Ruleset = hasAllowlist
        ? [
            { permission: "*", pattern: "*", action: "deny" as const },
            ...params.allowed_tools!.map((t) => ({
              permission: t,
              pattern: "*" as const,
              action: "allow" as const,
            })),
          ]
        : []

      const sessionPermission: Permission.Ruleset = [
        ...(canTodo
          ? []
          : [
              {
                permission: "todowrite" as const,
                pattern: "*" as const,
                action: "deny" as const,
              },
            ]),
        ...(canTask
          ? []
          : [
              {
                permission: id,
                pattern: "*" as const,
                action: "deny" as const,
              },
            ]),
        ...(cfg.experimental?.primary_tools?.map((item) => ({
          pattern: "*",
          action: "allow" as const,
          permission: item,
        })) ?? []),
        ...allowlistRules,
      ]

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: `${params.description} (@${params.role})`,
          permission: sessionPermission,
        }))

      if (session && hasAllowlist) {
        yield* sessions.setPermission({ sessionID: nextSession.id, permission: sessionPermission })
      }

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const messageID = MessageID.ascending()

      function cancel() {
        ops.cancel(nextSession.id)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const systemPieces = [`You are operating in the role of: ${params.role}.`, params.system_prompt].filter(
              (x): x is string => !!x,
            )
            const system = systemPieces.join("\n\n")
            const result = yield* ops.prompt({
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              agent: next.name,
              tools: {},
              system,
              parts,
            })

            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
