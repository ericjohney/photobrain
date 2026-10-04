import { test as base, expect } from "@playwright/test";
import {
	type HandlerOverrides,
	installTrpcHandlers,
	type TrpcCallLog,
} from "./handlers";
import type { FixturePhoto } from "./photos";

/** Replaces the default handlers; resolves to the per-procedure input log. */
export type MockBackend = (
	overrides?: HandlerOverrides,
	/** Another fixture library than FIXTURE_PHOTOS. */
	photos?: readonly FixturePhoto[],
) => Promise<TrpcCallLog>;

type Fixtures = { mockBackend: MockBackend };

export const test = base.extend<Fixtures>({
	mockBackend: async ({ page }, use) => {
		let installed = false;
		const fn = async (
			overrides: HandlerOverrides = {},
			photos?: readonly FixturePhoto[],
		) => {
			if (installed) throw new Error("mockBackend called twice");
			await page.unrouteAll();
			installed = true;
			return installTrpcHandlers(page, overrides, photos);
		};
		await use(fn);
	},
	page: async ({ page }, use) => {
		await installTrpcHandlers(page);
		await use(page);
	},
});

export { expect };
