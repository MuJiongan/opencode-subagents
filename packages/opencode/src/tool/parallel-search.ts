import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

const URL = "https://api.parallel.ai/v1beta/search"

const Excerpts = Schema.Struct({
  max_chars_per_result: Schema.optional(Schema.Number),
})

export const SearchArgs = Schema.Struct({
  objective: Schema.optional(Schema.String),
  search_queries: Schema.Array(Schema.String),
  max_results: Schema.optional(Schema.Number),
  excerpts: Schema.optional(Excerpts),
})

export type SearchArgsInput = Schema.Schema.Type<typeof SearchArgs>

const SearchResult = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  publish_date: Schema.optional(Schema.NullOr(Schema.String)),
  excerpts: Schema.optional(Schema.Array(Schema.String)),
})

const SearchResponse = Schema.Struct({
  search_id: Schema.optional(Schema.String),
  results: Schema.Array(SearchResult),
})

const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchResponse))

type ResultItem = Schema.Schema.Type<typeof SearchResult>

function format(results: readonly ResultItem[]) {
  return results
    .map((r, i) => {
      const lines: string[] = []
      lines.push(`## [${i + 1}] ${r.title ?? r.url}`)
      lines.push(`URL: ${r.url}`)
      if (r.publish_date) lines.push(`Published: ${r.publish_date}`)
      const excerpts = r.excerpts ?? []
      if (excerpts.length) {
        lines.push("")
        lines.push(excerpts.join("\n\n"))
      }
      return lines.join("\n")
    })
    .join("\n\n---\n\n")
}

export const call = (
  http: HttpClient.HttpClient,
  apiKey: string,
  args: SearchArgsInput,
  timeout: Duration.Input,
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(URL).pipe(
      HttpClientRequest.setHeaders({
        "x-api-key": apiKey,
        Accept: "application/json",
      }),
      HttpClientRequest.schemaBodyJson(SearchArgs)(args),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("parallel web search request timed out")),
        }),
      )
    const body = yield* response.text
    const parsed = yield* decodeResponse(body)
    if (!parsed.results.length) return undefined
    return format(parsed.results)
  })
