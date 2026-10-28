# Changelog

## Unreleased — first developer Alpha candidate

No public release or tag has been issued. Workspace package version `0.1.0` is not
evidence of publication. Codex on macOS arm64 is the only supported Provider;
see [support](docs/support.md) and [release gates](docs/releasing.md).

### Included in the candidate

- Independent server/client SDK/device Daemon, paired outbound connections,
  verified remote TLS and separate device/controller credentials.
- Persistent execution identities, duplicate/conflict checks, session-bound native
  interactions, cancellation requests, result queries and file collection.
- Unknown outcomes remain unknown; reconnects do not replay prompts or approvals.
- Installed Codex binary/home reuse through fixed ACPX/Codex ACP adapters.
  Bounded concurrent sessions, local installation, upgrade and rollback support.
- Self-contained runtime bundles and an offline-installable controller archive.
- ZCode integration removed; existing Lobi/DeepSeek implementations retained as
  unsupported source. Dependencies updated to address the advisories recorded on
  2026-10-27.
- MIT project license, retained third-party notices, deterministic CI, contribution
  and vulnerability-reporting guidance.

### Acceptance limits

2026-10-27 local records cover macOS arm64 builds/tests, offline distribution and
the named real Codex chain. They do not establish a fresh-machine install,
cross-platform Provider support, all desktop/plugin functions, unattended recovery
or long-running stability. CI configuration is not a completed GitHub CI run.
