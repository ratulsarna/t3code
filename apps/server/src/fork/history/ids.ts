import { ProjectId, ThreadId } from "@t3tools/contracts";

export const bbThreadId = (id: string) => ThreadId.make(`bb-${id}`);
export const bbProjectId = (id: string) => ProjectId.make(`bb-${id}`);
