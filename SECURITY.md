# Security policy

## Supported scope

The project is preparing its first developer Alpha; no public stable release or
long-term support branch exists. Security fixes target the current development
candidate and, after publication, the latest Alpha. Supported environments and
unaccepted native capabilities are listed in [support guide](apps/docs-site/README.md#support).

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** entry when available.
Maintainers should enable GitHub private vulnerability reporting and verify that
entry. If it is unavailable, contact a maintainer through an established private
channel; do not include exploit details in a public issue or pull request while
looking for a contact.

Include the affected revision, environment, preconditions, expected/actual
behavior, impact and a minimal synthetic reproduction. Omit real tokens, pairing
files, model credentials, service addresses, private prompts and complete runtime
logs. A report acknowledgment does not imply an accepted fix or a release date;
the project currently offers no response-time SLA or bounty program.

## Trust and operational boundaries

- An authorized controller can request native Agent execution on its paired
  device. This is trusted execution infrastructure, not a sandbox for hostile
  tenants. Provider and OS permissions still determine actual native access.
- Remote transport requires verified TLS and a paired node identity. Plaintext
  transport is restricted to loopback; do not disable certificate validation.
- Device and controller credentials are distinct. Restrict local configuration to
  its owner, keep runtime files under ignored `.local/`, and rotate exposed
  credentials. Removing a file from Git is not credential revocation.
- Daemon administration uses its protected local socket. Saved PIDs are not an
  authorization mechanism. Connection loss never authorizes automatic replay.
- Dependency audits cover known advisories at scan time; a clean scan is not proof
  of security or privacy sanitization. Public release also requires reviewing
  source history and actual artifacts for private operational information.

## Maintainer handling

Confirm the report in an isolated environment, preserve unknown execution state
and native ownership, and coordinate a fix before disclosing sensitive details.
Record affected versions, mitigation and verification in the changelog. Do not
attach reporters' private reproduction materials to a public release.
