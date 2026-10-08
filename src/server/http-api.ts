import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  ActivityType,
  ActorRef,
  ArtifactType,
  BoardEntityType,
  ProjectStatus,
  RelationEntityType,
  TaskPriority,
  TaskStatus,
} from "../core/domain.js";
import { ARTIFACT_TYPES, BOARD_ENTITY_TYPES, FLOW_WORK_GROUP_MEMBER_TYPES, RELATION_ENTITY_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "../core/domain.js";
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
  CreateArtifactInput,
  CheckpointTaskInput,
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
  UpdateProjectInput,
  UpdateTaskInput,
} from "../application/quest-board-service.js";
import type { CodeMapService } from "../application/code-map-service.js";
import { CodeMapAugmentationError, type CodeMapAugmentationService } from "../application/code-map-augmentation.js";
import {
  CODE_SCOPE_BINDING_KINDS,
  CodeScopeBindingError,
  type CodeScopeBindingService,
} from "../application/code-scope-binding.js";
import { CodeMapQueryError } from "../application/code-map-query.js";
import { CodeProviderLifecycleError } from "../application/code-map-provider-registry.js";
import { AGENT_FOCUS_SURFACES, AGENT_NAVIGATION_INTENTS, type AgentFocusService } from "../application/agent-focus.js";
import {
  CodeMapInvestigationSyncError,
  type CodeMapInvestigationSyncSelection,
  type CodeMapInvestigationSyncService,
} from "../application/code-map-investigation-sync.js";
import { describeQuestBoardError, executeQuestBoardAgentTool } from "../adapters/agent-tools.js";
import { createQuestBoardMcpHandler } from "../adapters/mcp/mcp-server.js";
import type { QuestBoardDaemonIdentity } from "./daemon-identity.js";
import type { QuestBoardCodeMapAvailability } from "./code-map-config.js";

const MAX_BODY_BYTES = 1024 * 1024;
const PROJECT_STATUSES = ["active", "archived"] as const satisfies readonly ProjectStatus[];
const CLIENT_ACTIVITY_TYPES = ["note_added", "agent_handoff"] as const satisfies readonly ActivityType[];

export interface QuestBoardHttpServerOptions {
  webRoot?: string;
  daemonIdentity?: QuestBoardDaemonIdentity;
  codeMapService?: CodeMapService;
  codeMapInvestigationSyncService?: CodeMapInvestigationSyncService;
  codeMapAugmentationService?: CodeMapAugmentationService;
  codeScopeBindingService?: CodeScopeBindingService;
  agentFocusService?: AgentFocusService;
  codeMapAvailability?: QuestBoardCodeMapAvailability;
}

export function createQuestBoardHttpServer(
  service: QuestBoardService,
  options: QuestBoardHttpServerOptions = {},
): Server {
  return createServer((request, response) => {
    void handleRequest(service, options, request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
}

async function handleRequest(
  service: QuestBoardService,
  options: QuestBoardHttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (method === "GET" && options.webRoot && isWebAsset(pathname)) {
    await sendWebAsset(response, options.webRoot, pathname);
    return;
  }

  if (method === "GET" && pathname === "/health") {
    const includeDaemonIdentity = singleHeader(request, "x-questboard-daemon-client")?.trim() === "1";
    sendJson(response, 200, {
      status: "ok",
      ...(includeDaemonIdentity && options.daemonIdentity ? { daemon: options.daemonIdentity } : {}),
    });
    return;
  }

  if (method === "POST" && pathname === "/_questboard/agent-tool") {
    requireDaemonClient(request);
    const body = await readJsonObject(request);
    const name = requireString(body, "name");
    const args = requireObjectValue(body.arguments ?? {}, "arguments");
    try {
      sendJson(response, 200, {
        result: await executeQuestBoardAgentTool(
          {
            service,
            ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
            ...(options.codeMapAugmentationService
              ? { codeMapAugmentationService: options.codeMapAugmentationService }
              : {}),
            ...(options.codeScopeBindingService
              ? { codeScopeBindingService: options.codeScopeBindingService }
              : {}),
            ...(options.agentFocusService ? { agentFocusService: options.agentFocusService } : {}),
            ...(options.codeMapInvestigationSyncService
              ? { codeMapInvestigationSyncService: options.codeMapInvestigationSyncService }
              : {}),
          },
          name,
          args,
        ),
      });
    } catch (error) {
      sendJson(response, 200, { error: describeQuestBoardError(error) });
    }
    return;
  }

  if (method === "POST" && pathname === "/_questboard/mcp-proxy") {
    requireDaemonClient(request);
    const body = await readJsonObject(request);
    const sessionId = requireString(body, "sessionId");
    const mcpResponse = await createQuestBoardMcpHandler(
      {
        service,
        ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
        ...(options.codeMapAugmentationService
          ? { codeMapAugmentationService: options.codeMapAugmentationService }
          : {}),
        ...(options.codeScopeBindingService
          ? { codeScopeBindingService: options.codeScopeBindingService }
          : {}),
        ...(options.agentFocusService ? { agentFocusService: options.agentFocusService } : {}),
        ...(options.codeMapInvestigationSyncService
          ? { codeMapInvestigationSyncService: options.codeMapInvestigationSyncService }
          : {}),
      },
      sessionId,
    ).handle(body.message);
    if (mcpResponse === null) {
      sendNoContent(response);
    } else {
      sendJson(response, 200, mcpResponse);
    }
    return;
  }

  const codeMapStatusMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/status$/);
  if (codeMapStatusMatch && method === "GET") {
    const projectId = decodePathPart(codeMapStatusMatch[1]);
    sendJson(response, 200, await executeQuestBoardAgentTool(
      {
        service,
        ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
      },
      "questboard_get_code_map_status",
      { projectId },
    ));
    return;
  }

  const codeMapSubsystemsMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/subsystems$/);
  if (codeMapSubsystemsMatch && method === "GET") {
    const projectId = decodePathPart(codeMapSubsystemsMatch[1]);
    service.getProject(projectId);
    sendJson(response, 200, executeQuestBoardAgentTool(
      {
        service,
        ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
      },
      "questboard_get_code_map_subsystems",
      { projectId },
    ));
    return;
  }

  const codeMapSubsystemQueryMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/subsystems\/query$/);
  if (codeMapSubsystemQueryMatch && method === "POST") {
    const projectId = decodePathPart(codeMapSubsystemQueryMatch[1]);
    service.getProject(projectId);
    if (!options.codeMapService) {
      sendJson(response, 503, {
        error: {
          code: "code_map_query_unavailable",
          message: "Code Map subsystem queries are not available in this QuestBoard runtime",
        },
      });
      return;
    }
    const body = await readJsonObject(request);
    sendJson(response, 200, executeQuestBoardAgentTool(
      { service, codeMapService: options.codeMapService },
      "questboard_query_code_map_subsystems",
      { ...body, projectId },
    ));
    return;
  }

  const codeMapRefreshMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/refresh$/);
  if (codeMapRefreshMatch && method === "GET") {
    const projectId = decodePathPart(codeMapRefreshMatch[1]);
    sendJson(response, 200, await executeQuestBoardAgentTool(
      {
        service,
        ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
      },
      "questboard_get_code_map_refresh_status",
      { projectId },
    ));
    return;
  }
  if (codeMapRefreshMatch && method === "POST") {
    const projectId = decodePathPart(codeMapRefreshMatch[1]);
    try {
      sendJson(response, 202, await executeQuestBoardAgentTool(
        {
          service,
          ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
        },
        "questboard_refresh_code_map",
        { projectId },
      ));
    } catch (error) {
      const described = describeQuestBoardError(error);
      const statusCode = described.code === "not_found"
        ? 404
        : described.code === "code_map_root_missing"
          ? 409
          : described.code === "code_map_query_unavailable" || described.code === "code_map_provider_failed"
            ? 503
            : 400;
      sendJson(response, statusCode, { error: described });
    }
    return;
  }

  const agentFocusMatch = pathname.match(/^\/projects\/([^/]+)\/agent-focus$/);
  if (agentFocusMatch && options.agentFocusService) {
    const projectId = decodePathPart(agentFocusMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, {
        focus: options.agentFocusService.latest(projectId),
        sessions: options.agentFocusService.list(projectId),
      });
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(request);
      sendJson(response, 200, {
        focus: options.agentFocusService.set({
          projectId,
          sessionId: requireString(body, "sessionId"),
          ...optionalPositiveIntegerProperty(body, "sequence"),
          ...optionalEnumProperty(body, "activeSurface", AGENT_FOCUS_SURFACES),
          ...optionalEnumProperty(body, "navigationIntent", AGENT_NAVIGATION_INTENTS),
          ...optionalStringProperty(body, "taskId"),
          ...optionalStringProperty(body, "workGroupId"),
          ...optionalStringProperty(body, "flowNodeId"),
          ...optionalStringProperty(body, "codeScopeId"),
        }),
      });
      return;
    }
    if (method === "DELETE") {
      const sessionId = optionalQueryText(url, "sessionId");
      if (!sessionId) throw new TypeError("sessionId query parameter is required");
      sendJson(response, 200, options.agentFocusService.clear(projectId, sessionId));
      return;
    }
  }

  if (pathname === "/projects") {
    if (method === "GET") {
      sendJson(response, 200, { projects: service.listProjects() });
      return;
    }
    if (method === "POST") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const input: CreateProjectInput = {
        name: requireString(body, "name"),
        ...optionalStringProperty(body, "description"),
        ...optionalStringProperty(body, "rootPath"),
      };
      sendJson(response, 201, { project: service.createProject(input, actor, mutationOptions(request)) });
      return;
    }
  }

  const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectId = decodePathPart(projectMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, { project: service.getProject(projectId) });
      return;
    }
    if (method === "PATCH") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const input: UpdateProjectInput = {
        ...optionalStringProperty(body, "name"),
        ...optionalStringProperty(body, "description"),
        ...optionalStringProperty(body, "rootPath"),
        ...optionalEnumProperty(body, "status", PROJECT_STATUSES),
      };
      sendJson(response, 200, { project: service.updateProject(projectId, input, actor, mutationOptions(request)) });
      return;
    }
  }

  const codeMapSyncMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/investigation-sync\/(preview|apply)$/);
  if (codeMapSyncMatch && method === "POST") {
    const projectId = decodePathPart(codeMapSyncMatch[1]);
    service.getProject(projectId);
    const sync = options.codeMapInvestigationSyncService;
    if (!sync) {
      sendJson(response, 503, {
        error: {
          code: "code_map_sync_unavailable",
          message: "Code Map to Investigation sync is not available in this QuestBoard runtime",
        },
      });
      return;
    }

    const body = await readJsonObject(request);
    const selection: CodeMapInvestigationSyncSelection = {
      ...optionalStringArrayProperty(body, "codeNodeIds"),
      ...optionalBooleanProperty(body, "includeRelations"),
      ...optionalBooleanProperty(body, "recreateDetached"),
    };
    if (codeMapSyncMatch[2] === "preview") {
      sendJson(response, 200, { preview: sync.preview(projectId, selection) });
      return;
    }

    const requestId = mutationOptions(request).requestId;
    if (!requestId) {
      throw new TypeError("Sync apply requires x-questboard-request-id or idempotency-key header");
    }
    sendJson(response, 200, {
      result: sync.apply(
        projectId,
        {
          ...selection,
          expectedProjectionFingerprint: requireString(body, "expectedProjectionFingerprint"),
        },
        requireActor(request),
        requestId,
      ),
    });
    return;
  }

  const codeMapProviderInstallMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/providers\/([^/]+)\/install-request$/);
  if (codeMapProviderInstallMatch && method === "POST") {
    const projectId = decodePathPart(codeMapProviderInstallMatch[1]);
    service.getProject(projectId);
    sendJson(response, 200, await executeQuestBoardAgentTool(
      {
        service,
        ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
      },
      "questboard_request_code_map_provider_install",
      { projectId, providerId: decodePathPart(codeMapProviderInstallMatch[2]) },
    ));
    return;
  }

  const codeMapProvidersMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/providers$/);
  if (codeMapProvidersMatch && method === "GET") {
    const projectId = decodePathPart(codeMapProvidersMatch[1]);
    service.getProject(projectId);
    sendJson(response, 200, await executeQuestBoardAgentTool(
      {
        service,
        ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
      },
      "questboard_get_code_map_provider_capabilities",
      { projectId },
    ));
    return;
  }

  const codeMapContinuationMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/continuations\/query$/);
  if (codeMapContinuationMatch && method === "POST") {
    const projectId = decodePathPart(codeMapContinuationMatch[1]);
    service.getProject(projectId);
    if (!options.codeMapService) {
      sendJson(response, 503, {
        error: {
          code: "code_map_query_unavailable",
          message: "Code Map continuation queries are not available in this QuestBoard runtime",
        },
      });
      return;
    }
    const body = await readJsonObject(request);
    sendJson(response, 200, executeQuestBoardAgentTool(
      { service, codeMapService: options.codeMapService },
      "questboard_query_code_map_continuations",
      { ...body, projectId },
    ));
    return;
  }

  const codeMapQueryMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/query$/);
  if (codeMapQueryMatch && method === "POST") {
    const projectId = decodePathPart(codeMapQueryMatch[1]);
    service.getProject(projectId);
    if (!options.codeMapService) {
      sendJson(response, 503, {
        error: {
          code: "code_map_query_unavailable",
          message: "Code Map queries are not available in this QuestBoard runtime",
        },
      });
      return;
    }
    const body = await readJsonObject(request);
    sendJson(response, 200, executeQuestBoardAgentTool(
      {
        service,
        codeMapService: options.codeMapService,
        ...(options.codeMapAugmentationService
          ? { codeMapAugmentationService: options.codeMapAugmentationService }
          : {}),
        ...(options.codeMapInvestigationSyncService
          ? { codeMapInvestigationSyncService: options.codeMapInvestigationSyncService }
          : {}),
      },
      "questboard_query_code_map",
      { ...body, projectId },
    ));
    return;
  }

  const codeMapManualRelationsMatch = pathname.match(/^\/projects\/([^/]+)\/code-map\/manual-relations$/);
  if (codeMapManualRelationsMatch) {
    const projectId = decodePathPart(codeMapManualRelationsMatch[1]);
    service.getProject(projectId);
    if (!options.codeMapAugmentationService) {
      sendJson(response, 503, {
        error: {
          code: "code_map_augmentation_unavailable",
          message: "Code Map manual augmentation is not available in this QuestBoard runtime",
        },
      });
      return;
    }
    const context = {
      service,
      ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
      codeMapAugmentationService: options.codeMapAugmentationService,
    };
    if (method === "GET") {
      sendJson(response, 200, executeQuestBoardAgentTool(
        context,
        "questboard_list_code_map_manual_relations",
        { projectId },
      ));
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(request);
      sendJson(response, 201, executeQuestBoardAgentTool(
        context,
        "questboard_create_code_map_manual_relation",
        {
          ...body,
          projectId,
          actor: requireActor(request),
          ...mutationOptions(request),
        },
      ));
      return;
    }
  }

  const codeMapManualRelationMatch = pathname.match(/^\/code-map\/manual-relations\/([^/]+)$/);
  if (codeMapManualRelationMatch && (method === "PATCH" || method === "DELETE")) {
    if (!options.codeMapAugmentationService) {
      sendJson(response, 503, {
        error: {
          code: "code_map_augmentation_unavailable",
          message: "Code Map manual augmentation is not available in this QuestBoard runtime",
        },
      });
      return;
    }
    const relationId = decodePathPart(codeMapManualRelationMatch[1]);
    const context = {
      service,
      ...(options.codeMapService ? { codeMapService: options.codeMapService } : {}),
      codeMapAugmentationService: options.codeMapAugmentationService,
    };
    if (method === "PATCH") {
      const body = await readJsonObject(request);
      sendJson(response, 200, executeQuestBoardAgentTool(
        context,
        "questboard_update_code_map_manual_relation",
        {
          ...body,
          relationId,
          actor: requireActor(request),
          ...mutationOptions(request),
        },
      ));
      return;
    }
    const expectedRevision = url.searchParams.get("expectedRevision");
    sendJson(response, 200, executeQuestBoardAgentTool(
      context,
      "questboard_delete_code_map_manual_relation",
      {
        relationId,
        actor: requireActor(request),
        ...mutationOptions(request),
        ...(expectedRevision ? { expectedRevision: Number(expectedRevision) } : {}),
      },
    ));
    return;
  }

  const codeScopeBindingsMatch = pathname.match(/^\/projects\/([^/]+)\/code-scope-bindings$/);
  if (codeScopeBindingsMatch && options.codeScopeBindingService) {
    const projectId = decodePathPart(codeScopeBindingsMatch[1]);
    if (method === "GET") {
      const taskId = optionalQueryText(url, "taskId");
      const codeNodeId = optionalQueryText(url, "codeNodeId");
      sendJson(response, 200, {
        codeScopeBindings: options.codeScopeBindingService.list(projectId, {
          ...(taskId ? { taskId } : {}),
          ...(codeNodeId ? { codeNodeId } : {}),
        }),
      });
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(request);
      const binding = options.codeScopeBindingService.attach(
        {
          projectId,
          taskId: requireString(body, "taskId"),
          codeNodeId: requireString(body, "codeNodeId"),
          ...optionalEnumProperty(body, "kind", CODE_SCOPE_BINDING_KINDS),
        },
        requireActor(request),
        mutationOptions(request),
      );
      sendJson(response, 201, { codeScopeBinding: binding });
      return;
    }
  }

  const createScopedTaskMatch = pathname.match(/^\/projects\/([^/]+)\/code-scope-tasks$/);
  if (createScopedTaskMatch && method === "POST" && options.codeScopeBindingService) {
    const projectId = decodePathPart(createScopedTaskMatch[1]);
    const body = await readJsonObject(request);
    sendJson(response, 201, options.codeScopeBindingService.createTaskForScope(
      {
        projectId,
        codeNodeId: requireString(body, "codeNodeId"),
        ...optionalEnumProperty(body, "kind", CODE_SCOPE_BINDING_KINDS),
        task: {
          title: requireString(body, "title"),
          ...optionalStringProperty(body, "description"),
          ...optionalStringProperty(body, "goal"),
          ...optionalStringProperty(body, "now"),
          ...optionalStringProperty(body, "next"),
          ...optionalEnumProperty(body, "status", TASK_STATUSES),
          ...optionalEnumProperty(body, "priority", TASK_PRIORITIES),
          ...optionalStringArrayProperty(body, "tags"),
        },
      },
      requireActor(request),
      mutationOptions(request),
    ));
    return;
  }

  const codeScopeBindingMatch = pathname.match(/^\/code-scope-bindings\/([^/]+)$/);
  if (codeScopeBindingMatch && method === "DELETE" && options.codeScopeBindingService) {
    const expectedRevisionText = optionalQueryText(url, "expectedRevision");
    const expectedRevision = expectedRevisionText ? Number(expectedRevisionText) : undefined;
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
      throw new TypeError("expectedRevision must be a positive integer");
    }
    sendJson(response, 200, options.codeScopeBindingService.detach(
      decodePathPart(codeScopeBindingMatch[1]),
      requireActor(request),
      { ...mutationOptions(request), ...(expectedRevision ? { expectedRevision } : {}) },
    ));
    return;
  }

  const codeScopeRelinkMatch = pathname.match(/^\/code-scope-bindings\/([^/]+)\/relink$/);
  if (codeScopeRelinkMatch && method === "POST" && options.codeScopeBindingService) {
    const body = await readJsonObject(request);
    sendJson(response, 200, {
      codeScopeBinding: options.codeScopeBindingService.relink(
        decodePathPart(codeScopeRelinkMatch[1]),
        requireActor(request),
        {
          ...mutationOptions(request),
          ...optionalPositiveIntegerProperty(body, "expectedRevision"),
        },
      ),
    });
    return;
  }

  const codeMapMatch = pathname.match(/^\/projects\/([^/]+)\/code-map$/);
  if (codeMapMatch) {
    const projectId = decodePathPart(codeMapMatch[1]);
    const project = service.getProject(projectId);
    const codeMapService = options.codeMapService;
    const availability = options.codeMapAvailability;
    const enabled = availability?.enabled ?? Boolean(codeMapService);
    const available = availability?.available ?? Boolean(codeMapService);
    const provider = codeMapService?.providerId ?? availability?.provider;

    if (method === "GET") {
      const cached = codeMapService?.getCached(projectId);
      const snapshotState = codeMapService?.snapshotLifecycleState(projectId);
      const hydrationDiagnostic = codeMapService?.hydrationDiagnostic(projectId);
      sendJson(response, 200, {
        enabled,
        available,
        indexed: Boolean(cached),
        ...(provider ? { provider } : {}),
        ...(codeMapService ? { capabilities: codeMapService.capabilities } : {}),
        ...(availability?.reason ? { reason: availability.reason } : {}),
        ...(availability?.message ? { message: availability.message } : {}),
        ...(availability?.missingExecutables ? { missingExecutables: availability.missingExecutables } : {}),
        ...(snapshotState ?? {}),
        ...(codeMapService?.snapshotIdentity(projectId) ?? {}),
        ...(hydrationDiagnostic ?? {}),
        ...(codeMapService?.providerCapabilities(projectId)
          ? { providerCapabilities: codeMapService.providerCapabilities(projectId) }
          : {}),
        graph: cached?.graph ?? null,
        projection: cached?.projection ?? null,
        manualRelations: codeMapService?.manualRelations(projectId) ?? [],
        codeScopeBindings: options.codeScopeBindingService?.list(projectId) ?? [],
      });
      return;
    }

    if (method === "POST") {
      if (!codeMapService) {
        sendJson(response, 503, {
          enabled,
          available: false,
          ...(provider ? { provider } : {}),
          ...(availability?.reason ? { reason: availability.reason } : {}),
          ...(availability?.missingExecutables ? { missingExecutables: availability.missingExecutables } : {}),
          error: {
            code: "code_map_unavailable",
            message: availability?.message ?? "Code Map indexing is not enabled for this QuestBoard runtime",
          },
        });
        return;
      }
      if (!project.rootPath) {
        sendJson(response, 409, {
          error: {
            code: "code_map_root_missing",
            message: "Project rootPath is required before indexing Code Map",
          },
        });
        return;
      }
      let refreshed;
      try {
        refreshed = await codeMapService.refresh({ projectId, rootPath: project.rootPath });
      } catch {
        const cached = codeMapService.getCached(projectId);
        sendJson(response, 503, {
          enabled: true,
          available: true,
          indexed: Boolean(cached),
          provider: codeMapService.providerId,
          graph: cached?.graph ?? null,
          projection: cached?.projection ?? null,
          manualRelations: codeMapService.manualRelations(projectId),
          codeScopeBindings: options.codeScopeBindingService?.list(projectId) ?? [],
          error: {
            code: "code_map_provider_failed",
            message: `Code Map provider ${codeMapService.providerId} failed to index this project`,
          },
        });
        return;
      }
      sendJson(response, 200, {
        enabled: true,
        available: true,
        indexed: true,
        provider: codeMapService.providerId,
        capabilities: codeMapService.capabilities,
        ...(codeMapService.providerCapabilities(projectId)
          ? { providerCapabilities: codeMapService.providerCapabilities(projectId) }
          : {}),
        mode: refreshed.mode,
        changedCodeNodeIds: refreshed.changedCodeNodeIds,
        changedArchitectureNodeIds: refreshed.changedArchitectureNodeIds,
        graph: refreshed.graph,
        projection: refreshed.projection,
        manualRelations: codeMapService.manualRelations(projectId),
        codeScopeBindings: options.codeScopeBindingService?.list(projectId) ?? [],
      });
      return;
    }
  }

  const investigationMatch = pathname.match(/^\/projects\/([^/]+)\/investigation$/);
  if (investigationMatch && method === "GET") {
    const projectId = decodePathPart(investigationMatch[1]);
    const graph = service.getInvestigationGraph(projectId);
    sendJson(response, 200, {
      tasks: graph.tasks,
      artifacts: graph.artifacts,
      relations: graph.relations,
      positions: graph.positions,
    });
    return;
  }

  const graphMatch = pathname.match(/^\/projects\/([^/]+)\/investigation\/graph$/);
  if (graphMatch && method === "GET") {
    sendJson(response, 200, service.getInvestigationGraph(decodePathPart(graphMatch[1])));
    return;
  }

  const flowGroupsMatch = pathname.match(/^\/projects\/([^/]+)\/flow-work-groups$/);
  if (flowGroupsMatch) {
    const projectId = decodePathPart(flowGroupsMatch[1]);
    if (method === "GET") {
      const graph = service.getInvestigationGraph(projectId);
      sendJson(response, 200, { groups: graph.flowWorkGroups, memberships: graph.flowWorkGroupMemberships });
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(request);
      const input = {
        projectId,
        title: requireString(body, "title"),
        ...optionalStringProperty(body, "goal"),
        ...optionalStringProperty(body, "parentGroupId"),
        ...optionalStringProperty(body, "linkedTaskId"),
        ...optionalFiniteNumberProperty(body, "x"),
        ...optionalFiniteNumberProperty(body, "y"),
        ...optionalFiniteNumberProperty(body, "width"),
        ...optionalFiniteNumberProperty(body, "height"),
        ...optionalBooleanProperty(body, "collapsed"),
      };
      sendJson(response, 201, { group: service.createFlowWorkGroup(input, requireActor(request), mutationOptions(request)) });
      return;
    }
  }

  const flowGroupMatch = pathname.match(/^\/flow-work-groups\/([^/]+)$/);
  if (flowGroupMatch) {
    const groupId = decodePathPart(flowGroupMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, { group: service.getFlowWorkGroup(groupId) });
      return;
    }
    if (method === "PATCH") {
      const body = await readJsonObject(request);
      const patch = {
        ...optionalPositiveIntegerProperty(body, "expectedRevision"),
        ...optionalStringProperty(body, "title"),
        ...optionalStringProperty(body, "goal"),
        ...optionalFiniteNumberProperty(body, "x"),
        ...optionalFiniteNumberProperty(body, "y"),
        ...optionalFiniteNumberProperty(body, "width"),
        ...optionalFiniteNumberProperty(body, "height"),
        ...optionalBooleanProperty(body, "collapsed"),
      } as Parameters<QuestBoardService["updateFlowWorkGroup"]>[1];
      if ("parentGroupId" in body) patch.parentGroupId = body.parentGroupId === null ? null : requireString(body, "parentGroupId");
      if ("linkedTaskId" in body) patch.linkedTaskId = body.linkedTaskId === null ? null : requireString(body, "linkedTaskId");
      sendJson(response, 200, { group: service.updateFlowWorkGroup(groupId, patch, requireActor(request), mutationOptions(request)) });
      return;
    }
    if (method === "DELETE") {
      const expectedRevision = url.searchParams.get("expectedRevision");
      service.deleteFlowWorkGroup(groupId, requireActor(request), {
        ...mutationOptions(request),
        ...(expectedRevision ? { expectedRevision: Number(expectedRevision) } : {}),
      });
      sendJson(response, 200, { deleted: true });
      return;
    }
  }

  const flowGroupMemberMatch = pathname.match(/^\/flow-work-groups\/([^/]+)\/members\/([^/]+)\/([^/]+)$/);
  if (flowGroupMemberMatch && (method === "PUT" || method === "DELETE")) {
    const input = {
      groupId: decodePathPart(flowGroupMemberMatch[1]),
      entityType: requireEnum(
        { entityType: decodePathPart(flowGroupMemberMatch[2]) },
        "entityType",
        FLOW_WORK_GROUP_MEMBER_TYPES,
      ),
      entityId: decodePathPart(flowGroupMemberMatch[3]),
    };
    if (method === "PUT") {
      sendJson(response, 200, { membership: service.setFlowWorkGroupMembership(input, requireActor(request), mutationOptions(request)) });
    } else {
      service.removeFlowWorkGroupMembership(input, requireActor(request), mutationOptions(request));
      sendJson(response, 200, { removed: true });
    }
    return;
  }

  const projectNodesMatch = pathname.match(/^\/projects\/([^/]+)\/investigation\/nodes$/);
  if (projectNodesMatch) {
    const projectId = decodePathPart(projectNodesMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, { nodes: service.listInvestigationNodes(projectId) });
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(request);
      const input: CreateInvestigationNodeInput = {
        projectId,
        title: requireString(body, "title"),
        ...optionalStringProperty(body, "description"),
        ...optionalStringProperty(body, "kind"),
      };
      sendJson(response, 201, { node: service.createInvestigationNode(input, requireActor(request), mutationOptions(request)) });
      return;
    }
  }

  const graphNodeMatch = pathname.match(/^\/investigation\/nodes\/([^/]+)$/);
  if (graphNodeMatch) {
    const nodeId = decodePathPart(graphNodeMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, { node: service.getInvestigationNode(nodeId) });
      return;
    }
    if (method === "PATCH") {
      const body = await readJsonObject(request);
      const patch: UpdateInvestigationNodeInput = {
        ...optionalPositiveIntegerProperty(body, "expectedRevision"),
        ...optionalStringProperty(body, "title"),
        ...optionalStringProperty(body, "description"),
        ...optionalStringProperty(body, "kind"),
      };
      sendJson(response, 200, { node: service.updateInvestigationNode(nodeId, patch, requireActor(request), mutationOptions(request)) });
      return;
    }
  }

  const graphNodeItemsMatch = pathname.match(/^\/investigation\/nodes\/([^/]+)\/items$/);
  if (graphNodeItemsMatch && method === "POST") {
    const body = await readJsonObject(request);
    const input: CreateInvestigationItemInput = {
      nodeId: decodePathPart(graphNodeItemsMatch[1]),
      title: requireString(body, "title"),
      ...optionalStringProperty(body, "description"),
    };
    sendJson(response, 201, { item: service.createInvestigationItem(input, requireActor(request), mutationOptions(request)) });
    return;
  }

  const graphItemMatch = pathname.match(/^\/investigation\/items\/([^/]+)$/);
  if (graphItemMatch) {
    const itemId = decodePathPart(graphItemMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, { item: service.getInvestigationItem(itemId) });
      return;
    }
    if (method === "PATCH") {
      const body = await readJsonObject(request);
      const patch: UpdateInvestigationItemInput = {
        ...optionalPositiveIntegerProperty(body, "expectedRevision"),
        ...optionalStringProperty(body, "title"),
        ...optionalStringProperty(body, "description"),
      };
      sendJson(response, 200, { item: service.updateInvestigationItem(itemId, patch, requireActor(request), mutationOptions(request)) });
      return;
    }
  }

  const graphItemTasksMatch = pathname.match(/^\/investigation\/items\/([^/]+)\/tasks$/);
  if (graphItemTasksMatch && method === "POST") {
    const body = await readJsonObject(request);
    const link = service.linkTaskToInvestigationItem(
      decodePathPart(graphItemTasksMatch[1]),
      requireString(body, "taskId"),
      requireActor(request),
      mutationOptions(request),
    );
    sendJson(response, 201, { link });
    return;
  }

  const graphItemTaskMatch = pathname.match(/^\/investigation\/items\/([^/]+)\/tasks\/([^/]+)$/);
  if (graphItemTaskMatch && method === "DELETE") {
    service.unlinkTaskFromInvestigationItem(
      decodePathPart(graphItemTaskMatch[1]),
      decodePathPart(graphItemTaskMatch[2]),
      requireActor(request),
      mutationOptions(request),
    );
    sendJson(response, 200, { removed: true });
    return;
  }

  const graphItemNewTaskMatch = pathname.match(/^\/investigation\/items\/([^/]+)\/tasks\/new$/);
  if (graphItemNewTaskMatch && method === "POST") {
    const body = await readJsonObject(request);
    const input: CreateInvestigationLinkedTaskInput = {
      title: requireString(body, "title"),
      ...optionalStringProperty(body, "description"),
      ...optionalEnumProperty(body, "status", TASK_STATUSES),
      ...optionalEnumProperty(body, "priority", TASK_PRIORITIES),
      ...optionalStringArrayProperty(body, "tags"),
    };
    sendJson(response, 201, service.createTaskForInvestigationItem(
      decodePathPart(graphItemNewTaskMatch[1]), input, requireActor(request), mutationOptions(request),
    ));
    return;
  }

  if (pathname === "/investigation/item-links" && method === "POST") {
    const body = await readJsonObject(request);
    const input: CreateInvestigationItemLinkInput = {
      fromItemId: requireString(body, "fromItemId"),
      toNodeId: requireString(body, "toNodeId"),
      ...optionalStringProperty(body, "label"),
      ...optionalStringProperty(body, "kind"),
    };
    sendJson(response, 201, { link: service.createInvestigationItemLink(input, requireActor(request), mutationOptions(request)) });
    return;
  }

  const graphItemLinkMatch = pathname.match(/^\/investigation\/item-links\/([^/]+)$/);
  if (graphItemLinkMatch && method === "DELETE") {
    service.removeInvestigationItemLink(decodePathPart(graphItemLinkMatch[1]), requireActor(request), mutationOptions(request));
    sendJson(response, 200, { removed: true });
    return;
  }

  const positionMatch = pathname.match(/^\/projects\/([^/]+)\/investigation\/positions\/(task|artifact|investigation_node)\/([^/]+)$/);
  if (positionMatch && method === "PUT") {
    const projectId = decodePathPart(positionMatch[1]);
    const entityType = parseEnum(positionMatch[2] ?? "", "entityType", BOARD_ENTITY_TYPES) as BoardEntityType;
    const entityId = decodePathPart(positionMatch[3]);
    const body = await readJsonObject(request);
    const position = service.setBoardPosition(
      projectId,
      {
        entityType,
        entityId,
        x: requireFiniteNumber(body, "x"),
        y: requireFiniteNumber(body, "y"),
      },
      requireActor(request),
      mutationOptions(request),
    );
    sendJson(response, 200, { position });
    return;
  }

  if (pathname === "/tasks") {
    if (method === "GET") {
      const projectId = optionalQueryText(url, "projectId");
      const statusText = optionalQueryText(url, "status");
      const status = statusText === undefined ? undefined : parseEnum(statusText, "status", TASK_STATUSES);
      sendJson(response, 200, {
        tasks: service.listTasks({
          ...(projectId !== undefined ? { projectId } : {}),
          ...(status !== undefined ? { status } : {}),
        }),
      });
      return;
    }
    if (method === "POST") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const input: CreateTaskInput = {
        projectId: requireString(body, "projectId"),
        title: requireString(body, "title"),
        ...optionalStringProperty(body, "description"),
        ...optionalStringProperty(body, "goal"),
        ...optionalStringProperty(body, "now"),
        ...optionalStringProperty(body, "next"),
        ...optionalStringProperty(body, "blocked"),
        ...optionalStringProperty(body, "guardrail"),
        ...optionalEnumProperty(body, "status", TASK_STATUSES),
        ...optionalEnumProperty(body, "priority", TASK_PRIORITIES),
        ...optionalStringArrayProperty(body, "tags"),
      };
      sendJson(response, 201, { task: service.createTask(input, actor, mutationOptions(request)) });
      return;
    }
  }

  const taskHierarchyMatch = pathname.match(/^\/projects\/([^/]+)\/task-hierarchy$/);
  if (taskHierarchyMatch && method === "GET") {
    const projectId = decodePathPart(taskHierarchyMatch[1]);
    sendJson(response, 200, { hierarchy: service.getTaskHierarchy(projectId) });
    return;
  }

  if (pathname === "/relations" && method === "POST") {
    const actor = requireActor(request);
    const body = await readJsonObject(request);
    const input: CreateRelationInput = {
      fromType: requireEnum(body, "fromType", RELATION_ENTITY_TYPES) as RelationEntityType,
      fromId: requireString(body, "fromId"),
      toType: requireEnum(body, "toType", RELATION_ENTITY_TYPES) as RelationEntityType,
      toId: requireString(body, "toId"),
      kind: requireString(body, "kind"),
      ...optionalStringProperty(body, "label"),
    };
    sendJson(response, 201, { relation: service.createRelation(input, actor, mutationOptions(request)) });
    return;
  }

  const relationDeleteMatch = pathname.match(/^\/relations\/([^/]+)$/);
  if (relationDeleteMatch && method === "DELETE") {
    service.deleteRelation(
      decodePathPart(relationDeleteMatch[1]),
      requireActor(request),
      mutationOptions(request),
    );
    sendJson(response, 200, { deleted: true });
    return;
  }

  const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === "GET") {
    sendJson(response, 200, { artifact: service.getArtifact(decodePathPart(artifactMatch[1])) });
    return;
  }

  const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodePathPart(taskMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, { task: service.getTask(taskId, { diagnoseRead: true }) });
      return;
    }
    if (method === "PATCH") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const input: UpdateTaskInput = {
        ...optionalPositiveIntegerProperty(body, "expectedRevision"),
        ...optionalStringProperty(body, "title"),
        ...optionalStringProperty(body, "description"),
        ...optionalStringProperty(body, "goal"),
        ...optionalStringProperty(body, "now"),
        ...optionalStringProperty(body, "next"),
        ...optionalStringProperty(body, "blocked"),
        ...optionalStringProperty(body, "guardrail"),
        ...optionalEnumProperty(body, "status", TASK_STATUSES),
        ...optionalEnumProperty(body, "priority", TASK_PRIORITIES),
        ...optionalStringArrayProperty(body, "tags"),
      };
      sendJson(response, 200, { task: service.updateTask(taskId, input, actor, mutationOptions(request)) });
      return;
    }
  }

  const taskActionMatch = pathname.match(/^\/tasks\/([^/]+)\/(resume|checkpoint|claim|release|activity)$/);
  if (taskActionMatch) {
    const taskId = decodePathPart(taskActionMatch[1]);
    const action = taskActionMatch[2];

    if (method === "GET" && action === "resume") {
      sendJson(response, 200, { resume: service.resumeTask(taskId) });
      return;
    }
    if (method === "POST" && action === "checkpoint") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const input: CheckpointTaskInput = {
        now: requireString(body, "now"),
        next: requireString(body, "next"),
      };
      if ("blocked" in body) input.blocked = body.blocked === null ? null : requireString(body, "blocked");
      if ("guardrail" in body) input.guardrail = body.guardrail === null ? null : requireString(body, "guardrail");
      if ("activity" in body) {
        const activity = requireObjectValue(body.activity, "activity");
        input.activity = {
          type: requireEnum(activity, "type", CLIENT_ACTIVITY_TYPES),
          summary: requireString(activity, "summary"),
        };
      }
      sendJson(response, 200, { resume: service.checkpointTask(taskId, input, actor, mutationOptions(request)) });
      return;
    }
    if (method === "POST" && action === "claim") {
      sendJson(response, 200, { claim: service.claimTask(taskId, requireActor(request), mutationOptions(request)) });
      return;
    }
    if (method === "GET" && action === "claim") {
      sendJson(response, 200, { claim: service.getTaskClaim(taskId) ?? null });
      return;
    }
    if (method === "POST" && action === "release") {
      const body = await readJsonObject(request);
      sendJson(response, 200, {
        claim: service.releaseTask(taskId, requireActor(request), {
          ...mutationOptions(request),
          ...optionalStringProperty(body, "claimId"),
        }),
      });
      return;
    }
    if (method === "GET" && action === "activity") {
      sendJson(response, 200, { activities: service.listTaskActivity(taskId) });
      return;
    }
    if (method === "POST" && action === "activity") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const type = requireEnum(body, "type", CLIENT_ACTIVITY_TYPES);
      const summary = requireString(body, "summary");
      sendJson(response, 201, { activity: service.appendTaskActivity(taskId, type, summary, actor, mutationOptions(request)) });
      return;
    }
  }

  const taskEvidenceMatch = pathname.match(/^\/tasks\/([^/]+)\/(artifacts|relations)$/);
  if (taskEvidenceMatch) {
    const taskId = decodePathPart(taskEvidenceMatch[1]);
    const action = taskEvidenceMatch[2];
    if (method === "GET" && action === "artifacts") {
      sendJson(response, 200, { artifacts: service.listTaskArtifacts(taskId) });
      return;
    }
    if (method === "POST" && action === "artifacts") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const input: CreateArtifactInput = {
        taskId,
        type: requireEnum(body, "type", ARTIFACT_TYPES) as ArtifactType,
        title: requireString(body, "title"),
        locator: requireString(body, "locator"),
        ...optionalStringProperty(body, "description"),
      };
      sendJson(response, 201, { artifact: service.createArtifact(input, actor, mutationOptions(request)) });
      return;
    }
    if (method === "GET" && action === "relations") {
      sendJson(response, 200, { relations: service.listTaskRelations(taskId) });
      return;
    }
  }

  sendJson(response, 404, { error: { code: "route_not_found", message: "Route not found" } });
}

function isWebAsset(pathname: string): boolean {
  return pathname === "/" || pathname === "/app.js" || pathname === "/styles.css";
}

async function sendWebAsset(response: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  const asset = pathname === "/"
    ? { file: "index.html", contentType: "text/html; charset=utf-8" }
    : pathname === "/app.js"
      ? { file: "app.js", contentType: "text/javascript; charset=utf-8" }
      : { file: "styles.css", contentType: "text/css; charset=utf-8" };
  const body = await readFile(join(webRoot, asset.file));
  response.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": body.length,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function requireActor(request: IncomingMessage): ActorRef {
  const id = singleHeader(request, "x-questboard-actor-id")?.trim();
  const provider = singleHeader(request, "x-questboard-actor-provider")?.trim();
  if (!id || !provider) {
    throw new TypeError(
      "Mutation requests require x-questboard-actor-id and x-questboard-actor-provider headers",
    );
  }
  return { id, provider };
}

function requireDaemonClient(request: IncomingMessage): void {
  if (singleHeader(request, "x-questboard-daemon-client")?.trim() !== "1") {
    throw new TypeError("Daemon bridge requests require x-questboard-daemon-client: 1");
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new TypeError("Request body is too large");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TypeError("Request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${key} must be a non-empty string`);
  return value;
}

function requireObjectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requirePositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${key} must be a positive integer`);
  }
  return value as number;
}

function optionalPositiveIntegerProperty<K extends string>(
  body: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  if (!(key in body) || body[key] === undefined) return {};
  return { [key]: requirePositiveInteger(body, key) } as Partial<Record<K, number>>;
}

function mutationOptions(request: IncomingMessage): { requestId?: string } {
  const requestId = (singleHeader(request, "x-questboard-request-id") ?? singleHeader(request, "idempotency-key"))?.trim();
  return requestId ? { requestId } : {};
}

function requireFiniteNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${key} must be a finite number`);
  }
  return value;
}

function optionalFiniteNumberProperty<K extends string>(
  body: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  if (!(key in body) || body[key] === undefined) return {};
  return { [key]: requireFiniteNumber(body, key) } as Partial<Record<K, number>>;
}

function optionalStringProperty<K extends string>(
  body: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  if (!(key in body)) return {};
  const value = body[key];
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return { [key]: value } as Partial<Record<K, string>>;
}

function optionalStringArrayProperty<K extends string>(
  body: Record<string, unknown>,
  key: K,
): Partial<Record<K, string[]>> {
  if (!(key in body)) return {};
  const value = body[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${key} must be an array of strings`);
  }
  return { [key]: value as string[] } as Partial<Record<K, string[]>>;
}

function optionalBooleanProperty<K extends string>(
  body: Record<string, unknown>,
  key: K,
): Partial<Record<K, boolean>> {
  if (!(key in body)) return {};
  const value = body[key];
  if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
  return { [key]: value } as Partial<Record<K, boolean>>;
}

function requireEnum<const T extends readonly string[]>(
  body: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = requireString(body, key);
  return parseEnum(value, key, values);
}

function optionalEnumProperty<K extends string, const T extends readonly string[]>(
  body: Record<string, unknown>,
  key: K,
  values: T,
): Partial<Record<K, T[number]>> {
  if (!(key in body)) return {};
  const value = body[key];
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return { [key]: parseEnum(value, key, values) } as Partial<Record<K, T[number]>>;
}

function parseEnum<const T extends readonly string[]>(value: string, key: string, values: T): T[number] {
  if (!(values as readonly string[]).includes(value)) {
    throw new TypeError(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T[number];
}

function optionalQueryText(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function decodePathPart(value: string | undefined): string {
  if (!value) throw new TypeError("Route id is missing");
  return decodeURIComponent(value);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendNoContent(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof CodeMapQueryError) {
    const statusCode = error.code === "code_map_not_indexed"
      || error.code === "code_map_subsystem_snapshot_stale"
      || error.code === "code_map_snapshot_changed"
      ? 409
      : error.code === "code_node_not_found"
        ? 404
        : 400;
    sendJson(response, statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof CodeMapAugmentationError) {
    const statusCode = error.code === "code_map_node_not_found"
      ? 404
      : error.code === "code_map_not_indexed" || error.code === "code_map_manual_relation_stale"
        ? 409
        : 400;
    sendJson(response, statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof CodeScopeBindingError) {
    const statusCode = error.code === "code_map_node_not_found"
      ? 404
      : error.code === "code_map_not_indexed" || error.code === "task_project_mismatch"
        ? 409
        : 400;
    sendJson(response, statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof CodeMapInvestigationSyncError) {
    const statusCode = [
      "code_map_sync_invalid_selection",
      "code_map_sync_raw_node_selection_unsupported",
    ].includes(error.code) ? 400 : 409;
    sendJson(response, statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof CodeProviderLifecycleError) {
    const statusCode = error.code === "code_map_provider_unknown" ? 404 : 409;
    sendJson(response, statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof EntityNotFoundError) {
    sendJson(response, 404, { error: { code: "not_found", message: error.message } });
    return;
  }
  if (error instanceof ClaimConflictError) {
    sendJson(response, 409, { error: { code: "claim_conflict", message: error.message } });
    return;
  }
  if (error instanceof RevisionConflictError) {
    sendJson(response, 409, {
      error: {
        code: "revision_conflict",
        message: error.message,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      },
    });
    return;
  }
  if (error instanceof EntityRevisionConflictError) {
    sendJson(response, 409, {
      error: {
        code: "revision_conflict",
        message: error.message,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      },
    });
    return;
  }
  if (error instanceof ClaimNotFoundError) {
    sendJson(response, 409, { error: { code: "claim_not_found", message: error.message } });
    return;
  }
  if (error instanceof ClaimOwnershipError) {
    sendJson(response, 409, { error: { code: "claim_ownership", message: error.message } });
    return;
  }
  if (error instanceof ClaimGenerationConflictError) {
    sendJson(response, 409, {
      error: {
        code: "claim_changed",
        message: error.message,
        expectedClaimId: error.expectedClaimId,
        actualClaimId: error.actualClaimId,
      },
    });
    return;
  }
  if (error instanceof MutationRequestConflictError) {
    sendJson(response, 409, { error: { code: "request_conflict", message: error.message, requestId: error.requestId } });
    return;
  }
  if (error instanceof TypeError || error instanceof URIError) {
    sendJson(response, 400, { error: { code: "bad_request", message: error.message } });
    return;
  }

  sendJson(response, 500, { error: { code: "internal_error", message: "Internal server error" } });
}