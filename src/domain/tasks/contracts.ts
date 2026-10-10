import { z } from "zod";

// Runtime-validated shapes for the task request and the status report.
// These are business-level contracts; HTTP field naming (task_id) is mapped in
// the inbound HTTP adapter.

export const DesktopAccessSchema = z.object({
  url: z
    .url()
    .refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
      message: "must be a ws:// or wss:// URL",
    }),
  password: z.string().min(1),
});

export const TaskSubmissionSchema = z.object({
  tarea: z.string().trim().min(1).max(4_000),
  escritorio: DesktopAccessSchema,
});

export type DesktopAccess = z.infer<typeof DesktopAccessSchema>;
export type TaskSubmission = z.infer<typeof TaskSubmissionSchema>;

// Status report returned by GET /tasks/{id}. `resumen` is an empty string while
// the task is still running.
export interface TaskStatusReport {
  readonly estado: "en_curso" | "terminada" | "fallida";
  readonly resumen: string;
}
