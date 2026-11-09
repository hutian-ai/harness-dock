# Third-party software

harness-dock's own code is licensed under MIT. Dependencies and upstream code
included in patches retain their original licenses; the project license does not
replace them. Native Codex login, services and model access have their own terms.

`pnpm bundle` preserves dependency files and generates `THIRD_PARTY_NOTICES.json`
in each runtime directory. The index lists the packages actually present on that
platform, their declared licenses and the relative paths to their license,
copyright and notice files. The controller archive includes the same index and
notices. This inventory records distribution contents; it is not a vulnerability
scan or a claim that a package's declared license covers every possible use.

## Patched dependencies

| Package | Version | License | Changes |
| --- | --- | --- | --- |
| acpx | 0.21.1 | MIT | [Patch and upgrade boundaries](patches/README.md) |
| @agentclientprotocol/codex-acp | 2.3.0 | Apache-2.0 | [Patch and upgrade boundaries](patches/README.md) |
| @openclaw/fs-safe | 0.26.13 | MIT | [Windows long-path fix](patches/README.md#windows-长路径) |

The daemon distribution includes the original patch files in `patches/` and a
copy of their explanation. The patches identify modified upstream files. Preserve
these notices and the upstream license files when redistributing modified builds.

## Licenses supplied by parent packages or upstream

- `isarray@1.0.0` includes its MIT text and copyright in `README.md`.
- The platform-specific `@esbuild/*` packages use the matching `esbuild`
  package's `LICENSE.md`.
- The platform-specific `@openclaw/fs-safe-*` packages use the matching
  `@openclaw/fs-safe` package's MIT `LICENSE`.
- The `@openai/codex@0.164.0` wrapper and its platform package omit standalone
  license files from their npm archives. The daemon therefore includes the
  original [LICENSE](https://github.com/openai/codex/blob/rust-v0.164.0/LICENSE)
  and [NOTICE](https://github.com/openai/codex/blob/rust-v0.164.0/NOTICE) under
  `third-party/openai-codex/`. The upstream NOTICE identifies Ratatui-derived code;
  its MIT notice is included there as well. Sources and hashes are recorded beside
  these files. Changing that dependency version requires reviewing this supplement.

Packages offering `(MIT OR GPL-3.0-or-later)` are used under their MIT option.
Combined license expressions such as `(MIT AND Zlib)` retain both sets of terms.
The original files remain the authoritative license texts.

## GPUI desktop frontend

The macOS v0.1.3 client uses GPUI Kit 0.9.0 and its locked Rust dependency
closure. `Contents/Resources/rust-licenses/inventory.json` records the packages,
declared licenses, source-archive URLs and included notices for the target
platform. Unmodified source for a dependency is available at its exact crates.io
archive URL. Keep these notices and source references with redistributed builds.

Some crates omit standalone license files from their published packages.
`third-party/rust-notices/sources.json` records supplemental upstream files,
revisions and SHA-256 digests. For packages whose upstream also omits these texts,
the original package manifest, available README and author declarations are
retained with the applicable license text. The packaging step verifies these
files and refuses a missing notice supplement rather than shipping an empty
notice entry. Review this supplement when updating Cargo.lock.

The Codex and DeepSeek identification artwork retains the Lobe Icons MIT notice
and brand attribution in `apps/gpui-panel/Resources/README.md`. The artwork does
not imply endorsement or transfer brand rights.
