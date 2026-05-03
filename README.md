# pi-codex-image

A [pi](https://github.com/badlogic/pi-mono) extension that exposes OpenAI's hosted `image_generation` tool to **any** model the user is running, authenticated via the `openai-codex` (ChatGPT Plus/Pro) OAuth credential.

The outer agent can be Claude, Gemini, GLM, whatever — if a `openai-codex` credential is present in `auth.json`, this extension registers a `generate_image` tool that the agent can call. Internally it makes a one-shot Responses API call to `chatgpt.com/backend-api/codex/responses` with the hosted `image_generation` built-in tool, parses the SSE stream, saves the resulting PNG to disk, and returns it inline.

## Install

```bash
pi install npm:pi-codex-image
```

Or try without installing:

```bash
pi -e npm:pi-codex-image
```

You must be logged in to ChatGPT via Codex OAuth:

```bash
pi /login
# pick "ChatGPT Plus/Pro (Codex)"
```

## What it does

- **Registers a `generate_image` tool** with parameters: `prompt` (required), `input_image_paths`, `size`, `quality`, `background`, `save_path`.
- **Registers a `/imggen` slash command** for direct user-initiated generations that bypass the LLM but still appear in conversation history as a synthesized tool call + result. Subcommands:
  - `/imggen <prompt>` — generate from prompt.
  - `/imggen edit [prompt]` — open a single-select picker listing prior `generate_image` results in the current branch (timestamp + truncated prompt). Pick one and an editor opens for the new prompt (or use the inline prompt). The previous output is passed back via `input_image_paths`. (Thumbnails were prototyped but removed: kitty graphics from prior tool results persist on screen across overlay redraws, breaking the picker. Text-only is honest and reliable.)
  - `/imggen redo [new prompt]` — rerun the most recent `generate_image` call in the current branch with the same args (optionally swapping the prompt).
  - `/imggen help` — show subcommand help.
  - First-arg autocomplete for `edit` / `redo` / `help`.
  - During generation, a `○ generating image…` status appears in the footer (key `imggen`).
  - Results land as a custom message (`customType: "imggen-result"`) with a registered renderer, plus `display: true` so the embedded image renders inline. No LLM round-trip is consumed; the next model turn sees the message in context (custom messages participate in `convertToLlm`).
- **Auto-saves every result** to `~/.pi/agent/generated-artifacts/<timestamp>-<slug>.png` (override with `save_path`). Returns the image inline in the tool result and tells the agent the saved path so it can iterate via `input_image_paths`.
- **Path-based image conditioning**: pass `input_image_paths: [...]` to edit or condition the generation on existing images on disk.
- **Custom TUI rendering**: shows the prompt, options, and saved path; collapses to `✓ saved <path>` when done; surfaces `revised_prompt` from the model in the expanded view.
- **Streaming progress** via `onUpdate` (text-only — partial images are not displayed because pi's TUI accumulates them rather than replacing).
- **Auto-(de)activates** based on whether `openai-codex` is configured in `auth.json`. Decoupled from the active model.
- **Patches `/share` and `/export`** to embed `<img>` tags from custom-tool `ImageContent` results. The patch is idempotent and re-applies on each `session_start`. (Today only the built-in `read` tool gets image embedding in HTML export — this generalizes that behavior to all custom tools.)

## Bundled skill

Ships a `generate-image` skill that teaches the agent when and how to use the tool: prompt structure, specificity policy, iteration discipline, transparent-background handling, plus a curated set of copy/paste prompt recipes (see `skills/generate-image/references/`). Adapted from the upstream codex `imagegen` skill, with the codex-only CLI / API / network paths stripped out.

Also bundles `skills/generate-image/scripts/remove_chroma_key.py` — a standalone Pillow-based chroma-key remover for the case where `background: "transparent"` is ignored. Requires `python3` and `Pillow` (`pip install Pillow` or `uv pip install Pillow`).

## Caveats

- **Prompt revision**: the hosted `image_generation` tool runs your prompt through a mainline GPT model that auto-revises it before image synthesis. The extension instructs the mainline to pass through verbatim and surfaces `revised_prompt` in the result text so the agent can correct course. Write self-contained, literal prompts.
- **Codex backend only**: the only image endpoint reachable on the OAuth tier is `image_generation` inside `/codex/responses`. There is no equivalent of `/v1/images/generations` (returns Cloudflare 403).
- **Not multi-turn-stateful**: each `generate_image` call is a fresh sub-call. To iterate, pass the saved PNG back via `input_image_paths`.
- **Gist size limits**: HTML exports with many embedded images can exceed GitHub's gist size limit (~10 MB). `/share` will fail in that case.
- **Modifies `node_modules`**: the `/share` image-embedding patch edits pi's installed `template.js`. A `pi update` will revert it; the extension reapplies on next session start. The patch is gated by a unique marker comment so re-runs are no-ops.

## Repository

<https://github.com/...>  <!-- TODO: fill in -->

## License

MIT
