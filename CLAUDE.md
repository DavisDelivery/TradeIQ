# CLAUDE.md — working agreements for this repo

## Response format (standing rule)

Always reply to the user in a **single self-contained "wrapped container"**
they can copy-paste straight to the orchestrator. No prose outside the
container.

- Open with `=== <TITLE> ===` and close the block so it reads as one
  pasteable unit.
- Lead with the outcome/status, then step-by-step results, then any
  deviations/findings, then follow-ups and what's needed from the
  orchestrator.
- Keep artifacts explicit and copyable: snapshot IDs, deploy IDs, PR
  numbers, env-var names, endpoints, status codes.
- Flag any deviation from the brief's stated premise up front.

This applies to every turn, including short acknowledgements and PR/CI
status updates.
