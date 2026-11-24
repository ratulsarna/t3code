import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { type EnvironmentId, type PipelineMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

type PipelineRequest<A, E, R> = Omit<
  Parameters<typeof executeConnectedEnvironmentHttpRequest<"pipeline", A, E, R>>[0],
  "group" | "timeoutMs"
>;

const recoverConflict = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map((data) => ({ data }) as const),
    Effect.catchIf(
      (cause) =>
        cause instanceof Error &&
        "_tag" in cause &&
        (cause._tag === "PipelineFailure" || cause._tag === "PipelineScopeRequired"),
      (cause) => Effect.succeed({ error: (cause as Error).message } as const),
    ),
  );

function send<A, E, R extends never>(
  environmentId: EnvironmentId,
  request: PipelineRequest<{ readonly data: A } | { readonly error: string }, E, R>,
  signal?: AbortSignal,
) {
  const operation = Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
    registry.run(
      environmentId,
      executeConnectedEnvironmentHttpRequest({
        ...request,
        group: "pipeline",
        timeoutMs: 25_000,
      }),
    ),
  );
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) => Effect.provide(operation, context)),
    ),
    signal ? { signal } : undefined,
  ).then((response) => {
    if ("error" in response) throw new Error(response.error);
    return response.data;
  });
}

export const readBoard = (hub: EnvironmentId, signal: AbortSignal) =>
  send(
    hub,
    {
      method: "GET",
      url: (urls) => urls.board(),
      request: ({ client, headers }) => recoverConflict(client.board({ headers })),
    },
    signal,
  );

export const readProjects = (hub: EnvironmentId, hostId: EnvironmentId, signal: AbortSignal) =>
  send(
    hub,
    {
      method: "GET",
      url: (urls) => urls.projects({ query: { hostId } }),
      request: ({ client, headers }) =>
        recoverConflict(client.projects({ headers, query: { hostId } })),
    },
    signal,
  );

export const mutate = (hub: EnvironmentId, payload: PipelineMutation) =>
  send(hub, {
    method: "POST",
    url: (urls) => urls.mutate(),
    request: ({ client, headers }) => recoverConflict(client.mutate({ headers, payload })),
  });
