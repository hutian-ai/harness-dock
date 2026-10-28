# harness-dock

Cross-machine native Harness access: application SDK ↔ server ↔ independent device Daemon → named Provider Driver. Devices connect outward.

- Product scope is native Harness access and execution infrastructure for applications, Agents and automation. Applications own business interaction, authorization and result acceptance. Canonical architecture and contracts are in docs/architecture.md; supported scope is in docs/support.md. Do not build a chat, IDE or plugin-management product.
- Codex on macOS arm64 is the only supported device/Provider combination. Retained non-Codex discovery and adapters are internal and unsupported; do not expose acceptance commands or installation promises for them.
- Keep packages private. Do not publish npm packages, change repository visibility or upload sibling repositories, credentials, runtime data or experiment artifacts without explicit authorization.
- Use ACP with named thin adapters for installation/environment selection, native dependencies, callbacks and event/session differences. The Codex backend is fixed ACPX/Codex ACP; do not add a parallel native fallback.
- Harnesses own internal agents, tools, MCP, plugins, skills, memory and native permission rules. Dock connects the selected environment, routes required native approval requests/decisions and preserves their ownership and lifetime. Do not add a separate desktop authorization mechanism or per-plugin dock catalog.
- Reuse the selected installed binary/home without rewriting native configuration or authentication. Caller skills use the additive named root. Keep dock state separate. Investigate missing native dependencies before adapter changes; native signature/ancestry rejection is a reported limitation, not a requirement to bypass policy. Do not assume a new process inherits existing grants.
- Keep public wire contracts in protocol/client without importing daemon/drivers or application domain types. Driver adapters create and interpret opaque native recovery context; DeviceHost persists it and applies execution ownership/state rules.
- Keep Provider processes and pending approvals owned by the Daemon, not a connection. Recovery never automatically resubmits prompts, tools or permission decisions. Missing completion evidence is unknown, not success or confirmed cancellation.
- Keep credentials, logs, Provider sessions, real service addresses, inventories, pairing status, personal identifiers and validation output in ignored .local/. Use example domains/configurable paths in tracked docs. Secret scans do not establish privacy sanitization.
- Use a repository-scoped maintainer identity without a personal email for Git commits. Preserve Git history unless the user explicitly authorizes rewriting it.
- Use TypeScript ESM, explicit relative extensions and type-only imports. Run pnpm check; deterministic tests focus on control boundaries. Separate real Provider, offline distribution and deployment evidence as described in docs/validation.md.
- The device runs on its host. Local CLI serves setup, start/stop, status, logs, diagnosis, upgrade and rollback. Provider Docker/Podman stays deferred; retained experiments are not v1 gates. Linux server Docker/Compose is documented in docs/server.md.
- Local daemon management must address the owner through a protected local socket, never signal a process from a saved PID.
- Remote connections require verified TLS and configured node identity; plaintext is loopback-only.
- Consumers use the connection SDK only. Provider discovery, processes, local files and credentials belong to the independently running device Daemon. Keep application business types and governance outside this repository.
