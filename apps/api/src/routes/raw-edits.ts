import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { photoExif } from "../db/schema";
import type { ApiDatabase } from "../services/photo-catalog";
import {
	denoiseAmount,
	RawEditError,
	type RawEngine,
	rawEditSettingsSchema,
	readRawEdit,
	saveRawEdit,
} from "../services/raw-edits";
import { photoIdSchema } from "./v1-schemas";

export function rawEditErrorResponse(error: RawEditError): Response {
	const errors = {
		RAW_RECIPE_UPGRADE_REQUIRED: [
			409,
			"Update the app to edit this Denoise recipe",
		],
		DENOISE_UNAVAILABLE: [
			422,
			"Denoise is unavailable for this renderer or server",
		],
		PHOTO_NOT_FOUND: [404, "Photo not found"],
		NOT_RAW: [422, "Only RAW photos can be edited"],
		RAW_EDIT_CONFLICT: [
			409,
			"This photo was edited elsewhere. Reopen the editor to load the latest adjustments.",
		],
		RAW_TONE_UNSUPPORTED: [
			422,
			"This renderer supports exposure adjustments only",
		],
	} as const;
	const [status, message] = errors[error.code];
	return Response.json(
		{ error: { code: error.code, message } },
		{ status, headers: { "Cache-Control": "no-store" } },
	);
}

export const rawEditBodyLimit = bodyLimit({
	maxSize: 4096,
	onError: (context) => {
		context.header("Cache-Control", "no-store");
		return context.json(
			{
				error: {
					code: "INVALID_REQUEST",
					message: "RAW adjustments exceed 4 KiB",
				},
			},
			413,
		);
	},
});

const saveSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		settings: rawEditSettingsSchema,
	})
	.strict();
export function createRawEditsRouter(
	database: ApiDatabase,
	engine: RawEngine,
	denoiseEnabled = false,
	notifyPreview?: () => Promise<unknown>,
) {
	const router = new Hono();
	const capability = (id: number, actualEngine: RawEngine) => {
		if (!denoiseEnabled || actualEngine !== "adobe") return false;
		const metadata = database
			.select({ model: photoExif.cameraModel })
			.from(photoExif)
			.where(eq(photoExif.photoId, id))
			.get();
		// UI candidate gate only. Rust validates sensor geometry, CFA, levels and exposure.
		return metadata?.model === "X100VI" || metadata?.model === "ILCE-1M2";
	};
	router.use("/photos/:id/raw-edit", rawEditBodyLimit);
	router.on(["GET", "PUT"], "/photos/:id/raw-edit", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success)
			return context.json(
				{ error: { code: "INVALID_REQUEST", message: "Invalid photo ID" } },
				400,
			);
		context.header("Cache-Control", "private, no-store");
		try {
			if (context.req.method === "GET") {
				const edit = readRawEdit(database, id.data, engine);
				return context.json({
					...edit,
					supportsDenoise: capability(id.data, edit.engine),
				});
			}
			const input = saveSchema.safeParse(
				await context.req.json().catch((error: unknown) => {
					if (error instanceof SyntaxError) return null;
					throw error;
				}),
			);
			if (!input.success)
				return context.json(
					{
						error: {
							code: "INVALID_REQUEST",
							message: "Invalid RAW adjustments",
						},
					},
					400,
				);
			const current = readRawEdit(database, id.data, engine);
			if (
				!denoiseEnabled &&
				denoiseAmount(input.data.settings) > 0 &&
				denoiseAmount(input.data.settings) !== denoiseAmount(current.settings)
			)
				throw new RawEditError("DENOISE_UNAVAILABLE");
			const saved = saveRawEdit(
				database,
				id.data,
				input.data.revision,
				input.data.settings,
				engine,
			);
			// The persisted recipe is the durable queue; cron recovers failed dispatch.
			try {
				await notifyPreview?.();
			} catch (error) {
				console.error("RAW preview dispatch failed", error);
			}
			return context.json({
				...saved,
				supportsDenoise: capability(id.data, saved.engine),
			});
		} catch (error) {
			if (error instanceof RawEditError) return rawEditErrorResponse(error);
			throw error;
		}
	});
	return router;
}
