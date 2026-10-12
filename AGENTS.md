# harness-dock

Independent device execution: control plane SDK ↔ device Daemon → provider Driver. Devices connect outward to a paired local or remote controller.

- The independent Daemon discovers Codex, Lobi, DeepSeek and ZCode locally. It supports ZCode through pinned zcode-acp-server and ACPX. Keep its build permission mode, disabled bridge Hub, honest final-answer limitations, and real-vs-synthetic evidence boundary described in docs/zcode-driver.md.

- Keep packages private. Use a private repository by default. Do not publish npm packages or upload sibling repositories, credentials, runtime data, or experiment artifacts.
- Codex uses only the fixed ACPX backend; do not add a native Codex fallback. The Lobi/DeepSeek ACP adapters use the generic drivers module; their governance remains with the embedding caller.
- Keep provider processes and pending approvals owned by the Daemon, not the connection.
- Connection recovery must never automatically resubmit prompts or permission decisions.
- Missing completion evidence is unknown, not success or confirmed cancellation.
- Keep credentials, logs, provider sessions and experiment output under ignored `.local/`.
- Use TypeScript ESM, explicit relative extensions and type-only imports.
- Use `pnpm check`; keep deterministic tests focused on behavior at control boundaries.
- Record real Provider evidence separately from mocked tests in `docs/validation.md`.
- The independent v1 scope and acceptance criteria are in docs/standalone-v1.md.
- The v1 delivery uses host execution and a local CLI for initialization, start/stop, status and logs.
- Docker/Podman is deferred by the user; retain existing experimental code and evidence without running it as a v1 gate.
- Local daemon management must address the owning daemon through a protected local socket, never signal a process from a saved PID.
- Remote connections require verified TLS and the configured node identity; plaintext is loopback-only.
- Consumers use the connection SDK only. Provider discovery, processes, local files and credentials belong to the independently running device Daemon. Keep application business types and governance out of this repository. npm publishing remains deferred. Keep cloud credentials and pairing files outside Git.
