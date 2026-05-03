---
name: "generate-image"
description: "Use the generate_image tool to create or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, hero images, or transparent-background cutouts. Triggers include requests to make a new image from a text description, transform or restyle an existing image, derive variants from references, or produce graphical assets for websites, games, decks, or marketing. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# generate_image skill

Guidance for using the `generate_image` tool. The tool wraps OpenAI's hosted `image_generation` built-in via the user's Codex (ChatGPT Plus/Pro) OAuth credential, so it works regardless of which model the agent itself is running on.

## Tool contract

`generate_image` parameters:

- `prompt` (required) — the literal scene description; passed through verbatim to the image model.
- `input_image_paths` (optional) — list of local image paths to condition on (style references, edit targets, composition references). Use absolute paths or paths returned from a previous `generate_image` call.
- `size` (optional) — `auto` (default), `1024x1024`, `1024x1536`, `1536x1024`, or another size supported by `gpt-image`.
- `quality` (optional) — `auto` (default), `low`, `medium`, `high`.
- `background` (optional) — `auto` (default), `transparent`, `opaque`. Only some sizes/models honor `transparent`.
- `save_path` (optional) — override save location. Default: `~/.pi/agent/generated-artifacts/<timestamp>-<slug>.png`.

Result content includes:

- `saved_path` (absolute) — the PNG on disk.
- `revised_prompt` — the prompt as auto-revised by the mainline model before image synthesis. Use this to detect drift from the user's intent and correct course.

## When to use

- Generate a new image (concept art, product shot, cover, website hero, sprite, texture).
- Generate a new image using one or more reference images for style, composition, or mood.
- Edit an existing image (inpainting, lighting / weather changes, background replacement, object removal, compositing, transparent-background cutouts).
- Produce many assets or variants for one task — issue one `generate_image` call per asset/variant.

## When NOT to use

- The repo already has a vector or code-native source for the visual (SVG, Canvas, Three.js scene). Edit that instead.
- The user wants an icon or logo that should match an established style system. Extend the system rather than re-rolling.
- A simple HTML/CSS layout would do (badges, gradients, simple illustrations).

## Saving and pathing

- Every call saves a PNG. The agent does not have to manage temp paths.
- If the user named a destination, pass it via `save_path`, or generate first and then move/copy the result.
- If the image is meant for the current project, copy or move the final selected image into the workspace before finishing the task.
- Do not overwrite existing project assets unless the user asked. Use sibling versioned filenames (`hero-v2.png`, `item-icon-edited.png`).
- For preview/brainstorming only, the file may stay at the default `~/.pi/agent/generated-artifacts/...` path.

## Iteration via input_image_paths

To refine a previous generation, pass the previous `saved_path` back through `input_image_paths`:

```
generate_image({
  prompt: "Same composition; warm sunset light instead of midday; keep all other elements unchanged.",
  input_image_paths: ["/Users/.../generated-artifacts/2026-...-hero.png"]
})
```

Restate critical invariants every iteration — image models drift quickly under successive edits.

## Prompt structure (quick form)

Use a consistent order: **scene/backdrop → subject → key details → constraints → output intent**. For complex requests use short labeled lines, not one long paragraph.

Specificity policy:

- If the user prompt is already specific, normalize it into a clean spec without adding creative requirements.
- If the prompt is generic, you may add tasteful detail when it materially improves the output.
- Do not add extra characters, props, brand palettes, or story beats that are not implied.
- For photorealism, include the word `photorealistic` plus concrete real-world texture (pores, fabric wear, material grain, imperfect everyday detail).

For text inside the image:

- Put literal text in `"quotes"` or ALL CAPS.
- Specify typography (font style, size, color, placement).
- Spell uncommon words letter-by-letter if accuracy matters.
- Demand verbatim rendering with no extra characters.

For multiple input images:

- Label each by index and role: `Image 1: edit target. Image 2: style reference.`
- For compositing, describe how the images interact: `place the subject from Image 2 into Image 1 with consistent lighting`.

For transparent backgrounds:

- Try `background: "transparent"` first.
- If the model ignores it for your size/subject, fall back to prompting a flat chroma-key (`pure #00ff00 solid background, no shadows, no gradients, no reflections, generous padding, crisp edges, no green inside the subject`) and remove the key in post with the bundled `scripts/remove_chroma_key.py`:

  ```bash
  python <skill-dir>/scripts/remove_chroma_key.py \
    --input <generated.png> \
    --out <final.png> \
    --auto-key border --soft-matte --despill
  ```

  Resolve `<skill-dir>` from the agent's skill load path. Requires Python 3 with `Pillow` installed (`pip install Pillow` or `uv pip install Pillow`).

See `references/prompting.md` for the full prompt-craft reference and `references/sample-prompts.md` for ready-to-adapt recipes.

## Mainline prompt-revision footgun

The hosted `image_generation` tool runs your prompt through a mainline GPT model that auto-rewrites it before image synthesis. The pi tool already instructs the mainline to pass through verbatim, but revision can still happen. Mitigations:

- Write self-contained, literal prompts. Avoid pronouns or references to prior context the mainline cannot see.
- Inspect `revised_prompt` in the result and compare against your intent.
- If the revision drifted, re-run with a tighter, more explicit prompt rather than yelling at the model.

## Iteration discipline

- Start with a clean base prompt; make small single-change edits.
- Re-specify critical constraints on every iteration.
- One targeted follow-up at a time beats wholesale rewrites.
- If three consecutive iterations fail to reach the user's goal, stop and ask — you are probably missing context.
