import assert from "node:assert/strict";
import test from "node:test";
import { ensurePreviewBuild } from "./ensure-preview-build.mjs";

const runtimeVersion = "a".repeat(40);
const projectId = "5fcc4958-f697-46c6-9cfc-cd2ce0ac695c";
const appIdentifier = "com.photobrain.app";
const now = Date.parse("2026-09-18T12:00:00Z");
const target = { runtimeVersion, projectId, appIdentifier };
const build = (overrides = {}) => ({
	id: "11111111-1111-4111-8111-111111111111",
	status: "FINISHED",
	platform: "IOS",
	app: { id: projectId },
	appIdentifier,
	buildProfile: "preview",
	distribution: "INTERNAL",
	isForIosSimulator: false,
	updateChannel: { name: "preview" },
	runtime: { version: runtimeVersion },
	fingerprint: { hash: "b".repeat(40) },
	artifacts: { buildUrl: "https://expo.dev/artifacts/eas/preview.ipa" },
	expirationDate: "2026-10-18T12:00:00Z",
	...overrides,
});

// A local EAS boundary: no CLI invocation, credentials, or remote writes.
function service({
	pages = [[]],
	views = [build()],
	created = build({
		status: "IN_QUEUE",
		artifacts: {},
		expirationDate: undefined,
	}),
	listError,
} = {}) {
	let starts = 0;
	let clock = now;
	let viewIndex = 0;
	return {
		get starts() {
			return starts;
		},
		options: {
			...target,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			runEas: async ([command, ...args]) => {
				if (command === "build:list") {
					if (listError) throw listError;
					const page = Number(args[args.indexOf("--offset") + 1]) / 50;
					return page < pages.length ? pages[page] : [];
				}
				if (command === "build") {
					starts++;
					return [created];
				}
				if (command === "build:view") {
					return views[Math.min(viewIndex++, views.length - 1)];
				}
				throw new Error("Unexpected EAS operation");
			},
		},
	};
}

test("JS-only releases reuse the runtime even when the EAS source fingerprint differs", async () => {
	const eas = service({ pages: [[build()]] });
	const result = await ensurePreviewBuild(eas.options);
	assert.equal(result.action, "Reused");
	assert.equal(eas.starts, 0);
});

test("finished builds remain reusable when EAS omits a null expiration date", async () => {
	const finished = build({ expirationDate: undefined });
	const eas = service({ pages: [[finished]], views: [finished] });
	assert.equal((await ensurePreviewBuild(eas.options)).action, "Reused");
	assert.equal(eas.starts, 0);
});

test("a matching source fingerprint does not make a different runtime compatible", async () => {
	const eas = service({
		pages: [
			[
				build({
					runtime: { version: "c".repeat(40) },
					fingerprint: { hash: runtimeVersion },
				}),
			],
		],
	});
	const result = await ensurePreviewBuild(eas.options);
	assert.equal(result.action, "Built");
	assert.equal(eas.starts, 1);
});

test("unusable finished, expired, canceled, and incompatible binaries require a new build", async () => {
	const eas = service({
		pages: [
			[
				build({ status: "ERRORED" }),
				build({ status: "CANCELED" }),
				build({ status: "PENDING_CANCEL" }),
				build({ expirationDate: new Date(now).toISOString() }),
				build({ artifacts: null }),
				build({ isForIosSimulator: true }),
				build({ distribution: "STORE" }),
				build({ updateChannel: { name: "production" } }),
				build({ buildProfile: "development" }),
				build({ runtime: undefined }),
				build({ updateChannel: undefined }),
			],
		],
	});
	const result = await ensurePreviewBuild(eas.options);
	assert.equal(result.action, "Built");
	assert.equal(eas.starts, 1);
});

test("matching queued builds are awaited instead of duplicated", async () => {
	const eas = service({
		pages: [
			[build({ status: "IN_QUEUE", artifacts: {}, expirationDate: undefined })],
		],
		views: [
			build({
				status: "IN_PROGRESS",
				artifacts: {},
				expirationDate: undefined,
			}),
			build(),
		],
	});
	const result = await ensurePreviewBuild(eas.options);
	assert.equal(result.action, "Awaited existing");
	assert.equal(result.build.status, "FINISHED");
	assert.equal(eas.starts, 0);
});

test("a failed matching pending build stops the release without creating a replacement", async () => {
	const eas = service({
		pages: [[build({ status: "IN_QUEUE", artifacts: null })]],
		views: [build({ status: "ERRORED", artifacts: null })],
	});
	await assert.rejects(ensurePreviewBuild(eas.options), /ended with ERRORED/);
	assert.equal(eas.starts, 0);
});

test("pagination finds an older finished artifact before deciding to build or wait", async () => {
	const eas = service({
		pages: [
			Array.from({ length: 50 }, () =>
				build({ status: "IN_QUEUE", artifacts: null }),
			),
			[build()],
		],
	});
	assert.equal((await ensurePreviewBuild(eas.options)).action, "Reused");
	assert.equal(eas.starts, 0);
});

test("the manual escape hatch rebuilds even when a compatible artifact exists", async () => {
	const eas = service({ pages: [[build()]] });
	assert.equal(
		(await ensurePreviewBuild({ ...eas.options, force: true })).action,
		"Built (manual rebuild)",
	);
	assert.equal(eas.starts, 1);
});

test("query errors and malformed responses fail closed rather than starting builds", async () => {
	for (const setup of [
		{ listError: new Error("Offline") },
		{ pages: [null] },
		{ pages: [[{ id: "unexpected-result" }]] },
		{ pages: [[build({ expirationDate: "not-a-date" })]] },
	]) {
		const eas = service(setup);
		await assert.rejects(ensurePreviewBuild(eas.options));
		assert.equal(eas.starts, 0);
	}
});

test("the final build view must still match the runtime and have an unexpired artifact", async () => {
	for (const invalid of [
		build({ runtime: { version: "d".repeat(40) } }),
		build({ expirationDate: new Date(now).toISOString() }),
		build({ artifacts: null }),
		build({ status: "CANCELED" }),
	]) {
		const eas = service({ views: [invalid] });
		await assert.rejects(ensurePreviewBuild(eas.options));
	}
});

test("a permanently queued build times out without permitting a release", async () => {
	const pending = build({ status: "IN_QUEUE", artifacts: null });
	const eas = service({ pages: [[pending]], views: [pending] });
	await assert.rejects(ensurePreviewBuild(eas.options), /Timed out/);
	assert.equal(eas.starts, 0);
});
