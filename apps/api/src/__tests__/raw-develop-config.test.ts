import { describe, expect, spyOn, test } from "bun:test";
import { parseConfig } from "../config";

describe("Developed RAW engine configuration", () => {
	test("keeps Apple as the default and accepts explicitly configured Adobe", () => {
		expect(parseConfig({}).RAW_DEVELOP_ENGINE).toBe("apple");
		expect(
			parseConfig({
				RAW_DEVELOP_ENGINE: "adobe",
				ADOBE_PROFILE_DIR: "/camera profiles",
			}),
		).toMatchObject({
			RAW_DEVELOP_ENGINE: "adobe",
			ADOBE_PROFILE_DIR: "/camera profiles",
		});
	});

	test("rejects unknown engines and Adobe without a profile directory at startup", () => {
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const environment of [
				{ RAW_DEVELOP_ENGINE: "typo" },
				{ RAW_DEVELOP_ENGINE: "adobe" },
				{ RAW_DEVELOP_ENGINE: "adobe", ADOBE_PROFILE_DIR: "  " },
			]) {
				expect(() => parseConfig(environment)).toThrow(
					"Invalid environment configuration",
				);
			}
		} finally {
			log.mockRestore();
		}
	});
});
