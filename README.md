# pi-codex-image

A [pi](https://github.com/badlogic/pi-mono) extension exposing OpenAI's hosted `image_generation` tool to any model, authenticated via the `openai-codex` (ChatGPT Plus/Pro) OAuth credential.

## Install

```bash
pi install npm:@hewliyang/pi-codex-image
```

You must be logged in via Codex OAuth:

```bash
pi /login   # pick "ChatGPT Plus/Pro (Codex)"
```

## Contents

- **`generate_image` tool** — agent-callable image generation/editing. Args: `prompt`, `input_image_paths`, `size`, `quality`, `background`, `save_path`.
- **`/imggen` slash command** — user-initiated generation: `/imggen <prompt>`, `/imggen edit`, `/imggen redo`, `/imggen help`.
- **`generate-image` skill** — teaches the agent when/how to call the tool, with prompt recipes and a chroma-key removal script.

## License

MIT
