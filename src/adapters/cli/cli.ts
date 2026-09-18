import { randomUUID } from "node:crypto";
import type { ActorRef } from "../../core/domain.js";
import type { QuestBoardService } from "../../application/quest-board-service.js";
import {
  describeQuestBoardError,
  executeQuestBoardAgentTool,
} from "../agent-tools.js";

export interface QuestBoardCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface QuestBoardCliOptions {
  defaultActor?: ActorRef;
  io?: QuestBoardCliIo;
}

const DEFAULT_ACTOR: ActorRef = { id: "cli:local", provider: "cli" };

export function runQuestBoardCli(
  service: QuestBoardService,
  argv: readonly string[],
  options: QuestBoardCliOptions = {},
): number {
  const io = options.io ?? {
    stdout: (value: string) => process.stdout.write(`${value}\n`),
    stderr: (value: string) => process.stderr.write(`${value}\n`),
  };

  try {
    const parsed = parseArgs(argv);
    if (parsed.positionals.length === 0 || parsed.positionals[0] === "help" || parsed.flags.has("help")) {
      io.stdout(helpText());
      return 0;
    }

    const actor = actorFrom(parsed.flags, options.defaultActor ?? DEFAULT_ACTOR);
    const requestId = parsed.flags.get("request-id") ?? `cli:${randomUUID()}`;
    const command = parsed.positionals[0];
    let result: unknown;

    switch (command) {
      case "projects":
        result = executeQuestBoardAgentTool(service, "questboard_list_projects");
        break;
      case "tasks":
        result = executeQuestBoardAgentTool(service, "questboard_list_tasks", compact({
          projectId: parsed.flags.get("project"),
          status: parsed.flags.get("status"),
        }));
        break;
      case "task":
        result = executeQuestBoardAgentTool(service, "questboard_get_task", {
          taskId: positional(parsed.positionals, 1, "task id"),
        });
        break;
      case "create-task":
        result = executeQuestBoardAgentTool(service, "questboard_create_task", compact({
          projectId: requiredFlag(parsed.flags, "project"),
          title: requiredFlag(parsed.flags, "title"),
          description: parsed.flags.get("description"),
          status: parsed.flags.get("status"),
          priority: parsed.flags.get("priority"),
          tags: splitTags(parsed.flags.get("tags")),
          requestId,
          actor,
        }));
        break;
      case "update-task":
        result = executeQuestBoardAgentTool(service, "questboard_update_task", compact({
          taskId: positional(parsed.positionals, 1, "task id"),
          expectedRevision: optionalPositiveIntegerFlag(parsed.flags, "revision"),
          title: parsed.flags.get("title"),
          description: parsed.flags.get("description"),
          status: parsed.flags.get("status"),
          priority: parsed.flags.get("priority"),
          tags: parsed.flags.has("tags") ? splitTags(parsed.flags.get("tags")) : undefined,
          requestId,
          actor,
        }));
        break;
      case "claim":
        result = executeQuestBoardAgentTool(service, "questboard_claim_task", {
          taskId: positional(parsed.positionals, 1, "task id"),
          requestId,
          actor,
        });
        break;
      case "release":
        result = executeQuestBoardAgentTool(service, "questboard_release_task", {
          taskId: positional(parsed.positionals, 1, "task id"),
          claimId: parsed.flags.get("claim-id"),
          requestId,
          actor,
        });
        break;
      case "claim-status":
        result = executeQuestBoardAgentTool(service, "questboard_get_claim", {
          taskId: positional(parsed.positionals, 1, "task id"),
        });
        break;
      case "activity":
        result = executeQuestBoardAgentTool(service, "questboard_list_activity", {
          taskId: positional(parsed.positionals, 1, "task id"),
        });
        break;
      case "add-activity":
        result = executeQuestBoardAgentTool(service, "questboard_add_activity", {
          taskId: positional(parsed.positionals, 1, "task id"),
          type: requiredFlag(parsed.flags, "type"),
          summary: requiredFlag(parsed.flags, "summary"),
          requestId,
          actor,
        });
        break;
      case "artifacts":
        result = executeQuestBoardAgentTool(service, "questboard_list_artifacts", {
          taskId: positional(parsed.positionals, 1, "task id"),
        });
        break;
      case "artifact":
        result = executeQuestBoardAgentTool(service, "questboard_get_artifact", {
          artifactId: positional(parsed.positionals, 1, "artifact id"),
        });
        break;
      case "add-artifact":
        result = executeQuestBoardAgentTool(service, "questboard_add_artifact", compact({
          taskId: positional(parsed.positionals, 1, "task id"),
          type: requiredFlag(parsed.flags, "type"),
          title: requiredFlag(parsed.flags, "title"),
          locator: requiredFlag(parsed.flags, "locator"),
          description: parsed.flags.get("description"),
          requestId,
          actor,
        }));
        break;
      case "relations":
        result = executeQuestBoardAgentTool(service, "questboard_list_relations", {
          taskId: positional(parsed.positionals, 1, "task id"),
        });
        break;
      case "add-relation":
        result = executeQuestBoardAgentTool(service, "questboard_add_relation", compact({
          fromType: requiredFlag(parsed.flags, "from-type"),
          fromId: requiredFlag(parsed.flags, "from"),
          toType: requiredFlag(parsed.flags, "to-type"),
          toId: requiredFlag(parsed.flags, "to"),
          kind: requiredFlag(parsed.flags, "kind"),
          label: parsed.flags.get("label"),
          requestId,
          actor,
        }));
        break;
      default:
        throw new TypeError(`Unknown command: ${command}`);
    }

    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    io.stderr(JSON.stringify({ error: describeQuestBoardError(error) }, null, 2));
    return 1;
  }
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "help") {
      flags.set(key, "true");
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`--${key} requires a value`);
    flags.set(key, value);
    index += 1;
  }
  return { positionals, flags };
}

function actorFrom(flags: Map<string, string>, fallback: ActorRef): ActorRef {
  return {
    id: flags.get("actor-id") ?? fallback.id,
    provider: flags.get("actor-provider") ?? fallback.provider,
    ...(fallback.displayName ? { displayName: fallback.displayName } : {}),
  };
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function splitTags(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function requiredFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value?.trim()) throw new TypeError(`--${key} is required`);
  return value;
}

function requiredPositiveIntegerFlag(flags: Map<string, string>, key: string): number {
  const raw = requiredFlag(flags, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`--${key} must be a positive integer`);
  return value;
}

function optionalPositiveIntegerFlag(flags: Map<string, string>, key: string): number | undefined {
  if (!flags.has(key)) return undefined;
  return requiredPositiveIntegerFlag(flags, key);
}

function positional(values: readonly string[], index: number, label: string): string {
  const value = values[index];
  if (!value?.trim()) throw new TypeError(`${label} is required`);
  return value;
}

function helpText(): string {
  return [
    "QuestBoard CLI",
    "",
    "  projects",
    "  tasks [--project ID] [--status STATUS]",
    "  task TASK_ID",
    "  create-task --project ID --title TITLE [--description TEXT] [--status STATUS] [--priority PRIORITY] [--tags a,b]",
    "  update-task TASK_ID [--revision N] [--title TITLE] [--description TEXT] [--status STATUS] [--priority PRIORITY] [--tags a,b]",
    "  claim TASK_ID [--actor-id ID] [--actor-provider PROVIDER]",
    "  release TASK_ID [--claim-id CLAIM_ID] [--actor-id ID] [--actor-provider PROVIDER]",
    "  claim-status TASK_ID",
    "  activity TASK_ID",
    "  add-activity TASK_ID --type note_added|agent_handoff --summary TEXT [--actor-id ID] [--actor-provider PROVIDER]",
    "  artifacts TASK_ID",
    "  artifact ARTIFACT_ID",
    "  add-artifact TASK_ID --type file|url|commit|screenshot|operation|log|other --title TITLE --locator VALUE [--description TEXT]",
    "  relations TASK_ID",
    "  add-relation --from-type task|artifact --from ID --to-type task|artifact --to ID --kind KIND [--label TEXT]",
    "",
    "  Mutations generate an idempotency request id automatically. Use --request-id ID only to replay/debug an exact request.",
  ].join("\n");
}
