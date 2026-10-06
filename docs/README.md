# QuestBoard Documentation

This directory contains both current product/engineering truth and dated implementation history. Start with the current-truth documents below; dated handoff and acceptance notes are evidence of how the project reached its current state, not a replacement for the canonical docs.

## Start here

- [Product direction](QUESTBOARD-PROJECT-PLAN.ko.md) — continuity-first product identity, goals, non-goals, and UX principles.
- [Foundation / architecture](architecture/FOUNDATION.md) — runtime, dependency direction, persistence, Code Map contracts, and implementation invariants.
- [Agent onboarding](AGENT-ONBOARDING.md) — provider-neutral daemon, MCP/CLI, resume, handoff, and concurrency workflow.
- [Network access](NETWORK-ACCESS.md) — localhost, LAN, Tailnet, and public-Internet exposure guidance.

## Concepts

The current public mental model is:

- **Quest** — canonical durable Task workflow and Resume Capsule state.
- **Flow** — visual Work Groups plus Investigation graph. Flow hierarchy is not canonical Task hierarchy.
- **Code** — bounded source explorer over the provider-neutral raw Code Map.
- **Code identity boundary** — raw `code:node:*` IDs and derived architecture `code-map:node:*` IDs are separate spaces and must not be silently substituted.
- **Agent Follow** — ephemeral process-memory presence for user-visible agent location. It is not Task Activity, a Claim, authorization, or durable history. Manual user interaction remains authoritative.

These concepts should stay aligned with [the product plan](QUESTBOARD-PROJECT-PLAN.ko.md) and [the foundation decisions](architecture/FOUNDATION.md).

## Development and verification

The repository-level [README](../README.md) contains installation, configuration, CLI/MCP basics, verification commands, repository layout, and security notes.

The normal verification entry point is:

```bash
npm run verify
```

For Code Map work, treat provider health, semantic coverage, the raw graph, the optional architecture projection, persistent Task ↔ CodeScope bindings, and manual relation overlays as distinct concerns.

## Historical / handoff documents

Files whose names include a date, `HANDOFF`, acceptance round, experiment, migration, or investigation result may describe an earlier repository/runtime state. They can be valuable evidence, but their branch/HEAD counts, runtime status, open work, and implementation claims may be stale.

When a dated historical document conflicts with a current-truth document or the current working tree, prefer this order:

1. current repository behavior and tests;
2. [Product direction](QUESTBOARD-PROJECT-PLAN.ko.md);
3. [Foundation / architecture](architecture/FOUNDATION.md);
4. [Agent onboarding](AGENT-ONBOARDING.md) and [Network access](NETWORK-ACCESS.md);
5. dated handoff / acceptance / experiment notes.

Do not rewrite, move, or delete an actively edited historical handoff merely to tidy the docs tree. Archive migration should preserve existing dirty work and happen as its own reviewed documentation change.

## License status

QuestBoard currently has **no open-source license**. Public repository visibility does not imply that a standard reuse, modification, or redistribution license has been granted. Licensing is intentionally deferred until the project owner chooses otherwise.
