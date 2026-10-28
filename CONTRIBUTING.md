# Contributing

harness-dock connects a controller SDK to an independent device Daemon and native
Agent harnesses. Read [scope](docs/standalone-v1.md), [support](docs/support.md) and
[release criteria](docs/releasing.md) before proposing a change. The only currently
supported Provider is Codex on macOS arm64. Retained Lobi/DeepSeek implementations
are unsupported; historical experiments do not expand this support commitment.

## Development

Use Node.js 22.19+ and pnpm 12.15.0. Install pnpm with
`npm install --global pnpm@12.15.0`, then run:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` builds the workspace, checks scripts/tests and runs deterministic
boundary tests. Do not run concurrent workspace builds: injected workspace
dependencies can be replaced during a build. Real Provider checks require local
login and model access, run separately, and are recorded in `docs/validation.md`.
Never add Provider credentials to CI. Offline distribution checks are:

```sh
pnpm bundle .local/bundles/contribution
node --import tsx scripts/accept-bundle.ts .local/bundles/contribution --offline
```

Choose a new bundle destination for each run. For code style, use TypeScript ESM,
explicit relative extensions and type-only imports. Keep tests focused on
observable behavior at control boundaries. Document protocol changes, capabilities,
failure semantics and evidence limits in the same pull request.

## Boundaries to preserve

- The Daemon owns Provider processes and pending approvals, independently of a
  connection. Reconnection never resubmits prompts, tools or permission decisions.
- Missing completion evidence stays unknown. Cancel requests alone do not prove
  cancellation. Resume failure does not create a replacement session.
- Harnesses own their tools, plugins, skills, memory and native permissions. Dock
  selects the environment and routes required native interactions.
- Keep credentials, logs, sessions, local service addresses, personal identifiers
  and experimental output in ignored `.local/`. Use example domains in docs.
- Keep packages private. npm publishing and changes to repository visibility are
  separate maintainer actions. Do not include sibling repositories in releases.

## Reports and pull requests

For ordinary bugs, include the revision, OS/architecture, Node/pnpm versions,
sanitized reproduction and expected/actual behavior. Distinguish installation,
protocol readiness, actual model execution and native-tool behavior. Do not attach
complete logs, pairing files, authentication or personal conversation content.
Use [SECURITY.md](SECURITY.md) for vulnerabilities.

Keep changes narrow. Explain the user-visible result, validation and remaining
limits. Contribute only code you have permission to license under this project's
MIT license; retain applicable third-party notices. Configure a repository-scoped
maintainer identity without a personal email before committing. No CLA or external
signing service is required.
