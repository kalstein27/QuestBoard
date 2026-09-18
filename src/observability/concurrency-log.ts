export interface ConcurrencyDiagnosticEvent {
  at: string;
  event: string;
  operation: string;
  actorId?: string | undefined;
  actorProvider?: string | undefined;
  taskId?: string | undefined;
  claimId?: string | undefined;
  requestId?: string | undefined;
  expectedRevision?: number | undefined;
  actualRevision?: number | undefined;
  attempt?: number | undefined;
  detail?: string | undefined;
}

export type ConcurrencyDiagnosticSink = (event: ConcurrencyDiagnosticEvent) => void;

export const NOOP_CONCURRENCY_DIAGNOSTIC_SINK: ConcurrencyDiagnosticSink = () => undefined;

export function createStderrConcurrencyDiagnosticSink(
  env: NodeJS.ProcessEnv = process.env,
): ConcurrencyDiagnosticSink {
  const enabled = env.QUESTBOARD_CONCURRENCY_LOG !== "0";
  if (!enabled) return NOOP_CONCURRENCY_DIAGNOSTIC_SINK;

  return (event) => {
    const line = JSON.stringify({
      source: "questboard",
      category: "concurrency",
      ...event,
    });
    process.stderr.write(`${line}\n`);
  };
}
