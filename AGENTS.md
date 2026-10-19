# harness-dock

Independent device execution: control plane SDK ↔ device Daemon → provider Driver. Devices connect outward to a paired local or remote controller.

- Product scope is local Agent access infrastructure. Humans use the embedding application or native harness client; local CLI/app entry points serve installation, pairing, permission guidance and diagnostics. Canonical scope, current gaps and deferred work are in docs/standalone-v1.md; do not build a standalone chat/IDE/plugin-management product.

- The independent Daemon discovers Codex, Lobi, DeepSeek and ZCode locally. It supports ZCode through pinned zcode-acp-server and ACPX. Keep its default build permission mode and apply only explicitly selected native modes, disabled bridge Hub, honest final-answer limitations, and real-vs-synthetic evidence boundary described in docs/zcode-driver.md.

- Keep packages private. Use a private repository by default. Do not publish npm packages or upload sibling repositories, credentials, runtime data, or experiment artifacts.
- Use ACP as the default harness protocol with named thin adapters for installation/environment selection, native host dependencies, callbacks and event/session differences. The current Codex backend remains fixed ACPX/Codex ACP; do not add a parallel native fallback. Native tools, MCP, plugins, skills and memory remain harness-owned; do not register each new plugin in a dock-specific tool catalog.
- Harnesses own their internal agents, tool execution and native permission rules. Dock selects and connects the native execution environment, routes required approval requests and decisions, and preserves their lifetime; it does not create a separate desktop authorization mechanism or assume every new process inherits all existing grants. Investigate missing native startup dependencies before proposing adapter changes; a native host rejection is a reported limitation, not a requirement to build a dock permission system.
- Native-environment reuse is the confirmed target. Codex now selects the installed binary/home without rewriting configuration or authentication; caller skills use the named additive skill root. Preserve user configuration and locally selected policy, keep dock state separate, and report missing host dependencies. Codex precise options/questions and the provided desktop host have named Local evidence; installation/runtime/application host discovery and endpoint rediscovery after actual isolated restart are verified; independent LaunchAgent desktop access is rejected by native ancestry policy, and same-thread restart continuation, all plugin functions and ZCode native Browser Use remain unaccepted. See docs/validation.md.
- Keep provider processes and pending approvals owned by the Daemon, not the connection.
- Connection recovery must never automatically resubmit prompts or permission decisions.
- Missing completion evidence is unknown, not success or confirmed cancellation.
- Keep credentials, logs, provider sessions and experiment output under ignored `.local/`.
- Keep real service addresses, deployment inventories, pairing status and personal identifiers in ignored `.local/` records. Use example domains and configurable paths in tracked documentation; secret scans alone do not establish privacy sanitization. Use a repository-scoped maintainer identity without a personal email for Git commits.
- Use TypeScript ESM, explicit relative extensions and type-only imports.
- Use `pnpm check`; keep deterministic tests focused on behavior at control boundaries.
- Record real Provider evidence separately from mocked tests in `docs/validation.md`.
- The independent v1 scope and acceptance criteria are in docs/standalone-v1.md.
- The v1 delivery uses host execution and a local CLI for initialization, start/stop, status and logs.
- Provider execution in Docker/Podman remains deferred; retain its experiments without running them as a v1 gate. Use Docker Compose for the Linux cloud server only; see docs/server-docker.md.
- Local daemon management must address the owning daemon through a protected local socket, never signal a process from a saved PID.
- Remote connections require verified TLS and the configured node identity; plaintext is loopback-only.
- Consumers use the connection SDK only. Provider discovery, processes, local files and credentials belong to the independently running device Daemon. Keep application business types and governance out of this repository. npm publishing remains deferred. Keep cloud credentials and pairing files outside Git.
