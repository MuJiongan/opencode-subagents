import z from "zod"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./websearch.txt"
import { Auth } from "@/auth"

const PARALLEL_URL = "https://api.parallel.ai/v1beta/search"

type ParallelResult = {
  url: string
  title: string
  publish_date?: string | null
  excerpts: string[]
}

type ParallelResponse = {
  search_id?: string
  results?: ParallelResult[]
  warnings?: unknown
}

const Parameters = z.object({
  query: z.string().describe("Web search query. Use concrete keywords; include the current year when asking about recent events."),
  objective: z
    .string()
    .optional()
    .describe(
      "Natural-language description of what you are trying to learn from the search. Optional; defaults to the query when omitted.",
    ),
  numResults: z
    .number()
    .optional()
    .describe("Upper bound on the number of search results (default: 8). Not guaranteed."),
  mode: z
    .enum(["fast", "base", "pro"])
    .optional()
    .describe(
      "Search mode - 'fast' (default, low latency), 'base' (balanced), or 'pro' (higher quality, slower).",
    ),
  contextMaxCharacters: z
    .number()
    .optional()
    .describe("Maximum characters per result excerpt, optimized for LLM context (default: 6000)"),
})

function formatResults(data: ParallelResponse): string {
  const results = data.results ?? []
  if (results.length === 0) return ""
  return results
    .map((r, i) => {
      const header = [`[${i + 1}] ${r.title}`, `URL: ${r.url}`]
      if (r.publish_date) header.push(`Published: ${r.publish_date}`)
      const body = r.excerpts?.length ? `\n\n${r.excerpts.join("\n\n")}` : ""
      return header.join("\n") + body
    })
    .join("\n\n---\n\n")
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const auth = yield* Auth.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              objective: params.objective,
              numResults: params.numResults,
              mode: params.mode,
              contextMaxCharacters: params.contextMaxCharacters,
            },
          })

          const stored = yield* auth.get("parallel").pipe(Effect.orElseSucceed(() => undefined))
          const apiKey = (stored?.type === "api" ? stored.key : undefined) ?? process.env.PARALLEL_API_KEY
          if (!apiKey) {
            return {
              output:
                "No Parallel API key configured. In the TUI, run `/parallel` to set one, or export PARALLEL_API_KEY. Get a key at https://platform.parallel.ai.",
              title: `Web search: ${params.query}`,
              metadata: {},
            }
          }

          const request = yield* HttpClientRequest.post(PARALLEL_URL).pipe(
            HttpClientRequest.setHeader("x-api-key", apiKey),
            HttpClientRequest.accept("application/json"),
            HttpClientRequest.bodyJson({
              objective: params.objective ?? params.query,
              search_queries: [params.query],
              mode: params.mode ?? "fast",
              max_results: params.numResults ?? 8,
              excerpts: { max_chars_per_result: params.contextMaxCharacters ?? 6000 },
            }),
          )

          const response = yield* HttpClient.filterStatusOk(http)
            .execute(request)
            .pipe(
              Effect.timeoutOrElse({
                duration: "25 seconds",
                orElse: () => Effect.die(new Error("Parallel search request timed out")),
              }),
            )

          const data = (yield* response.json) as ParallelResponse
          const output = formatResults(data)

          return {
            output: output || "No search results found. Please try a different query.",
            title: `Web search: ${params.query}`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
