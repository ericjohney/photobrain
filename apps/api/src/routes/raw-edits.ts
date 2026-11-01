import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ApiDatabase } from "../services/photo-catalog";
import {
	RawEditError,
	type RawEngine,
	rawEditSettingsSchema,
	readRawEdit,
	saveRawEdit,
} from "../services/raw-edits";
import { photoIdSchema } from "./v1-schemas";

export function rawEditErrorResponse(error: RawEditError): Response {
	const errors = {
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
export function createRawEditsRouter(database: ApiDatabase, engine: RawEngine) {
	const router = new Hono();
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
			if (context.req.method === "GET")
				return context.json(readRawEdit(database, id.data, engine));
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
			return context.json(
				saveRawEdit(
					database,
					id.data,
					input.data.revision,
					input.data.settings,
					engine,
				),
			);
		} catch (error) {
			if (error instanceof RawEditError) return rawEditErrorResponse(error);
			throw error;
		}
	});
	return router;
}
