import type {
  ActivityType,
  ActorRef,
  ArtifactType,
  RelationEntityType,
  TaskPriority,
  TaskStatus,
} from "../core/domain.js";
import { ARTIFACT_TYPES, FLOW_WORK_GROUP_MEMBER_TYPES, RELATION_ENTITY_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../core/domain.js";
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
  CheckpointTaskInput,
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
import {
  CodeMapInvestigationSyncError,
  type CodeMapInvestigationSyncSelection,
  type CodeMapInvestigationSyncService,
} from "../application/code-map-investigation-sync.js";
import { CODE_NODE_KINDS, CODE_RELATION_KINDS } from "../application/code-intelligence.js";
import type { CodeMapService } from "../application/code-map-service.js";
import { CodeMapAugmentationError, type CodeMapAugmentationService } from "../application/code-map-augmentation.js";
import {
  CODE_SCOPE_BINDING_KINDS,
  CodeScopeBindingError,
  type CodeScopeBindingService,
} from "../application/code-scope-binding.js";
import { CodeProviderLifecycleError } from "../application/code-map-provider-registry.js";
import type { AgentFocusService } from "../application/agent-focus.js";
import {
  CODE_MAP_HIERARCHY_DIRECTIONS,
  CODE_MAP_QUERY_DIRECTIONS,
  CODE_MAP_QUERY_MAX_DEPTH,
  CODE_MAP_QUERY_MAX_LIMIT,
  CODE_MAP_QUERY_MAX_SEEDS,
  CODE_MAP_QUERY_OPERATIONS,
  CODE_MAP_RELATION_SEMANTICS,
  CodeMapQueryError,
  type CodeMapQueryInput,
} from "../application/code-map-query.js";


const CLIENT_ACTIVITY_TYPES = ["note_added", "agent_handoff"] as const satisfies readonly ActivityType[];

export interface QuestBoardAgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface QuestBoardAgentToolContext {
  service: QuestBoardService;
  codeMapService?: CodeMapService;
  codeMapInvestigationSyncService?: CodeMapInvestigationSyncService;
  codeMapAugmentationService?: CodeMapAugmentationService;
  codeScopeBindingService?: CodeScopeBindingService;
  agentFocusService?: AgentFocusService;
}

export type QuestBoardAgentToolRuntime = QuestBoardService | QuestBoardAgentToolContext;

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
    name: "questboard_resume_task",
    description: "Read the minimal Resume Capsule for one explicit task without loading Activity, Investigation, Code Map, Artifacts, or Relations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { taskId: { type: "string", minLength: 1 } },
      required: ["taskId"],
    },
  },
  {
    name: "questboard_checkpoint_task",
    description: "Update one Task's current Now/Next continuity in one call, optionally set or explicitly clear Blocked/Guardrail, and append one meaningful note or handoff Activity.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        now: { type: "string", minLength: 1 },
        next: { type: "string", minLength: 1 },
        blocked: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        guardrail: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        activity: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: CLIENT_ACTIVITY_TYPES },
            summary: { type: "string", minLength: 1 },
          },
          required: ["type", "summary"],
        },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["taskId", "now", "next", "actor"],
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
        goal: { type: "string", minLength: 1 },
        now: { type: "string", minLength: 1 },
        next: { type: "string", minLength: 1 },
        blocked: { type: "string" },
        guardrail: { type: "string" },
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
        goal: { type: "string", minLength: 1 },
        now: { type: "string", minLength: 1 },
        next: { type: "string", minLength: 1 },
        blocked: { type: "string" },
        guardrail: { type: "string" },
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
    description: "Read the project flow graph: visual Work Groups/memberships, Investigation Nodes, Items, flow/task links, canonical Tasks, and positions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", minLength: 1 } },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_create_flow_work_group",
    description: "Create a first-class visual/spatial Flow Work Group. Groups may be nested independently of canonical Task hierarchy.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        goal: { type: "string" },
        parentGroupId: { type: "string", minLength: 1 },
        linkedTaskId: { type: "string", minLength: 1 },
        x: { type: "number" }, y: { type: "number" },
        width: { type: "number", minimum: 220 }, height: { type: "number", minimum: 140 },
        collapsed: { type: "boolean" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "title", "actor"],
    },
  },
  {
    name: "questboard_update_flow_work_group",
    description: "Update a visual Flow Work Group, including nesting, optional linked Task, bounds, and collapse state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        title: { type: "string", minLength: 1 }, goal: { type: "string" },
        parentGroupId: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        linkedTaskId: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        x: { type: "number" }, y: { type: "number" },
        width: { type: "number", minimum: 220 }, height: { type: "number", minimum: 140 },
        collapsed: { type: "boolean" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["groupId", "actor"],
    },
  },
  {
    name: "questboard_delete_flow_work_group",
    description: "Delete one visual Flow Work Group without deleting canonical Tasks or Investigation Nodes; child groups become top-level.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 }, actor: actorSchema,
      },
      required: ["groupId", "actor"],
    },
  },
  {
    name: "questboard_set_flow_work_group_member",
    description: "Assign one canonical Task or Investigation Node directly to a visual Flow Work Group. Reassignment replaces its previous visual Group membership.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: { type: "string", minLength: 1 },
        entityType: { type: "string", enum: FLOW_WORK_GROUP_MEMBER_TYPES },
        entityId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 }, actor: actorSchema,
      },
      required: ["groupId", "entityType", "entityId", "actor"],
    },
  },
  {
    name: "questboard_remove_flow_work_group_member",
    description: "Remove one Task or Investigation Node from its specified visual Flow Work Group without deleting the entity.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: { type: "string", minLength: 1 },
        entityType: { type: "string", enum: FLOW_WORK_GROUP_MEMBER_TYPES },
        entityId: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 }, actor: actorSchema,
      },
      required: ["groupId", "entityType", "entityId", "actor"],
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
    name: "questboard_query_code_map",
    description: "Query the indexed raw Code Map through a bounded read surface. Supports node search/exact lookup, containment hierarchy, callers/callees/references, and bounded neighborhoods without returning the full project graph. Returned node IDs are raw CodeGraphSnapshot IDs (`code:node:*`) and are distinct from architecture projection IDs used by Investigation sync.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        operation: { type: "string", enum: [...CODE_MAP_QUERY_OPERATIONS] },
        query: { type: "string" },
        path: { type: "string" },
        kinds: { type: "array", uniqueItems: true, items: { type: "string", enum: [...CODE_NODE_KINDS] } },
        language: { type: "string" },
        nodeId: { type: "string", minLength: 1 },
        canonicalIdentity: { type: "string", minLength: 1 },
        direction: { type: "string", enum: ["incoming", "outgoing", "both", "parents", "children"] },
        relationKinds: { type: "array", uniqueItems: true, items: { type: "string", enum: [...CODE_RELATION_KINDS] } },
        semantic: { type: "string", enum: [...CODE_MAP_RELATION_SEMANTICS] },
        nodeIds: { type: "array", minItems: 1, maxItems: CODE_MAP_QUERY_MAX_SEEDS, uniqueItems: true, items: { type: "string", minLength: 1 } },
        depth: { type: "integer", minimum: 1, maximum: CODE_MAP_QUERY_MAX_DEPTH },
        limit: { type: "integer", minimum: 1, maximum: CODE_MAP_QUERY_MAX_LIMIT },
      },
      required: ["projectId", "operation"],
    },
  },
  {
    name: "questboard_get_code_map_status",
    description: "Read bounded Code Map lifecycle status for one project, including indexing/provider state and derived architecture projection quality without returning the full graph. When projectionQuality.status is sparse, continue exploration through bounded raw Code Map queries rather than treating the project as unindexed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_refresh_code_map",
    description: "Start or reuse one background full Code Map refresh for the canonical Project rootPath and return a bounded job receipt immediately. Provider installation is never triggered.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_get_code_map_refresh_status",
    description: "Read the latest bounded Code Map refresh job receipt for one project, including running/succeeded/failed terminal state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_get_code_map_provider_capabilities",
    description: "Read the shared Code Map provider registry and per-language coverage gaps. Reports trusted install options without installing anything.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_request_code_map_provider_install",
    description: "Return a trusted, approval-required external-host install request for one Code Map provider. This tool never executes package or executable installation and never triggers indexing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        providerId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "providerId"],
    },
  },
  {
    name: "questboard_list_code_scope_bindings",
    description: "List persistent Task-to-CodeScope bindings. Bindings remain readable after restart before reindex and report active, stale, or unindexed state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        codeNodeId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_attach_task_code_scope",
    description: "Attach an existing Task to one exact indexed CodeScope without changing the Task domain model.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        codeNodeId: { type: "string", minLength: 1 },
        kind: { type: "string", enum: [...CODE_SCOPE_BINDING_KINDS] },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "taskId", "codeNodeId", "actor"],
    },
  },
  {
    name: "questboard_detach_task_code_scope",
    description: "Detach one persistent Task-to-CodeScope binding without deleting the Task or Code node.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        bindingId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["bindingId", "actor"],
    },
  },
  {
    name: "questboard_relink_task_code_scope",
    description: "Relink one stale/relinkable persistent Task-to-CodeScope binding only when the current Code Map has one conservative unique target. Ambiguous targets remain stale.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        bindingId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["bindingId", "actor"],
    },
  },
  {
    name: "questboard_create_task_for_code_scope",
    description: "Atomically create a Task and bind it to one exact indexed CodeScope. Targetless Tasks remain supported through ordinary Task creation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        codeNodeId: { type: "string", minLength: 1 },
        kind: { type: "string", enum: [...CODE_SCOPE_BINDING_KINDS] },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        goal: { type: "string", minLength: 1 },
        now: { type: "string", minLength: 1 },
        next: { type: "string", minLength: 1 },
        status: { type: "string", enum: [...TASK_STATUSES] },
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        tags: { type: "array", uniqueItems: true, items: { type: "string" } },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "codeNodeId", "title", "actor"],
    },
  },
  {
    name: "questboard_get_agent_focus",
    description: "Read ephemeral agent focus for a project. Focus is process-memory only and is not a claim, authorization grant, Task Activity, or durable history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", minLength: 1 } },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_set_agent_focus",
    description: "Publish minimal ephemeral agent focus for one session without writing Task Activity/history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        workGroupId: { type: "string", minLength: 1 },
        flowNodeId: { type: "string", minLength: 1 },
        codeScopeId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "sessionId"],
    },
  },
  {
    name: "questboard_clear_agent_focus",
    description: "Clear one session's ephemeral agent focus without touching canonical work state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "sessionId"],
    },
  },
  {
    name: "questboard_list_code_map_manual_relations",
    description: "List persistent manual Code Map relation augmentations with active/stale state and explicit manual provenance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", minLength: 1 } },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_create_code_map_manual_relation",
    description: "Create a persistent manual relation between two exact indexed Code Map nodes without modifying provider-derived facts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        fromCodeNodeId: { type: "string", minLength: 1 },
        toCodeNodeId: { type: "string", minLength: 1 },
        relationKind: { type: "string", enum: [...CODE_RELATION_KINDS] },
        label: { type: "string" },
        rationale: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "fromCodeNodeId", "toCodeNodeId", "relationKind", "actor"],
    },
  },
  {
    name: "questboard_update_code_map_manual_relation",
    description: "Update one manual Code Map relation using exact endpoints and optional revision CAS. Stale endpoints are never fuzzy-relinked.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        relationId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        fromCodeNodeId: { type: "string", minLength: 1 },
        toCodeNodeId: { type: "string", minLength: 1 },
        relationKind: { type: "string", enum: [...CODE_RELATION_KINDS] },
        label: { type: "string" },
        rationale: { type: "string" },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["relationId", "actor"],
    },
  },
  {
    name: "questboard_delete_code_map_manual_relation",
    description: "Delete one persistent manual Code Map relation using optional revision CAS; provider-derived relations are never touched.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        relationId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["relationId", "actor"],
    },
  },
  {
    name: "questboard_preview_code_map_investigation_sync",
    description: "Preview extraction/synchronization of Code Map architecture projection nodes and relations into the Investigation graph without mutating it. Partial selection uses architecture node IDs returned by a full sync preview, not raw CodeGraphSnapshot IDs from questboard_query_code_map.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        codeNodeIds: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description: "Architecture projection node IDs returned by preview.nodes[].codeNodeId. Raw CodeGraphSnapshot node IDs are not accepted.",
        },
        includeRelations: { type: "boolean" },
        recreateDetached: { type: "boolean" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "questboard_apply_code_map_investigation_sync",
    description: "Apply a previously previewed Code Map architecture projection to Investigation sync transactionally using the exact projection fingerprint. Partial selection uses architecture node IDs returned by preview.nodes[].codeNodeId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        codeNodeIds: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description: "Architecture projection node IDs returned by preview.nodes[].codeNodeId. Raw CodeGraphSnapshot node IDs are not accepted.",
        },
        includeRelations: { type: "boolean" },
        recreateDetached: { type: "boolean" },
        expectedProjectionFingerprint: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        actor: actorSchema,
      },
      required: ["projectId", "expectedProjectionFingerprint", "actor"],
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
  runtime: QuestBoardAgentToolRuntime,
  name: string,
  input: unknown = {},
): unknown {
  const context = normalizeAgentToolRuntime(runtime);
  const service = context.service;
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
    case "questboard_resume_task":
      return { resume: service.resumeTask(requireString(args, "taskId")) };
    case "questboard_checkpoint_task": {
      const inputValue: CheckpointTaskInput = {
        now: requireString(args, "now"),
        next: requireString(args, "next"),
      };
      if ("blocked" in args) inputValue.blocked = args.blocked === null ? null : requireString(args, "blocked");
      if ("guardrail" in args) inputValue.guardrail = args.guardrail === null ? null : requireString(args, "guardrail");
      if ("activity" in args) {
        const activity = requireObject(args.activity, "activity");
        inputValue.activity = {
          type: requireEnum(activity, "type", CLIENT_ACTIVITY_TYPES),
          summary: requireString(activity, "summary"),
        };
      }
      return {
        resume: service.checkpointTask(
          requireString(args, "taskId"),
          inputValue,
          requireActor(args),
          mutationOptions(args),
        ),
      };
    }
    case "questboard_create_task": {
      const inputValue: CreateTaskInput = {
        projectId: requireString(args, "projectId"),
        title: requireString(args, "title"),
        ...optionalStringProperty(args, "description"),
        ...optionalStringProperty(args, "goal"),
        ...optionalStringProperty(args, "now"),
        ...optionalStringProperty(args, "next"),
        ...optionalStringProperty(args, "blocked"),
        ...optionalStringProperty(args, "guardrail"),
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
        ...optionalStringProperty(args, "goal"),
        ...optionalStringProperty(args, "now"),
        ...optionalStringProperty(args, "next"),
        ...optionalStringProperty(args, "blocked"),
        ...optionalStringProperty(args, "guardrail"),
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
    case "questboard_create_flow_work_group": {
      const inputValue = {
        projectId: requireString(args, "projectId"),
        title: requireString(args, "title"),
        ...optionalStringProperty(args, "goal"),
        ...optionalStringProperty(args, "parentGroupId"),
        ...optionalStringProperty(args, "linkedTaskId"),
        ...optionalFiniteNumberProperty(args, "x"),
        ...optionalFiniteNumberProperty(args, "y"),
        ...optionalFiniteNumberProperty(args, "width"),
        ...optionalFiniteNumberProperty(args, "height"),
        ...optionalBooleanProperty(args, "collapsed"),
      };
      return { group: service.createFlowWorkGroup(inputValue, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_update_flow_work_group": {
      const patch = {
        ...optionalPositiveIntegerProperty(args, "expectedRevision"),
        ...optionalStringProperty(args, "title"),
        ...optionalStringProperty(args, "goal"),
        ...optionalFiniteNumberProperty(args, "x"),
        ...optionalFiniteNumberProperty(args, "y"),
        ...optionalFiniteNumberProperty(args, "width"),
        ...optionalFiniteNumberProperty(args, "height"),
        ...optionalBooleanProperty(args, "collapsed"),
      } as Parameters<QuestBoardService["updateFlowWorkGroup"]>[1];
      if ("parentGroupId" in args) patch.parentGroupId = args.parentGroupId === null ? null : requireString(args, "parentGroupId");
      if ("linkedTaskId" in args) patch.linkedTaskId = args.linkedTaskId === null ? null : requireString(args, "linkedTaskId");
      return { group: service.updateFlowWorkGroup(requireString(args, "groupId"), patch, requireActor(args), mutationOptions(args)) };
    }
    case "questboard_delete_flow_work_group":
      service.deleteFlowWorkGroup(requireString(args, "groupId"), requireActor(args), {
        ...mutationOptions(args), ...optionalPositiveIntegerProperty(args, "expectedRevision"),
      });
      return { deleted: true };
    case "questboard_set_flow_work_group_member":
      return {
        membership: service.setFlowWorkGroupMembership({
          groupId: requireString(args, "groupId"),
          entityType: requireEnum(args, "entityType", FLOW_WORK_GROUP_MEMBER_TYPES),
          entityId: requireString(args, "entityId"),
        }, requireActor(args), mutationOptions(args)),
      };
    case "questboard_remove_flow_work_group_member":
      service.removeFlowWorkGroupMembership({
        groupId: requireString(args, "groupId"),
        entityType: requireEnum(args, "entityType", FLOW_WORK_GROUP_MEMBER_TYPES),
        entityId: requireString(args, "entityId"),
      }, requireActor(args), mutationOptions(args));
      return { removed: true };
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
    case "questboard_query_code_map":
      return {
        query: requireCodeMapService(context).query(
          requireString(args, "projectId"),
          codeMapQueryInput(args),
        ),
      };
    case "questboard_get_code_map_status":
      return {
        codeMap: codeMapAgentStatus(context, service, requireString(args, "projectId")),
      };
    case "questboard_refresh_code_map":
      return refreshCodeMapForAgent(context, service, requireString(args, "projectId"));
    case "questboard_get_code_map_refresh_status":
      return {
        refresh: requireCodeMapService(context).refreshJob(requireString(args, "projectId")) ?? null,
      };
    case "questboard_get_code_map_provider_capabilities":
      return {
        capabilities: requireCodeMapService(context).providerCapabilities(requireString(args, "projectId")),
      };
    case "questboard_request_code_map_provider_install":
      return {
        installRequest: requireCodeMapService(context).requestProviderInstall(
          requireString(args, "projectId"),
          requireString(args, "providerId"),
        ),
      };
    case "questboard_list_code_scope_bindings":
      return {
        codeScopeBindings: requireCodeScopeBindingService(context).list(
          requireString(args, "projectId"),
          {
            ...optionalStringProperty(args, "taskId"),
            ...optionalStringProperty(args, "codeNodeId"),
          },
        ),
      };
    case "questboard_attach_task_code_scope":
      return {
        codeScopeBinding: requireCodeScopeBindingService(context).attach(
          {
            projectId: requireString(args, "projectId"),
            taskId: requireString(args, "taskId"),
            codeNodeId: requireString(args, "codeNodeId"),
            ...optionalEnumProperty(args, "kind", CODE_SCOPE_BINDING_KINDS),
          },
          requireActor(args),
          mutationOptions(args),
        ),
      };
    case "questboard_detach_task_code_scope":
      return requireCodeScopeBindingService(context).detach(
        requireString(args, "bindingId"),
        requireActor(args),
        {
          ...mutationOptions(args),
          ...optionalPositiveIntegerProperty(args, "expectedRevision"),
        },
      );
    case "questboard_relink_task_code_scope":
      return {
        codeScopeBinding: requireCodeScopeBindingService(context).relink(
          requireString(args, "bindingId"),
          requireActor(args),
          {
            ...mutationOptions(args),
            ...optionalPositiveIntegerProperty(args, "expectedRevision"),
          },
        ),
      };
    case "questboard_create_task_for_code_scope":
      return requireCodeScopeBindingService(context).createTaskForScope(
        {
          projectId: requireString(args, "projectId"),
          codeNodeId: requireString(args, "codeNodeId"),
          ...optionalEnumProperty(args, "kind", CODE_SCOPE_BINDING_KINDS),
          task: {
            title: requireString(args, "title"),
            ...optionalStringProperty(args, "description"),
            ...optionalStringProperty(args, "goal"),
            ...optionalStringProperty(args, "now"),
            ...optionalStringProperty(args, "next"),
            ...optionalEnumProperty(args, "status", TASK_STATUSES),
            ...optionalEnumProperty(args, "priority", TASK_PRIORITIES),
            ...optionalStringArrayProperty(args, "tags"),
          },
        },
        requireActor(args),
        mutationOptions(args),
      );
    case "questboard_get_agent_focus":
      return {
        focus: requireAgentFocusService(context).latest(requireString(args, "projectId")),
        sessions: requireAgentFocusService(context).list(requireString(args, "projectId")),
      };
    case "questboard_set_agent_focus":
      return {
        focus: requireAgentFocusService(context).set({
          projectId: requireString(args, "projectId"),
          sessionId: requireString(args, "sessionId"),
          ...optionalStringProperty(args, "taskId"),
          ...optionalStringProperty(args, "workGroupId"),
          ...optionalStringProperty(args, "flowNodeId"),
          ...optionalStringProperty(args, "codeScopeId"),
        }),
      };
    case "questboard_clear_agent_focus":
      return requireAgentFocusService(context).clear(
        requireString(args, "projectId"),
        requireString(args, "sessionId"),
      );
    case "questboard_list_code_map_manual_relations":
      return {
        manualRelations: requireCodeMapAugmentationService(context).list(requireString(args, "projectId")),
      };
    case "questboard_create_code_map_manual_relation":
      return {
        manualRelation: requireCodeMapAugmentationService(context).create(
          {
            projectId: requireString(args, "projectId"),
            fromCodeNodeId: requireString(args, "fromCodeNodeId"),
            toCodeNodeId: requireString(args, "toCodeNodeId"),
            relationKind: requireEnum(args, "relationKind", CODE_RELATION_KINDS),
            ...optionalStringProperty(args, "label"),
            ...optionalStringProperty(args, "rationale"),
          },
          requireActor(args),
          mutationOptions(args),
        ),
      };
    case "questboard_update_code_map_manual_relation":
      return {
        manualRelation: requireCodeMapAugmentationService(context).update(
          requireString(args, "relationId"),
          {
            ...optionalPositiveIntegerProperty(args, "expectedRevision"),
            ...optionalStringProperty(args, "fromCodeNodeId"),
            ...optionalStringProperty(args, "toCodeNodeId"),
            ...optionalEnumProperty(args, "relationKind", CODE_RELATION_KINDS),
            ...optionalStringProperty(args, "label"),
            ...optionalStringProperty(args, "rationale"),
          },
          requireActor(args),
          mutationOptions(args),
        ),
      };
    case "questboard_delete_code_map_manual_relation":
      return requireCodeMapAugmentationService(context).delete(
        requireString(args, "relationId"),
        requireActor(args),
        {
          ...mutationOptions(args),
          ...optionalPositiveIntegerProperty(args, "expectedRevision"),
        },
      );
    case "questboard_preview_code_map_investigation_sync": {
      const sync = requireCodeMapInvestigationSyncService(context);
      return {
        preview: sync.preview(requireString(args, "projectId"), codeMapSyncSelection(args)),
      };
    }
    case "questboard_apply_code_map_investigation_sync": {
      const sync = requireCodeMapInvestigationSyncService(context);
      return {
        result: sync.apply(
          requireString(args, "projectId"),
          {
            ...codeMapSyncSelection(args),
            expectedProjectionFingerprint: requireString(args, "expectedProjectionFingerprint"),
          },
          requireActor(args),
          requireString(args, "requestId"),
        ),
      };
    }
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
  if (error instanceof CodeMapQueryError) return { code: error.code, message: error.message };
  if (error instanceof CodeProviderLifecycleError) return { code: error.code, message: error.message };
  if (error instanceof CodeMapAugmentationError) return { code: error.code, message: error.message };
  if (error instanceof CodeScopeBindingError) return { code: error.code, message: error.message };
  if (error instanceof CodeMapInvestigationSyncError) return { code: error.code, message: error.message };
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

function normalizeAgentToolRuntime(runtime: QuestBoardAgentToolRuntime): QuestBoardAgentToolContext {
  if ("service" in runtime) return runtime;
  return { service: runtime };
}

function codeMapAgentStatus(
  context: QuestBoardAgentToolContext,
  service: QuestBoardService,
  projectId: string,
): Record<string, unknown> {
  const project = service.getProject(projectId);
  const codeMap = context.codeMapService;
  const cached = codeMap?.getCached(projectId);
  const snapshotState = codeMap?.snapshotLifecycleState(projectId);
  const hydrationDiagnostic = codeMap?.hydrationDiagnostic(projectId);
  const providerCapabilities = codeMap?.providerCapabilities(projectId);
  return {
    projectId,
    enabled: Boolean(codeMap),
    available: Boolean(codeMap),
    rootPathConfigured: Boolean(project.rootPath),
    indexed: Boolean(cached),
    ...(codeMap ? { provider: codeMap.providerId, capabilities: codeMap.capabilities } : {}),
    ...(cached
      ? {
          indexedAt: cached.graph.indexedAt,
          nodeCount: cached.graph.nodes.length,
          relationCount: cached.graph.relations.length,
          projectionQuality: cached.projection.quality,
        }
      : {}),
    ...(snapshotState ?? {}),
    ...(hydrationDiagnostic ?? {}),
    ...(providerCapabilities ? { providerCapabilities } : {}),
  };
}

function refreshCodeMapForAgent(
  context: QuestBoardAgentToolContext,
  service: QuestBoardService,
  projectId: string,
): { refresh: Record<string, unknown> } {
  const project = service.getProject(projectId);
  const codeMap = requireCodeMapService(context);
  if (!project.rootPath) {
    throw new QuestBoardRemoteToolError(
      "code_map_root_missing",
      "Project rootPath is required before indexing Code Map",
    );
  }
  const refresh = codeMap.startRefresh({ projectId, rootPath: project.rootPath });
  return {
    refresh: {
      projectId,
      provider: codeMap.providerId,
      jobId: refresh.jobId,
      state: refresh.state,
      phase: refresh.phase,
      startedAt: refresh.startedAt,
      updatedAt: refresh.updatedAt,
    },
  };
}

function requireCodeMapService(context: QuestBoardAgentToolContext): CodeMapService {
  if (!context.codeMapService) {
    throw new QuestBoardRemoteToolError(
      "code_map_query_unavailable",
      "Code Map queries are not available in this QuestBoard runtime",
    );
  }
  return context.codeMapService;
}

function requireCodeScopeBindingService(context: QuestBoardAgentToolContext): CodeScopeBindingService {
  if (!context.codeScopeBindingService) {
    throw new QuestBoardRemoteToolError(
      "code_scope_binding_unavailable",
      "Task-to-CodeScope bindings are not available in this QuestBoard runtime",
    );
  }
  return context.codeScopeBindingService;
}

function requireAgentFocusService(context: QuestBoardAgentToolContext): AgentFocusService {
  if (!context.agentFocusService) {
    throw new QuestBoardRemoteToolError(
      "agent_focus_unavailable",
      "Ephemeral Agent Focus is not available in this QuestBoard runtime",
    );
  }
  return context.agentFocusService;
}

function requireCodeMapAugmentationService(context: QuestBoardAgentToolContext): CodeMapAugmentationService {
  if (!context.codeMapAugmentationService) {
    throw new QuestBoardRemoteToolError(
      "code_map_augmentation_unavailable",
      "Code Map manual augmentation is not available in this QuestBoard runtime",
    );
  }
  return context.codeMapAugmentationService;
}

const CODE_MAP_QUERY_INPUT_DIRECTIONS = [
  "incoming",
  "outgoing",
  "both",
  "parents",
  "children",
] as const;

function codeMapQueryInput(args: Record<string, unknown>): CodeMapQueryInput {
  const kinds = optionalEnumArray(args, "kinds", CODE_NODE_KINDS);
  const relationKinds = optionalEnumArray(args, "relationKinds", CODE_RELATION_KINDS);
  const nodeIds = "nodeIds" in args ? requireStringArray(args, "nodeIds") : undefined;
  return {
    operation: requireEnum(args, "operation", CODE_MAP_QUERY_OPERATIONS),
    ...optionalStringProperty(args, "query"),
    ...optionalStringProperty(args, "path"),
    ...(kinds ? { kinds } : {}),
    ...optionalStringProperty(args, "language"),
    ...optionalStringProperty(args, "nodeId"),
    ...optionalStringProperty(args, "canonicalIdentity"),
    ...optionalEnumProperty(args, "direction", CODE_MAP_QUERY_INPUT_DIRECTIONS),
    ...(relationKinds ? { relationKinds } : {}),
    ...optionalEnumProperty(args, "semantic", CODE_MAP_RELATION_SEMANTICS),
    ...(nodeIds ? { nodeIds } : {}),
    ...optionalPositiveIntegerProperty(args, "depth"),
    ...optionalPositiveIntegerProperty(args, "limit"),
  };
}

function requireCodeMapInvestigationSyncService(context: QuestBoardAgentToolContext): CodeMapInvestigationSyncService {
  if (!context.codeMapInvestigationSyncService) {
    throw new QuestBoardRemoteToolError(
      "code_map_sync_unavailable",
      "Code Map to Investigation sync is not available in this QuestBoard runtime",
    );
  }
  return context.codeMapInvestigationSyncService;
}

function codeMapSyncSelection(args: Record<string, unknown>): CodeMapInvestigationSyncSelection {
  return {
    ...optionalStringArrayProperty(args, "codeNodeIds"),
    ...optionalBooleanProperty(args, "includeRelations"),
    ...optionalBooleanProperty(args, "recreateDetached"),
  };
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

function optionalFiniteNumberProperty<K extends string>(
  value: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  if (!(key in value) || value[key] === undefined) return {};
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item)) throw new TypeError(`${key} must be a finite number`);
  return { [key]: item } as Partial<Record<K, number>>;
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

function optionalEnumArray<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  values: T,
): T[number][] | undefined {
  if (!(key in value)) return undefined;
  const item = value[key];
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${key} must be an array of strings`);
  }
  return item.map((entry) => parseEnum(entry as string, key, values));
}

function optionalBooleanProperty<K extends string>(
  value: Record<string, unknown>,
  key: K,
): Partial<Record<K, boolean>> {
  if (!(key in value)) return {};
  const item = value[key];
  if (typeof item !== "boolean") throw new TypeError(`${key} must be a boolean`);
  return { [key]: item } as Partial<Record<K, boolean>>;
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
