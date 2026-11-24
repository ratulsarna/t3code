import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  PipelineFailure,
  PipelineReport,
  PipelineScopeRequired,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { Pipeline, layer as layerService } from "./service.ts";

export { layerService };

const isPipelineFailure = Schema.is(PipelineFailure);

const requireScope = (scope: AuthEnvironmentScope) =>
  Effect.flatMap(EnvironmentAuthenticatedPrincipal, (principal) =>
    principal.scopes.has(scope)
      ? Effect.void
      : Effect.fail(
          new PipelineScopeRequired({
            message: "The session does not grant this Pipeline operation.",
          }),
        ),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pipeline",
  Effect.fnUntraced(function* (handlers) {
    const pipeline = yield* Pipeline;
    return handlers
      .handle("board", () =>
        requireScope(AuthOrchestrationReadScope).pipe(Effect.andThen(pipeline.board)),
      )
      .handle("projects", ({ query }) =>
        requireScope(AuthOrchestrationReadScope).pipe(
          Effect.andThen(pipeline.projects(query.hostId)),
        ),
      )
      .handle("mutate", ({ payload }) =>
        requireScope(AuthOrchestrationOperateScope).pipe(Effect.andThen(pipeline.mutate(payload))),
      );
  }),
);

export const layerReports = Layer.unwrap(
  Pipeline.pipe(
    Effect.map(({ store }) =>
      HttpRouter.add(
        "POST",
        "/api/fork/pipeline/cards/:cardId/report",
        Effect.gen(function* () {
          const { cardId } = yield* HttpRouter.params;
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!store) return HttpServerResponse.empty({ status: 404 });
          const token = /^Bearer ([\w-]+)$/i.exec(request.headers.authorization ?? "")?.[1];
          if (!cardId || !token || !store.authorize(cardId, token)) {
            return HttpServerResponse.empty({ status: 401 });
          }
          if (
            request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
            "application/json"
          ) {
            return HttpServerResponse.empty({ status: 415 });
          }
          const payload = yield* HttpServerRequest.schemaBodyJson(PipelineReport).pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32 * 1024)),
            Effect.result,
          );
          if (payload._tag === "Failure") return HttpServerResponse.empty({ status: 400 });
          return yield* Effect.try({
            try: () => store.report(cardId, payload.success),
            catch: (error) => ({
              detail: isPipelineFailure(error) ? error.message : null,
            }),
          }).pipe(
            Effect.map(() => HttpServerResponse.empty({ status: 204 })),
            Effect.catch(({ detail }) =>
              Effect.succeed(
                detail === null
                  ? HttpServerResponse.empty({ status: 500 })
                  : HttpServerResponse.text(detail, { status: 409 }),
              ),
            ),
          );
        }),
      ),
    ),
  ),
);
