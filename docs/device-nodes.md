# Device execution nodes

## Accepted design

harness-dock owns each device's provider discovery, credentials, process/session lifecycle,
execution evidence, prepared files and outputs. A controller (an application or another consumer)
connects through the client SDK and owns business authorization, scheduling and receipts.
Neither the controller nor execution requests choose host executable, environment or auth paths.

A device initiates an authenticated WebSocket connection to its configured independent server. The consumer also connects outward through ServerClient; server holds separate device and application credentials and one controller grant per node.
Plain WebSocket is loopback-only; remote connections require verified TLS. Pairing is
explicit once per device through a node ID and random bearer credential. Inventory is
automatic after pairing, and distinguishes installed software from a successful protocol probe.
One active execution is admitted per device. Discovery/probing runs only while idle.

Device configuration uses `mode: device`, `nodeId`, `token`, `endpoint`, `cwd`, `stateDir`
and optional `caFile` / local provider overrides. Existing single-provider demo configs
remain separate while controllers move to the device protocol.

## Execution contract and failures

Methods are inventory, prepare, execute, getExecution, reconcile, cancel, steer, collect
release and forgetSession. Inputs use opaque run/session identities independent of any business model.
Preparation writes bounded relative skill files to hashed, node-owned directories.
The execution workspace is the directory explicitly selected by the device owner. Skill directories are stable and immutable by session identity and content hash. Outputs are read only from that run's
publication directory; links, hard links, traversal, oversized files and changing files
are rejected. Explicit output publication is not a business receipt.

The node durably records input identity before invoking a provider. The same run ID and
input observes the same execution; conflicting reuse is rejected. Startup changes
unconfirmed running executions to unknown, and never replays them. Unresolved unknown executions block new admission on that device; Codex read-only reconciliation can release that block only after confirmed terminal evidence. Other providers require operator investigation; there is no automatic reset. Cancellation aborts
the provider signal but only upstream terminal evidence confirms cancellation. Codex
reconciliation reads the recorded native turn and never emits a new prompt.

Callbacks use duplex requests carrying run ID, kind and payload. Readiness must be
acknowledged before a prompt. Tool and permission requests cannot survive a lost
connection as implicit approval; callback failure denies permissions. Transport delivery
acknowledgments preserve the existing provider-native tool/approval evidence. A connection
loss never resends prompts, tools or permission decisions. Subsequent connection can
query stored execution state, terminal evidence and paged observations through events.

The node does not introduce World, Actor, task, business action or authorization models.

## Validation

Implementation and validation evidence are recorded separately in docs/validation.md.
Real model calls are not part of compilation or discovery tests.

## Resource lifecycle

The [resource lifecycle design](resource-lifecycle.md) defines bounded transport, idle Provider processes, history retention and cleanup invariants. The implementation includes the independent apps/server and ServerClient; validation status and remaining platform gaps are recorded separately in validation.md.
