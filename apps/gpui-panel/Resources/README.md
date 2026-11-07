# Harness artwork

All Harness marks must have a transparent canvas, without an app tile, shadow or baked-in background. Prefer SVG. The shared `provider_logo` component applies the same size, inset, rounded surface, border; it preserves the original colors within the artwork to every mark. Adding a Harness only adds its asset mapping; never add per-Harness background rules.

The compact tray uses the same `provider_mark` artwork without a surrounding tile; main-window lists and details retain the shared framed component.

- `codex.svg`: colored Codex mark from [Lobe Icons](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/codex-color.svg), retrieved 2026-11-05. The white app tile is omitted and the viewBox is cropped to the original gradient mark. Paths and gradient colors are retained. Brand owner: OpenAI.
- `dsh.svg`: blue DeepSeek mark from [Lobe Icons](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/deepseek-color.svg), retrieved 2026-11-05. Brand owner: DeepSeek.

The panel rasterizes both SVGs at the displayed device-pixel size and caches the full-color result for that size. Lobe Icons is MIT licensed; see `LobeIcons-LICENSE.txt`. Do not render brand artwork through monochrome icon masks or override its fill with the UI text color.

These marks identify the connected native products; they do not imply endorsement. Brand rights remain with their owners. All assets are embedded at build time; display requires no network or installation access.
