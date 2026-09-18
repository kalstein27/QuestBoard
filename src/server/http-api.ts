import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  ActivityType,
  ActorRef,
  ArtifactType,
  ProjectStatus,
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
  EntityNotFoundError,
  MutationRequestConflictError,
  RevisionConflictError,
} from "../core/errors.js";
import type {
  CreateArtifactInput,
  CreateProjectInput,
  CreateRelationInput,
  CreateTaskInput,
  QuestBoardService,
  UpdateProjectInput,
  UpdateTaskInput,
} from "../application/quest-board-service.js";

const MAX_BODY_BYTES = 1024 * 1024;
const PROJECT_STATUSES = ["active", "archived"] as const satisfies readonly ProjectStatus[];
const CLIENT_ACTIVITY_TYPES = ["note_added", "agent_handoff"] as const satisfies readonly ActivityType[];

export interface QuestBoardHttpServerOptions {
  webRoot?: string;
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
    sendJson(response, 200, { status: "ok" });
    return;
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

  const investigationMatch = pathname.match(/^\/projects\/([^/]+)\/investigation$/);
  if (investigationMatch && method === "GET") {
    const projectId = decodePathPart(investigationMatch[1]);
    service.getProject(projectId);
    sendJson(response, 200, {
      tasks: service.listTasks({ projectId }),
      artifacts: service.listProjectArtifacts(projectId),
      relations: service.listProjectRelations(projectId),
      positions: service.listBoardPositions(projectId),
    });
    return;
  }

  const positionMatch = pathname.match(/^\/projects\/([^/]+)\/investigation\/positions\/(task|artifact)\/([^/]+)$/);
  if (positionMatch && method === "PUT") {
    const projectId = decodePathPart(positionMatch[1]);
    const entityType = positionMatch[2] as RelationEntityType;
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
        ...optionalEnumProperty(body, "status", TASK_STATUSES),
        ...optionalEnumProperty(body, "priority", TASK_PRIORITIES),
        ...optionalStringArrayProperty(body, "tags"),
      };
      sendJson(response, 201, { task: service.createTask(input, actor, mutationOptions(request)) });
      return;
    }
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

  const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === "GET") {
    sendJson(response, 200, { artifact: service.getArtifact(decodePathPart(artifactMatch[1])) });
    return;
  }

  const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodePathPart(taskMatch[1]);
    if (method === "GET") {
      sendJson(response, 200, { task: service.getTask(taskId) });
      return;
    }
    if (method === "PATCH") {
      const actor = requireActor(request);
      const body = await readJsonObject(request);
      const input: UpdateTaskInput = {
        ...optionalPositiveIntegerProperty(body, "expectedRevision"),
        ...optionalStringProperty(body, "title"),
        ...optionalStringProperty(body, "description"),
        ...optionalEnumProperty(body, "status", TASK_STATUSES),
        ...optionalEnumProperty(body, "priority", TASK_PRIORITIES),
        ...optionalStringArrayProperty(body, "tags"),
      };
      sendJson(response, 200, { task: service.updateTask(taskId, input, actor, mutationOptions(request)) });
      return;
    }
  }

  const taskActionMatch = pathname.match(/^\/tasks\/([^/]+)\/(claim|release|activity)$/);
  if (taskActionMatch) {
    const taskId = decodePathPart(taskActionMatch[1]);
    const action = taskActionMatch[2];

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

function sendError(response: ServerResponse, error: unknown): void {
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