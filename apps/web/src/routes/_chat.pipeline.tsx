import { createFileRoute } from "@tanstack/react-router";

import { PipelinePage } from "../fork/pipeline/PipelinePage";

export const Route = createFileRoute("/_chat/pipeline")({ component: PipelinePage });
