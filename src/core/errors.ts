export class EntityNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "EntityNotFoundError";
  }
}

export class ClaimConflictError extends Error {
  constructor(taskId: string, agentId: string) {
    super(`Task ${taskId} is already claimed by ${agentId}`);
    this.name = "ClaimConflictError";
  }
}

export class ClaimNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} has no active claim`);
    this.name = "ClaimNotFoundError";
  }
}

export class ClaimOwnershipError extends Error {
  constructor(taskId: string, ownerAgentId: string, actorAgentId: string) {
    super(`Task ${taskId} is claimed by ${ownerAgentId}, not ${actorAgentId}`);
    this.name = "ClaimOwnershipError";
  }
}

export class ClaimGenerationConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedClaimId: string,
    readonly actualClaimId: string,
  ) {
    super(`Task ${taskId} claim changed before release`);
    this.name = "ClaimGenerationConflictError";
  }
}

export class MutationRequestConflictError extends Error {
  constructor(readonly requestId: string) {
    super(`Mutation requestId ${requestId} was already used for different input`);
    this.name = "MutationRequestConflictError";
  }
}

export class RevisionConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Task ${taskId} revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = "RevisionConflictError";
  }
}