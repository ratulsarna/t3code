import { ProjectId, ThreadId } from "@t3tools/contracts";

const bbIdPrefix = "bb-";

export const bbThreadId = (id: string) => ThreadId.make(bbIdPrefix + id);
export const bbSourceThreadId = (id: string) =>
  id.startsWith(bbIdPrefix) ? id.slice(bbIdPrefix.length) : null;
export const bbProjectId = (id: string) => ProjectId.make(`bb-${id}`);
