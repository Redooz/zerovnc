import { z } from "zod";
import { TaskSubmissionSchema } from "../../../../domain/tasks/contracts.ts";
import { GetTaskHandler, SubmitTaskHandler } from "../../../../application/handlers/task-handlers.ts";
import { errorJson, json } from "../http-responses.ts";

const MAX_BODY_BYTES = 64 * 1024;

// Maps the HTTP request/response to the handler contract. JSON field names
// (`task_id`, `estado`, `resumen`) are fixed by the challenge API.
export async function createTaskController(request: Request, handler: SubmitTaskHandler): Promise<Response> {
  const raw = await readBodyLimited(request);
  if (raw === null) return errorJson(413, "request body too large");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return errorJson(400, "body must be valid JSON");
  }

  const parsed = TaskSubmissionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    // Report the failing field paths only; never echo submitted values (passwords).
    return errorJson(400, `invalid request: ${invalidFields(parsed.error)}`);
  }

  try {
    const accepted = await handler.handle({
      tarea: parsed.data.tarea,
      escritorio: parsed.data.escritorio,
    });
    return json({ task_id: accepted.taskId }, 202);
  } catch {
    return errorJson(503, "agent is not accepting tasks");
  }
}

export async function getTaskController(taskId: string, handler: GetTaskHandler): Promise<Response> {
  const report = await handler.handle(taskId);
  return json({ estado: report.estado, resumen: report.resumen });
}

async function readBodyLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return null;
  return text;
}

function invalidFields(error: z.ZodError): string {
  return error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
}
