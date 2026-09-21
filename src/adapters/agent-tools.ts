import type {
  ActivityType,
  ActorRef,
  ArtifactType,
  RelationEntityType,
  TaskPriority,
  TaskStatus,
} from "../core/domain.js";
import { ARTIFACT_TYPES, RELATION_ENTITY_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../core/domain.js";
import {
  ClaimConflictError,
  ClaimGenerationConflictError,
  ClaimNotFoundError,
  ClaimOwnershipError,
  EntityRevisionConflictError,
  EntityNotFoundError,
  MutationRequestConflictError,
  RevisionConflictError,
} from "../core/errors.js";
import type {
  ApplyMigrationBatchInput,
  AttachExistingTaskToInvestigationInput,
  MigrationBatchOperation,
  CreateArtifactInput,
  CreateInvestigationItemInput,
  CreateInvestigationItemLinkInput,
  CreateInvestigationLinkedTaskInput,
  CreateInvestigationNodeInput,
  CreateProjectInput,
  CreateRelationInput,
  CreateTaskInput,
  QuestBoardService,
  UpdateInvestigationItemInput,
  UpdateInvestigationNodeInput,
  UpdateTaskInput,
} from "../application/quest-board-service.js";

const CLIENT_ACTIVITY_TYPES = ["note_added", "agent_handoff"] as const satisfies readonly ActivityType[];

export interface QuestBoardAgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class QuestBoardRemoteToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuestBoardRemoteToolError";
  }
}

const actorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, description: "Stable neutral actor id." },
    provider: { type: "string", minLength: 1, description: "Neutral provider/client identifier." },
    displayName: { type: "string" },
  },
  required: ["id", "provider"],
} as const;

const migrationOperationSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      properties: {
        type: { const: "attach_existing_task" },
        nodeId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
      },
      required: ["type", "nodeId", "taskId"],
    },
    {
      type: "object", additionalProperties: false,
      properties: { type: { const: "delete_relation" }, relationId: { type: "string", minLength: 1 } },
      required: ["type", "relationId"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        type: { const: "delete_task" },
        taskId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["type", "taskId"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        type: { const: "delete_investigation_node" },
        nodeId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["type", "nodeId"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        type: { const: "delete_investigation_item" },
        itemId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["type", "itemId"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        type: { const: "reorder_investigation_items" },
        nodeId: { type: "string", minLength: 1 },
        orderedItemIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
      },
      required: ["type", "nodeId", "orderedItemIds"],
    },
  ],
} as const;

export const QUESTBOARD_AGENT_TOOLS = [
  {
    name: "questboard_list_projects",
    description: "List QuestBoard projects.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "questboard_create_project",
    description: "Create a QuestBoard project and record the neutral actor that created it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        rootPath: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["name", "actor"],
    },
  },
  {
    name: "questboard_list_tasks",
    description: "List tasks, optionally filtered by project and status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        status: { type: "string", enum: TASK_STATUSES },
      },
    },
  },
  {
    name: "questboard_get_task",
    description: "Read one task and its current claim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1 } },
      required: ["taskId"],
    },
  },
  {
    name: "questboard_create_task",
    description: "Create a task and record the neutral actor that created it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        priority: { type: "string", enum: TASK_PRIORITIES },
        tags: { type: "array", items: { type: "string" } },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "title", "actor"],
    },
  },
  {
    name: "questboard_update_task",
    description: "Update task fields and append the matching Activity entry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1, description: "Optional strict-CAS compatibility check. Usually omit it." },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        priority: { type: "string", enum: TASK_PRIORITIES },
        tags: { type: "array", items: { type: "string" } },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["taskId", "actor"],
    },
  },
  {
    name: "questboard_delete_task",
    description: "Permanently delete a Task and its task-owned attachments/claims/relations while preserving Activity rows as project history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["taskId", "actor"],
    },
  },
  {
    name: "questboard_get_claim",
    description: "Read the current active claim for a task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1 } },
      required: ["taskId"],
    },
  },
  {
    name: "questboard_claim_task",
    description: "Claim a task as a cooperative coordination signal; claims do not block normal task mutations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1 }, requestId: { type: "string", minLength: 8, maxLength: 128 }, actor: actorSchema },
      required: ["taskId", "actor"],
    },
  },
  {
    name: "questboard_release_task",
    description: "Release a task claim owned by the supplied actor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        claimId: { type: "string", minLength: 1, description: "Optional opaque claim identity for stale-release protection." },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["taskId", "actor"],
    },
  },
  {
    name: "questboard_list_activity",
    description: "List append-only Activity history for one task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1 } },
      required: ["taskId"],
    },
  },
  {
    name: "questboard_add_activity",
    description: "Append a note or agent handoff Activity to one task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        type: { type: "string", enum: CLIENT_ACTIVITY_TYPES },
        summary: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["taskId", "type", "summary", "actor"],
    },
  },
  {
    name: "questboard_list_artifacts",
    description: "List evidence artifacts attached to one task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1 } },
      required: ["taskId"],
    },
  },
  {
    name: "questboard_get_artifact",
    description: "Read one evidence artifact.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { artifactId: { type: "string", minLength: 1 } },
      required: ["artifactId"],
    },
  },
  {
    name: "questboard_add_artifact",
    description: "Attach a file, URL, commit, screenshot, operation, log, or other evidence artifact to a task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        type: { type: "string", enum: ARTIFACT_TYPES },
        title: { type: "string", minLength: 1 },
        locator: { type: "string", minLength: 1 },
        description: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["taskId", "type", "title", "locator", "actor"],
    },
  },
  {
    name: "questboard_delete_artifact",
    description: "Permanently delete an evidence Artifact and any Relation edges or board position that reference it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifactId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["artifactId", "actor"],
    },
  },
  {
    name: "questboard_list_relations",
    description: "List Task/Artifact relations that touch one task or its attached artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1 } },
      required: ["taskId"],
    },
  },
  {
    name: "questboard_add_relation",
    description: "Create a vendor-neutral directed relation between Task/Artifact endpoints in the same project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromType: { type: "string", enum: RELATION_ENTITY_TYPES },
        fromId: { type: "string", minLength: 1 },
        toType: { type: "string", enum: RELATION_ENTITY_TYPES },
        toId: { type: "string", minLength: 1 },
        kind: { type: "string", minLength: 1 },
        label: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["fromType", "fromId", "toType", "toId", "kind", "actor"],
    },
  },
  {
    name: "questboard_delete_relation",
    description: "Permanently delete one Task/Artifact relation by relation id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        relationId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["relationId", "actor"],
    },
  },
  {
    name: "questboard_get_investigation_graph",
    description: "Read the project flow graph: Investigation Nodes, Items, Item-to-Node flow links, Item-to-Task links, canonical Tasks, and positions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", minLength: 1 } },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_create_investigation_node",
    description: "Create a standalone Investigation Node representing a project flow, component, responsibility, idea, or TODO cluster.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        kind: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "title", "actor"],
    },
  },
  {
    name: "questboard_update_investigation_node",
    description: "Update an Investigation Node title, description, or kind.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        nodeId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        kind: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["nodeId", "actor"],
    },
  },
  {
    name: "questboard_delete_investigation_node",
    description: "Delete an Investigation Node and its contained Items/graph links; linked canonical Tasks are preserved.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        nodeId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["nodeId", "actor"],
    },
  },
  {
    name: "questboard_add_investigation_item",
    description: "Add a titled, described Item inside an Investigation Node.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        nodeId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["nodeId", "title", "actor"],
    },
  },
  {
    name: "questboard_update_investigation_item",
    description: "Update an Investigation Item title or description.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        itemId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["itemId", "actor"],
    },
  },
  {
    name: "questboard_delete_investigation_item",
    description: "Delete an Investigation Item and its graph/task links; canonical Tasks and Nodes are preserved.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        itemId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["itemId", "actor"],
    },
  },
  {
    name: "questboard_link_task_to_investigation_item",
    description: "Link an existing canonical QuestBoard Task to an Investigation Item without duplicating the Task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        itemId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["itemId", "taskId", "actor"],
    },
  },
  {
    name: "questboard_unlink_task_from_investigation_item",
    description: "Remove an Investigation Item-to-Task link without deleting the canonical Task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        itemId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["itemId", "taskId", "actor"],
    },
  },
  {
    name: "questboard_create_task_for_investigation_item",
    description: "Create a canonical QuestBoard Task and immediately link it to an Investigation Item.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        itemId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        priority: { type: "string", enum: TASK_PRIORITIES },
        tags: { type: "array", items: { type: "string" } },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["itemId", "title", "actor"],
    },
  },
  {
    name: "questboard_link_investigation_item_to_node",
    description: "Create a directed project-flow link from one Investigation Item to another Investigation Node.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromItemId: { type: "string", minLength: 1 },
        toNodeId: { type: "string", minLength: 1 },
        label: { type: "string" },
        kind: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["fromItemId", "toNodeId", "actor"],
    },
  },
  {
    name: "questboard_unlink_investigation_item_from_node",
    description: "Remove one Investigation Item-to-Node flow link by link id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        linkId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["linkId", "actor"],
    },
  },
  {
    name: "questboard_attach_existing_task_to_investigation",
    description: "Atomically create a new Investigation Item for an existing canonical Task and link the Task to it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        nodeId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["nodeId", "taskId", "actor"],
    },
  },
  {
    name: "questboard_reorder_investigation_items",
    description: "Atomically replace the complete Item order inside one Investigation Node.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        nodeId: { type: "string", minLength: 1 },
        orderedItemIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["nodeId", "orderedItemIds", "actor"],
    },
  },
  {
    name: "questboard_apply_migration_batch",
    description: "Apply an all-or-nothing project migration batch for existing-Task attachment, legacy cleanup, and Item reorder.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        operations: { type: "array", minItems: 1, maxItems: 200, items: migrationOperationSchema },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "operations", "actor"],
    },
  },
] as const satisfies readonly QuestBoardAgentToolDefinition[];

export type QuestBoardAgentToolName = (typeof QUESTBOARD_AGENT_TOOLS)[number]["name"];

export function executeQuestBoardAgentTool(
  service: QuestBoardService,
  name: string,
  input: unknown = {},
): unknown {
  const args = requireObject(input, "arguments");

  switch (name) {
    case "questboard_list_projects":
      return { projects: service.listProjects() };
    case "questboard_create_project": {
      const inputValue: CreateProjectInput = {
        name: requireString(args, "name"),
        ...optionalStringProperty(args, "description"),
        ...optionalStringProperty(args, "rootPath"),
      };
      return { project: service.createProject(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_list_tasks": {
      const projectId = optionalString(args, "projectId");
      const status = optionalEnum(args, "status", TASK_STATUSES);
      return {
        tasks: service.listTasks({
          ...(projectId !== undefined ? { projectId } : {}),
          ...(status !== undefined ? { status } : {}),
        }),
      };
    }
    case "questboard_get_task": {
      const taskId = requireString(args, "taskId");
      return { task: service.getTask(taskId), claim: service.getTaskClaim(taskId) ?? null };
    }
    case "questboard_create_task": {
      const inputValue: CreateTaskInput = {
        projectId: requireString(args, "projectId"),
        title: requireString(args, "title"),
        ...optionalStringProperty(args, "description"),
        ...optionalEnumProperty(args, "status", TASK_STATUSES),
        ...optionalEnumProperty(args, "priority", TASK_PRIORITIES),
        ...optionalStringArrayProperty(args, "tags"),
      };
      return { task: service.createTask(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_update_task": {
      const patch: UpdateTaskInput = {
        ...optionalPositiveIntegerProperty(args, "expectedRevision"),
        ...optionalStringProperty(args, "title"),
        ...optionalStringProperty(args, "description"),
        ...optionalEnumProperty(args, "status", TASK_STATUSES),
        ...optionalEnumProperty(args, "priority", TASK_PRIORITIES),
        ...optionalStringArrayProperty(args, "tags"),
      };
      return { task: service.updateTask(requireString(args, "taskId"), patch, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_delete_task":
      service.deleteTask(requireString(args, "taskId"), requireActor(args), {
        ...mutationOptions(args),
        ...optionalPositiveIntegerProperty(args, "expectedRevision"),
      });
      return { deleted: true };
    case "questboard_get_claim": {
      const taskId = requireString(args, "taskId");
      return { claim: service.getTaskClaim(taskId) ?? null };
    }
    case "questboard_claim_task":
      return { claim: service.claimTask(requireString(args, "taskId"), requireActor(args), mutationOptions(args)) };
    case "questboard_release_task":
      return {
        claim: service.releaseTask(requireString(args, "taskId"), requireActor(args), {
          ...mutationOptions(args),
          ...optionalStringProperty(args, "claimId"),
        }),
      };
    case "questboard_list_activity":
      return { activities: service.listTaskActivity(requireString(args, "taskId")) };
    case "questboard_add_activity":
      return {
        activity: service.appendTaskActivity(
          requireString(args, "taskId"),
          requireEnum(args, "type", CLIENT_ACTIVITY_TYPES),
          requireString(args, "summary"),
          requireActor(args),
          mutationOptions(args),
        ),
      };
    case "questboard_list_artifacts":
      return { artifacts: service.listTaskArtifacts(requireString(args, "taskId")) };
    case "questboard_get_artifact":
      return { artifact: service.getArtifact(requireString(args, "artifactId")) };
    case "questboard_add_artifact": {
      const inputValue: CreateArtifactInput = {
        taskId: requireString(args, "taskId"),
        type: requireEnum(args, "type", ARTIFACT_TYPES) as ArtifactType,
        title: requireString(args, "title"),
        locator: requireString(args, "locator"),
        ...optionalStringProperty(args, "description"),
      };
      return { artifact: service.createArtifact(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_delete_artifact":
      service.deleteArtifact(requireString(args, "artifactId"), requireActor(args), mutationOptions(args));
      return { deleted: true };
    case "questboard_list_relations":
      return { relations: service.listTaskRelations(requireString(args, "taskId")) };
    case "questboard_add_relation": {
      const inputValue: CreateRelationInput = {
        fromType: requireEnum(args, "fromType", RELATION_ENTITY_TYPES) as RelationEntityType,
        fromId: requireString(args, "fromId"),
        toType: requireEnum(args, "toType", RELATION_ENTITY_TYPES) as RelationEntityType,
        toId: requireString(args, "toId"),
        kind: requireString(args, "kind"),
        ...optionalStringProperty(args, "label"),
      };
      return { relation: service.createRelation(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_delete_relation":
      service.deleteRelation(requireString(args, "relationId"), requireActor(args), mutationOptions(args));
      return { deleted: true };
    case "questboard_get_investigation_graph":
      return service.getInvestigationGraph(requireString(args, "projectId"));
    case "questboard_create_investigation_node": {
      const inputValue: CreateInvestigationNodeInput = {
        projectId: requireString(args, "projectId"),
        title: requireString(args, "title"),
        ...optionalStringProperty(args, "description"),
        ...optionalStringProperty(args, "kind"),
      };
      return { node: service.createInvestigationNode(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_update_investigation_node": {
      const patch: UpdateInvestigationNodeInput = {
        ...optionalPositiveIntegerProperty(args, "expectedRevision"),
        ...optionalStringProperty(args, "title"),
        ...optionalStringProperty(args, "description"),
        ...optionalStringProperty(args, "kind"),
      };
      return { node: service.updateInvestigationNode(requireString(args, "nodeId"), patch, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_delete_investigation_node":
      service.deleteInvestigationNode(requireString(args, "nodeId"), requireActor(args), {
        ...mutationOptions(args),
        ...optionalPositiveIntegerProperty(args, "expectedRevision"),
      });
      return { deleted: true };
    case "questboard_add_investigation_item": {
      const inputValue: CreateInvestigationItemInput = {
        nodeId: requireString(args, "nodeId"),
        title: requireString(args, "title"),
        ...optionalStringProperty(args, "description"),
      };
      return { item: service.createInvestigationItem(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_update_investigation_item": {
      const patch: UpdateInvestigationItemInput = {
        ...optionalPositiveIntegerProperty(args, "expectedRevision"),
        ...optionalStringProperty(args, "title"),
        ...optionalStringProperty(args, "description"),
      };
      return { item: service.updateInvestigationItem(requireString(args, "itemId"), patch, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_delete_investigation_item":
      service.deleteInvestigationItem(requireString(args, "itemId"), requireActor(args), {
        ...mutationOptions(args),
        ...optionalPositiveIntegerProperty(args, "expectedRevision"),
      });
      return { deleted: true };
    case "questboard_link_task_to_investigation_item":
      return {
        link: service.linkTaskToInvestigationItem(
          requireString(args, "itemId"), requireString(args, "taskId"), requireActor(args), mutationOptions(args),
        ),
      };
    case "questboard_unlink_task_from_investigation_item":
      service.unlinkTaskFromInvestigationItem(
        requireString(args, "itemId"), requireString(args, "taskId"), requireActor(args), mutationOptions(args),
      );
      return { removed: true };
    case "questboard_create_task_for_investigation_item": {
      const inputValue: CreateInvestigationLinkedTaskInput = {
        title: requireString(args, "title"),
        ...optionalStringProperty(args, "description"),
        ...optionalEnumProperty(args, "status", TASK_STATUSES),
        ...optionalEnumProperty(args, "priority", TASK_PRIORITIES),
        ...optionalStringArrayProperty(args, "tags"),
      };
      return service.createTaskForInvestigationItem(requireString(args, "itemId"), inputValue, requireActor(args), mutationOptions(args));
    }
    case "questboard_link_investigation_item_to_node": {
      const inputValue: CreateInvestigationItemLinkInput = {
        fromItemId: requireString(args, "fromItemId"),
        toNodeId: requireString(args, "toNodeId"),
        ...optionalStringProperty(args, "label"),
        ...optionalStringProperty(args, "kind"),
      };
      return { link: service.createInvestigationItemLink(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_unlink_investigation_item_from_node":
      service.removeInvestigationItemLink(requireString(args, "linkId"), requireActor(args), mutationOptions(args));
      return { removed: true };
    case "questboard_attach_existing_task_to_investigation": {
      const inputValue: AttachExistingTaskToInvestigationInput = {
        nodeId: requireString(args, "nodeId"),
        taskId: requireString(args, "taskId"),
        ...optionalStringProperty(args, "title"),
        ...optionalStringProperty(args, "description"),
      };
      return service.attachExistingTaskToInvestigation(inputValue, requireActor(args), mutationOptions(args));
    }
    case "questboard_reorder_investigation_items":
      return {
        items: service.reorderInvestigationItems(
          requireString(args, "nodeId"), requireStringArray(args, "orderedItemIds"), requireActor(args), mutationOptions(args),
        ),
      };
    case "questboard_apply_migration_batch": {
      const inputValue: ApplyMigrationBatchInput = {
        projectId: requireString(args, "projectId"),
        operations: requireArray(args, "operations").map((operation, index) => parseMigrationOperation(operation, index)),
      };
      return service.applyMigrationBatch(inputValue, requireActor(args), mutationOptions(args));
    }
    default:
      throw new TypeError(`Unknown QuestBoard tool: ${name}`);
  }
}

export function describeQuestBoardError(error: unknown): { code: string; message: string } {
  if (error instanceof QuestBoardRemoteToolError) return { code: error.code, message: error.message };
  if (error instanceof EntityNotFoundError) return { code: "not_found", message: error.message };
  if (error instanceof ClaimConflictError) return { code: "claim_conflict", message: error.message };
  if (error instanceof ClaimNotFoundError) return { code: "claim_not_found", message: error.message };
  if (error instanceof ClaimOwnershipError) return { code: "claim_ownership", message: error.message };
  if (error instanceof ClaimGenerationConflictError) return { code: "claim_changed", message: error.message };
  if (error instanceof MutationRequestConflictError) return { code: "request_conflict", message: error.message };
  if (error instanceof RevisionConflictError) return { code: "revision_conflict", message: error.message };
  if (error instanceof EntityRevisionConflictError) return { code: "revision_conflict", message: error.message };
  if (error instanceof TypeError) return { code: "bad_request", message: error.message };
  return { code: "internal_error", message: "Internal error" };
}

function requireActor(args: Record<string, unknown>): ActorRef {
  const actor = requireObject(args.actor, "actor");
  const displayName = optionalString(actor, "displayName");
  return {
    id: requireString(actor, "id"),
    provider: requireString(actor, "provider"),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: Record<string, unknown>, key: string): unknown[] {
  const item = value[key];
  if (!Array.isArray(item)) throw new TypeError(`${key} must be an array`);
  return item;
}

function requireStringArray(value: Record<string, unknown>, key: string): string[] {
  const items = requireArray(value, key);
  if (!items.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new TypeError(`${key} must be an array of non-empty strings`);
  }
  return items as string[];
}

function parseMigrationOperation(value: unknown, index: number): MigrationBatchOperation {
  const operation = requireObject(value, `operations[${index}]`);
  const type = requireString(operation, "type");
  switch (type) {
    case "attach_existing_task":
      return {
        type,
        nodeId: requireString(operation, "nodeId"),
        taskId: requireString(operation, "taskId"),
        ...optionalStringProperty(operation, "title"),
        ...optionalStringProperty(operation, "description"),
      };
    case "delete_relation":
      return { type, relationId: requireString(operation, "relationId") };
    case "delete_task":
      return {
        type,
        taskId: requireString(operation, "taskId"),
        ...optionalPositiveIntegerProperty(operation, "expectedRevision"),
      };
    case "delete_investigation_node":
      return {
        type,
        nodeId: requireString(operation, "nodeId"),
        ...optionalPositiveIntegerProperty(operation, "expectedRevision"),
      };
    case "delete_investigation_item":
      return {
        type,
        itemId: requireString(operation, "itemId"),
        ...optionalPositiveIntegerProperty(operation, "expectedRevision"),
      };
    case "reorder_investigation_items":
      return {
        type,
        nodeId: requireString(operation, "nodeId"),
        orderedItemIds: requireStringArray(operation, "orderedItemIds"),
      };
    default:
      throw new TypeError(`operations[${index}].type is not supported: ${type}`);
  }
}

function requireString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || !item.trim()) throw new TypeError(`${key} must be a non-empty string`);
  return item;
}

function requirePositiveInteger(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || (item as number) < 1) {
    throw new TypeError(`${key} must be a positive integer`);
  }
  return item as number;
}

function optionalPositiveIntegerProperty<K extends string>(
  value: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  if (!(key in value) || value[key] === undefined) return {};
  return { [key]: requirePositiveInteger(value, key) } as Partial<Record<K, number>>;
}

function mutationOptions(args: Record<string, unknown>): { requestId?: string } {
  const requestId = optionalString(args, "requestId");
  return requestId === undefined ? {} : { requestId };
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!(key in value)) return undefined;
  const item = value[key];
  if (typeof item !== "string") throw new TypeError(`${key} must be a string`);
  const normalized = item.trim();
  return normalized || undefined;
}

function optionalStringProperty<K extends string>(
  value: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  if (!(key in value)) return {};
  const item = value[key];
  if (typeof item !== "string") throw new TypeError(`${key} must be a string`);
  return { [key]: item } as Partial<Record<K, string>>;
}

function optionalStringArrayProperty<K extends string>(
  value: Record<string, unknown>,
  key: K,
): Partial<Record<K, string[]>> {
  if (!(key in value)) return {};
  const item = value[key];
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${key} must be an array of strings`);
  }
  return { [key]: item as string[] } as Partial<Record<K, string[]>>;
}

function requireEnum<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const item = requireString(value, key);
  return parseEnum(item, key, values);
}

function optionalEnum<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | undefined {
  if (!(key in value)) return undefined;
  const item = value[key];
  if (typeof item !== "string") throw new TypeError(`${key} must be a string`);
  return parseEnum(item, key, values);
}

function optionalEnumProperty<K extends string, const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: K,
  values: T,
): Partial<Record<K, T[number]>> {
  const item = optionalEnum(value, key, values);
  return item === undefined ? {} : ({ [key]: item } as Partial<Record<K, T[number]>>);
}

function parseEnum<const T extends readonly string[]>(item: string, key: string, values: T): T[number] {
  if (!(values as readonly string[]).includes(item)) {
    throw new TypeError(`${key} must be one of: ${values.join(", ")}`);
  }
  return item as T[number];
}
