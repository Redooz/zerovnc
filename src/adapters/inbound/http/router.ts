import { TaskNotFoundError } from "../../../application/usecases/errors.ts";
import type { GetTaskHandler, SubmitTaskHandler } from "../../../application/handlers/task-handlers.ts";
import type { Logger } from "../../../application/ports/logger.ts";
import { isAuthorized } from "./auth.ts";
import { healthController } from "./controllers/health-controller.ts";
import { createTaskController, getTaskController } from "./controllers/tasks-controller.ts";
import { errorJson } from "./http-responses.ts";

export interface RouterDeps {
  readonly bearerToken: string;
  readonly submitTask: SubmitTaskHandler;
  readonly getTask: GetTaskHandler;
  readonly logger: Logger;
}

export function createRouter(deps: RouterDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    // Every endpoint requires the bearer token, per the challenge contract.
    if (!isAuthorized(request, deps.bearerToken)) {
      return errorJson(401, "missing or invalid bearer token");
    }
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" && path === "/health") {
        return healthController();
      }
      if (path === "/tasks") {
        if (request.method === "POST") return await createTaskController(request, deps.submitTask);
        return errorJson(405, "method not allowed");
      }
      const match = /^\/tasks\/([^/]+)$/.exec(path);
      if (match !== null && match[1] !== undefined) {
        if (request.method !== "GET") return errorJson(405, "method not allowed");
        return await getTaskController(decodeURIComponent(match[1]), deps.getTask);
      }
      return errorJson(404, "not found");
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        return errorJson(404, "task not found");
      }
      deps.logger.error("request failed", { reason: error instanceof Error ? error.name : "unknown" });
      return errorJson(500, "internal error");
    }
  };
}
