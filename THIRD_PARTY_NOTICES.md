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
| acpx | 0.19.4 | MIT | [Patch and upgrade boundaries](patches/README.md) |
| @agentclientprotocol/codex-acp | 2.1.1 | Apache-2.0 | [Patch and upgrade boundaries](patches/README.md) |

The daemon distribution includes the original patch files in `patches/` and a
copy of their explanation. The patches identify modified upstream files. Preserve
these notices and the upstream license files when redistributing modified builds.

## Licenses supplied by parent packages or upstream

- `isarray@1.0.0` includes its MIT text and copyright in `README.md`.
- The platform-specific `@esbuild/*` packages use the matching `esbuild`
  package's `LICENSE.md`.
- The platform-specific `@openclaw/fs-safe-*` packages use the matching
  `@openclaw/fs-safe` package's MIT `LICENSE`.
- The `@openai/codex@0.159.3` wrapper and its platform package omit standalone
  license files from their npm archives. The daemon therefore includes the
  original [LICENSE](https://github.com/openai/codex/blob/rust-v0.159.3/LICENSE)
  and [NOTICE](https://github.com/openai/codex/blob/rust-v0.159.3/NOTICE) under
  `third-party/openai-codex/`. The upstream NOTICE identifies Ratatui-derived code;
  its MIT notice is included there as well. Sources and hashes are recorded beside
  these files. Changing that dependency version requires reviewing this supplement.

Packages offering `(MIT OR GPL-3.0-or-later)` are used under their MIT option.
Combined license expressions such as `(MIT AND Zlib)` retain both sets of terms.
The original files remain the authoritative license texts.
