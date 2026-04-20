import z from "zod"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpExa from "./mcp-exa"
import * as Parallel from "./parallel-search"
import { Auth } from "@/auth"
import DESCRIPTION from "./websearch.txt"

const Parameters = z.object({
  query: z.string().describe("Websearch query"),
  numResults: z.number().optional().describe("Number of search results to return (default: 8)"),
  livecrawl: z
    .enum(["fallback", "preferred"])
    .optional()
    .describe(
      "Live crawl mode (Exa fallback provider only) - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
    ),
  type: z
    .enum(["auto", "fast", "deep"])
    .optional()
    .describe(
      "Search type (Exa fallback provider only) - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
    ),
  contextMaxCharacters: z
    .number()
    .optional()
    .describe("Maximum characters for context string optimized for LLMs (default: 10000)"),
})

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const auth = yield* Auth.Service

    const resolveKey = (providerID: string, envKey: string) =>
      Effect.gen(function* () {
        const entry = yield* auth.get(providerID).pipe(Effect.orElseSucceed(() => undefined))
        if (entry && entry.type === "api") return entry.key
        return process.env[envKey] || undefined
      })

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
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
            },
          })

          const maxResults = params.numResults ?? 8
          const maxChars = params.contextMaxCharacters ?? 10000

          const parallelKey = yield* resolveKey("parallel", "PARALLEL_API_KEY")
          if (parallelKey) {
            const parallelResult = yield* Parallel.call(
              http,
              parallelKey,
              {
                objective: params.query,
                search_queries: [params.query],
                max_results: maxResults,
                excerpts: { max_chars_per_result: maxChars },
              },
              "30 seconds",
            )
            if (parallelResult) {
              return {
                output: parallelResult,
                title: `Web search: ${params.query}`,
                metadata: { provider: "parallel" },
              }
            }
          }

          const exaKey = yield* resolveKey("exa", "EXA_API_KEY")
          const result = yield* McpExa.call(
            http,
            "web_search_exa",
            McpExa.SearchArgs,
            {
              query: params.query,
              type: params.type || "auto",
              numResults: maxResults,
              livecrawl: params.livecrawl || "fallback",
              contextMaxCharacters: maxChars,
            },
            "25 seconds",
            exaKey,
          )

          return {
            output: result ?? "No search results found. Please try a different query.",
            title: `Web search: ${params.query}`,
            metadata: { provider: "exa" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
