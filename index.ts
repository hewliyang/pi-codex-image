/**
 * pi-codex-image
 *
 * Registers a `generate_image` tool that calls the Codex Responses API with
 * the hosted `image_generation` built-in tool. The outer agent can be any
 * provider (Anthropic, Google, etc.) - this extension just needs an
 * `openai-codex` OAuth credential available in auth.json to authenticate the
 * sub-call.
 *
 * Docs: https://developers.openai.com/api/docs/guides/tools-image-generation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";

const TOOL_NAME = "generate_image";
const CODEX_MODEL = process.env.PI_CODEX_IMAGE_MODEL ?? "gpt-5.5";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const ARTIFACTS_DIR = join(homedir(), ".pi", "agent", "generated-artifacts");

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

const Params = Type.Object({
	prompt: Type.String({
		minLength: 1,
		description:
			"Text description of the image to generate or the edit to apply.",
	}),
	input_image_paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional local image paths (PNG/JPEG/WebP/GIF) to condition on or edit. Relative paths resolve against the cwd. Reuse saved_path from a previous result to iterate.",
		}),
	),
	size: Type.Optional(
		Type.String({
			description:
				"Image dimensions. Use 'auto' (default) or WIDTHxHEIGHT. Popular: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, 2160x3840. Constraints: each edge <=3840px and multiple of 16; aspect ratio <=3:1; total pixels 655,360 to 8,294,400.",
		}),
	),
	quality: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
			],
			{ description: "'auto' (default), 'low', 'medium', or 'high'." },
		),
	),
	background: Type.Optional(
		Type.Union(
			[Type.Literal("auto"), Type.Literal("transparent"), Type.Literal("opaque")],
			{ description: "'auto' (default), 'transparent', or 'opaque'." },
		),
	),
	save_path: Type.Optional(
		Type.String({
			description: `Optional override path to save the resulting PNG. Relative paths resolve against the cwd. Defaults to ${ARTIFACTS_DIR}/<timestamp>.png.`,
		}),
	),
});
type GenParams = Static<typeof Params>;

interface GenDetails {
	revisedPrompt?: string;
	savedPath?: string;
	inputImagePaths?: string[];
	error?: string;
	status?: number;
}

// pi accepts an `isError` flag on tool results at runtime, but the public
// `AgentToolResult<T>` type doesn't declare it. We use a structural superset
// internally and let it widen to `AgentToolResult<GenDetails>` at the
// registerTool boundary.
type GenResult = AgentToolResult<GenDetails> & { isError?: boolean };

export default function piCodexImage(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Generate Image",
		description: `Generate or edit an image from a text prompt using OpenAI's hosted image_generation tool via the Codex (ChatGPT) Responses API. Every result is saved to disk (default: ${ARTIFACTS_DIR}/<timestamp>.png) and also returned inline. Pass input_image_paths to condition on / edit existing images on disk. Available whenever an openai-codex OAuth credential is configured, regardless of which model the calling agent uses.`,
		promptSnippet:
			"Generate or edit an image from a text prompt; can condition on existing image files via input_image_paths. Saves output to ~/.pi/agent/generated-artifacts/.",
		promptGuidelines: [
			"Use generate_image when the user asks you to draw, generate, render, edit, or modify an image.",
			"For generate_image, phrase prompts using verbs like 'draw' or 'edit' for best results.",
			"To edit or condition on prior images with generate_image, pass their paths via input_image_paths. Reuse the saved_path returned by previous generate_image calls to iterate on a generated image.",
			"generate_image internally runs your prompt through a mainline OpenAI model that auto-revises it before image synthesis. Write self-contained, literal, fully-specified prompts (no pronouns referring to prior turns, no implicit context) and inspect revised_prompt in the result. If the revision dropped intent, retry generate_image with a more explicit prompt.",
		],
		parameters: Params,
		execute: (_id, params, signal, onUpdate, ctx) =>
			runGenerateImage(params, ctx, signal, onUpdate),
		renderCall: renderGenerateCall,
		renderResult: renderGenerateResult,
	});

	const sync = () => {
		const hasCodex = AuthStorage.create().hasAuth("openai-codex");
		const active = pi.getActiveTools();
		const present = active.includes(TOOL_NAME);
		if (hasCodex && !present) {
			pi.setActiveTools([...active, TOOL_NAME]);
		} else if (!hasCodex && present) {
			pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
		}
	};

	pi.on("session_start", (_e, ctx) => {
		sync();
		try {
			patchExportTemplate();
		} catch (err) {
			ctx.ui.notify?.(
				`generate_image: failed to patch export template: ${errorMessage(err)}`,
				"warning",
			);
		}
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool body.
// ─────────────────────────────────────────────────────────────────────────────

async function runGenerateImage(
	params: GenParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GenDetails> | undefined,
): Promise<GenResult> {
	if (!params.prompt.trim()) {
		return toolError("prompt must not be empty");
	}

	let token: string;
	let accountId: string;
	try {
		({ token, accountId } = await getCodexAuth());
	} catch (err) {
		return toolError(`Codex auth error: ${errorMessage(err)}`);
	}

	if (params.size) {
		const sizeError = validateImageSize(params.size);
		if (sizeError) return toolError(sizeError);
	}

	const tool: Record<string, unknown> = {
		type: "image_generation",
		output_format: "png",
	};
	if (params.size && params.size !== "auto") tool.size = params.size;
	if (params.quality && params.quality !== "auto") tool.quality = params.quality;
	if (params.background && params.background !== "auto")
		tool.background = params.background;

	const userContent: Array<Record<string, unknown>> = [];
	const resolvedInputPaths: string[] = [];
	for (const raw of params.input_image_paths ?? []) {
		const abs = isAbsolute(raw) ? raw : join(ctx.cwd, raw);
		const ext = extname(abs).toLowerCase();
		const mime = MIME_BY_EXT[ext];
		if (!mime) {
			return toolError(
				`Unsupported input image type for ${abs}. Supported extensions: ${Object.keys(MIME_BY_EXT).join(", ")}`,
			);
		}

		let bytes: Buffer;
		try {
			bytes = readFileSync(abs);
		} catch (err) {
			return toolError(
				`Failed to read input_image_paths entry ${abs}: ${errorMessage(err)}`,
			);
		}
		userContent.push({
			type: "input_image",
			image_url: `data:${mime};base64,${bytes.toString("base64")}`,
		});
		resolvedInputPaths.push(abs);
	}
	userContent.push({ type: "input_text", text: params.prompt });

	const body = {
		model: CODEX_MODEL,
		store: false,
		stream: true,
		instructions:
			"You are an image generation passthrough. Call the image_generation tool exactly once. Copy the user's prompt verbatim into the tool's prompt argument. Do NOT paraphrase, summarize, expand, embellish, or rewrite the prompt in any way. Do not add stylistic descriptors the user did not include. After the tool call, do not produce any additional text.",
		input: [{ type: "message", role: "user", content: userContent }],
		tools: [tool],
		tool_choice: { type: "image_generation" },
	};

	onUpdate?.({
		content: [{ type: "text", text: "Calling Codex image_generation..." }],
		details: {},
	});

	let res: Response;
	try {
		res = await fetch(CODEX_RESPONSES_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
				"OpenAI-Beta": "responses=experimental",
				accept: "text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		return toolError(`Codex Responses API request failed: ${errorMessage(err)}`);
	}

	if (!res.ok || !res.body) {
		const errText = await res.text().catch(() => "");
		return toolError(
			`Codex Responses API error ${res.status} ${res.statusText}: ${errText.slice(0, 800)}`,
			{ status: res.status },
		);
	}

	let stream: ImageStreamResult;
	try {
		stream = await readImageStream(res.body, onUpdate);
	} catch (err) {
		return toolError(`Codex Responses API stream failed: ${errorMessage(err)}`);
	}
	if (stream.error) {
		return toolError(`Codex image_generation failed: ${stream.error}`, {
			error: stream.error,
		});
	}

	const { imageB64, revisedPrompt } = stream;

	if (!imageB64) {
		return {
			content: [
				{
					type: "text",
					text: "Image generation completed but no image data was returned by the Codex backend.",
				},
			],
			isError: true,
			details: {},
		};
	}

	let inlineData = imageB64;
	let inlineMime = "image/png";
	try {
		const resized = await tryResizeForInline(imageB64);
		if (resized) {
			inlineData = resized.data;
			inlineMime = resized.mimeType;
		}
	} catch {
		// fall through with original
	}

	let savedPath: string;
	try {
		if (params.save_path) {
			savedPath = isAbsolute(params.save_path)
				? params.save_path
				: join(ctx.cwd, params.save_path);
		} else {
			mkdirSync(ARTIFACTS_DIR, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const slug = params.prompt
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40);
			savedPath = join(
				ARTIFACTS_DIR,
				slug ? `${stamp}-${slug}.png` : `${stamp}.png`,
			);
		}
		mkdirSync(dirname(savedPath), { recursive: true });
		writeFileSync(savedPath, Buffer.from(imageB64, "base64"));
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `Image generated but failed to save to disk: ${errorMessage(err)}`,
				},
				{ type: "image", data: inlineData, mimeType: inlineMime },
			],
			isError: true,
			details: { revisedPrompt },
		};
	}

	const lines: string[] = [`Generated image saved to: ${savedPath}`];
	if (revisedPrompt) lines.push(`Revised prompt: ${revisedPrompt}`);
	if (resolvedInputPaths.length > 0) {
		lines.push(`Conditioned on: ${resolvedInputPaths.join(", ")}`);
	}
	lines.push(
		"Pass this saved_path back via input_image_paths to iterate on this image.",
	);

	return {
		content: [
			{ type: "text", text: lines.join("\n") },
			{ type: "image", data: inlineData, mimeType: inlineMime },
		],
		details: {
			revisedPrompt,
			savedPath,
			inputImagePaths: resolvedInputPaths,
		},
	};
}

type ImageStreamResult = {
	imageB64?: string;
	revisedPrompt?: string;
	error?: string;
};

async function readImageStream(
	body: ReadableStream<Uint8Array>,
	onUpdate: AgentToolUpdateCallback<GenDetails> | undefined,
): Promise<ImageStreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const result: ImageStreamResult = {};

	while (true) {
		const { value, done } = await reader.read();
		buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

		for (const chunk of drainSseChunks(done ? `${buffer}\n\n` : buffer)) {
			buffer = chunk.rest;
			const event = parseSseData(chunk.data);
			if (!event) continue;

			applyImageEvent(event, result, onUpdate);
			if (result.error || event.type === "response.completed") return result;
		}

		if (done) return result;
	}
}

function* drainSseChunks(
	buffer: string,
): Generator<{ data: string; rest: string }, void, void> {
	let rest = buffer;
	let sep: number;
	while ((sep = rest.indexOf("\n\n")) !== -1) {
		yield { data: rest.slice(0, sep), rest: rest.slice(sep + 2) };
		rest = rest.slice(sep + 2);
	}
}

function parseSseData(chunk: string): Record<string, unknown> | undefined {
	const data = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n");
	if (!data || data === "[DONE]") return undefined;

	try {
		const parsed = JSON.parse(data);
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function applyImageEvent(
	event: Record<string, unknown>,
	result: ImageStreamResult,
	onUpdate: AgentToolUpdateCallback<GenDetails> | undefined,
): void {
	const type = getString(event, "type");
	const item = getRecord(event, "item");

	if (
		type === "response.output_item.added" &&
		getString(item, "type") === "image_generation_call"
	) {
		onUpdate?.({
			content: [{ type: "text", text: "Generating image..." }],
			details: {},
		});
		return;
	}

	if (
		type === "response.output_item.done" &&
		item &&
		getString(item, "type") === "image_generation_call"
	) {
		copyImageFields(item, result);
		return;
	}

	if (type === "response.image_generation_call.completed") {
		copyImageFields(event, result);
		return;
	}

	if (type === "response.completed") {
		const response = getRecord(event, "response");
		const output = response?.output;
		if (!Array.isArray(output)) return;
		for (const entry of output) {
			if (
				entry &&
				typeof entry === "object" &&
				getString(entry as Record<string, unknown>, "type") ===
					"image_generation_call"
			) {
				copyImageFields(entry as Record<string, unknown>, result);
			}
		}
		return;
	}

	if (type === "response.failed" || type === "error") {
		const response = getRecord(event, "response");
		const responseError = response ? getRecord(response, "error") : undefined;
		const eventError = getRecord(event, "error");
		result.error =
			(responseError && getString(responseError, "message")) ??
			(eventError && getString(eventError, "message")) ??
			getString(event, "message") ??
			"unknown error";
	}
}

function copyImageFields(
	source: Record<string, unknown>,
	result: ImageStreamResult,
): void {
	const image = getString(source, "result");
	const revisedPrompt = getString(source, "revised_prompt");
	if (image) result.imageB64 = image;
	if (revisedPrompt) result.revisedPrompt = revisedPrompt;
}

function getRecord(
	source: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	const value = source?.[key];
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function getString(
	source: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = source?.[key];
	return typeof value === "string" ? value : undefined;
}

function validateImageSize(size: string): string | undefined {
	if (size === "auto") return undefined;

	const match = /^(\d+)x(\d+)$/.exec(size);
	if (!match) return "size must be 'auto' or WIDTHxHEIGHT, for example 2048x1152.";

	const width = Number(match[1]);
	const height = Number(match[2]);
	const longEdge = Math.max(width, height);
	const shortEdge = Math.min(width, height);
	const pixels = width * height;

	if (longEdge > 3840) return "size maximum edge length must be <= 3840px.";
	if (width % 16 !== 0 || height % 16 !== 0) {
		return "size width and height must both be multiples of 16px.";
	}
	if (longEdge / shortEdge > 3) {
		return "size long-edge to short-edge ratio must not exceed 3:1.";
	}
	if (pixels < 655_360 || pixels > 8_294_400) {
		return "size total pixels must be between 655,360 and 8,294,400.";
	}

	return undefined;
}

function toolError(message: string, details: GenDetails = {}): GenResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderGenerateCall(args: GenParams, theme: Theme): Component {
	const lines: string[] = [];
	lines.push(
		`${theme.fg("toolTitle", theme.bold("generate_image"))} ${theme.fg("accent", JSON.stringify(args.prompt))}`,
	);
	const opts: string[] = [];
	if (args.size) opts.push(`size=${args.size}`);
	if (args.quality) opts.push(`quality=${args.quality}`);
	if (args.background) opts.push(`background=${args.background}`);
	if (opts.length > 0) lines.push(theme.fg("muted", `  ${opts.join(" · ")}`));
	if (args.input_image_paths && args.input_image_paths.length > 0) {
		lines.push(
			theme.fg("muted", `  edit: ${args.input_image_paths.join(", ")}`),
		);
	}
	if (args.save_path) lines.push(theme.fg("dim", `  → ${args.save_path}`));
	return new Text(lines.join("\n"), 0, 0);
}

function renderGenerateResult(
	result: GenResult,
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	const details = result.details;

	if (isPartial) {
		const progress = result.content.find((c) => c.type === "text");
		const label =
			progress && progress.type === "text" ? progress.text : "generating...";
		return new Text(theme.fg("warning", `… ${label}`), 0, 0);
	}

	if (result.isError) {
		const first = result.content.find((c) => c.type === "text");
		return new Text(
			theme.fg(
				"error",
				first && first.type === "text" ? first.text : "image generation failed",
			),
			0,
			0,
		);
	}

	const lines: string[] = [];
	if (details?.savedPath) {
		lines.push(
			`${theme.fg("success", "✓ saved")} ${theme.fg("accent", details.savedPath)}`,
		);
	} else {
		lines.push(theme.fg("success", "✓ generated"));
	}
	if (expanded && details?.revisedPrompt) {
		lines.push(theme.fg("muted", `  revised: ${details.revisedPrompt}`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth + export-template patch
// ─────────────────────────────────────────────────────────────────────────────

const PATCH_MARKER = "/* PI_GENIMG_IMAGE_PATCH_v1 */";
function patchExportTemplate(): void {
	let pkgIndex: string;
	try {
		const req = createRequire(import.meta.url);
		pkgIndex = req.resolve("@mariozechner/pi-coding-agent");
	} catch {
		return;
	}
	const templatePath = join(
		dirname(pkgIndex),
		"core",
		"export-html",
		"template.js",
	);
	if (!existsSync(templatePath)) return;
	const original = readFileSync(templatePath, "utf-8");
	if (original.includes(PATCH_MARKER)) return;

	const anchor =
		"        html += '</div>';\n        return html;\n      }\n\n      /**\n       * Download the session data as a JSONL file.";
	if (!original.includes(anchor)) return;

	const replacement =
		`        ${PATCH_MARKER}\n` +
		`        if (result && name !== 'read') html += renderResultImages();\n` +
		`        html += '</div>';\n` +
		`        return html;\n` +
		`      }\n` +
		`\n` +
		`      /**\n` +
		`       * Download the session data as a JSONL file.`;

	const patched = original.replace(anchor, replacement);
	if (patched === original) return;
	writeFileSync(templatePath, patched, "utf-8");
}

// Anthropic and other providers cap inline image payloads at 5MB of base64.
// Codex returns full-resolution PNGs that can exceed this. Resize via pi's
// bundled photon-based resizer (same util the read tool uses) before inlining,
// while leaving the full-resolution PNG on disk untouched.
let resizeImageFn:
	| ((
			img: { type: "image"; data: string; mimeType: string },
			options?: Record<string, unknown>,
	  ) => Promise<{ data: string; mimeType: string } | null>)
	| undefined
	| null;

async function loadResizeImage(): Promise<typeof resizeImageFn> {
	if (resizeImageFn !== undefined) return resizeImageFn;
	try {
		const req = createRequire(import.meta.url);
		const pkgIndex = req.resolve("@mariozechner/pi-coding-agent");
		const modPath = join(dirname(pkgIndex), "utils", "image-resize.js");
		if (!existsSync(modPath)) {
			resizeImageFn = null;
			return null;
		}
		const mod = (await import(modPath)) as {
			resizeImage?: NonNullable<typeof resizeImageFn>;
		};
		resizeImageFn = mod.resizeImage ?? null;
	} catch {
		resizeImageFn = null;
	}
	return resizeImageFn;
}

async function tryResizeForInline(
	pngBase64: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Skip work entirely if already comfortably under the 5MB base64 cap.
	if (Buffer.byteLength(pngBase64, "utf-8") < 4.5 * 1024 * 1024) return null;
	const fn = await loadResizeImage();
	if (!fn) return null;
	const result = await fn({
		type: "image",
		data: pngBase64,
		mimeType: "image/png",
	});
	if (!result) return null;
	return { data: result.data, mimeType: result.mimeType };
}

async function getCodexAuth(): Promise<{ token: string; accountId: string }> {
	const storage = AuthStorage.create();
	const token = await storage.getApiKey("openai-codex");
	if (!token) {
		throw new Error(
			"Not logged in to openai-codex. Run /login and pick ChatGPT Plus/Pro (Codex).",
		);
	}
	const cred = storage.get("openai-codex") as
		| { accountId?: string }
		| undefined;
	const accountId = cred?.accountId;
	if (!accountId) {
		throw new Error(
			"openai-codex credential is missing accountId. Re-run /login.",
		);
	}
	return { token, accountId };
}
