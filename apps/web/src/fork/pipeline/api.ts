import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import {
  type EnvironmentId,
  PipelineFailure,
  type PipelineMutation,
  type ProjectId,
} from "@t3tools/contracts";
import type { PipelineStatsRange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

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

function request<A, E, R extends never>(
  environmentId: EnvironmentId,
  input: PipelineRequest<{ readonly data: A } | { readonly error: string }, E, R>,
) {
  return Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
    registry.run(
      environmentId,
      executeConnectedEnvironmentHttpRequest({
        ...input,
        group: "pipeline",
        timeoutMs: 25_000,
      }),
    ),
  ).pipe(
    Effect.flatMap((response) =>
      "error" in response
        ? Effect.fail(new PipelineFailure({ message: response.error }))
        : Effect.succeed(response.data),
    ),
  );
}

export const pipelineBoardAtom = Atom.family((hub: EnvironmentId) =>
  connectionAtomRuntime.atom(
    request(hub, {
      method: "GET",
      url: (urls) => urls.board(),
      request: ({ client, headers }) => recoverConflict(client.board({ headers })),
    }),
  ),
);

const projectQueries = Atom.family((key: string) => {
  const [hub, hostId] = JSON.parse(key) as [EnvironmentId, EnvironmentId];
  return connectionAtomRuntime.atom(
    request(hub, {
      method: "GET",
      url: (urls) => urls.projects({ query: { hostId } }),
      request: ({ client, headers }) =>
        recoverConflict(client.projects({ headers, query: { hostId } })),
    }),
  );
});

export const pipelineProjectsAtom = (hub: EnvironmentId, hostId: EnvironmentId) =>
  projectQueries(JSON.stringify([hub, hostId]));

const issueQueries = Atom.family((key: string) => {
  const [hub, hostId, projectId] = JSON.parse(key) as [EnvironmentId, EnvironmentId, ProjectId];
  const query = { hostId, projectId };
  return connectionAtomRuntime.atom(
    request(hub, {
      method: "GET",
      url: (urls) => urls.issues({ query }),
      request: ({ client, headers }) => recoverConflict(client.issues({ headers, query })),
    }),
  );
});
export const pipelineIssuesAtom = (
  hub: EnvironmentId,
  hostId: EnvironmentId,
  projectId: ProjectId,
) => issueQueries(JSON.stringify([hub, hostId, projectId]));

const statsQueries = Atom.family((key: string) => {
  const [hub, hostId, projectId, range] = JSON.parse(key) as [
    EnvironmentId,
    EnvironmentId,
    ProjectId,
    PipelineStatsRange,
  ];
  const query = { hostId, projectId, range };
  return connectionAtomRuntime.atom(
    request(hub, {
      method: "GET",
      url: (urls) => urls.stats({ query }),
      request: ({ client, headers }) => recoverConflict(client.stats({ headers, query })),
    }),
  );
});
export const pipelineStatsAtom = (
  hub: EnvironmentId,
  hostId: EnvironmentId,
  projectId: ProjectId,
  range: PipelineStatsRange,
) => statsQueries(JSON.stringify([hub, hostId, projectId, range]));

export const mutate = (hub: EnvironmentId, payload: PipelineMutation) => {
  const operation = request(hub, {
    method: "POST",
    url: (urls) => urls.mutate(),
    request: ({ client, headers }) => recoverConflict(client.mutate({ headers, payload })),
  });
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) => Effect.provide(operation, context)),
    ),
  );
};
