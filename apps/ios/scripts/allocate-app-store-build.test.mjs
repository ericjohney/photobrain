import assert from "node:assert/strict";
import { createPublicKey, verify as verifyBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	allocateAppStoreBuild,
	createAppStoreConnectToken,
	main,
} from "./allocate-app-store-build.mjs";

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgdBDkOrIJwrgQyabZ
2XSDOWDa+kfAWVRqsjLFXSA8BA+hRANCAAQyyRymEUduQpI+4x6FoIBjUxuiuv0w
WfoBe9SbtqmFQKgkal9L1fBlFCak2t8sEgh17TcckdNVbqALxRsnK0CC
-----END PRIVATE KEY-----`;
const APP_ID = "1234567890";
const FIXED_TIME = 1_800_000_000;

function response(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return JSON.stringify(body);
		},
	};
}

function build(id, version) {
	return {
		type: "builds",
		id,
		attributes: { version },
	};
}

function buildPage(data, next = null, total = data.length) {
	return {
		data,
		links: next === undefined ? {} : { next },
		meta: { paging: { total, limit: 200 } },
	};
}

function fixtureFetch(pages, calls = []) {
	let index = 0;
	return async (url, options) => {
		calls.push({ url, options });
		assert.ok(index < pages.length, `unexpected page request: ${url}`);
		return response(pages[index++]);
	};
}

test("creates a bounded, valid ES256 App Store Connect token", () => {
	const token = createAppStoreConnectToken({
		keyId: "KEY123ABCD",
		issuerId: "00000000-0000-4000-8000-000000000000",
		privateKey: PRIVATE_KEY,
		nowSeconds: FIXED_TIME,
	});
	const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");

	assert.deepEqual(
		JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")),
		{ alg: "ES256", kid: "KEY123ABCD", typ: "JWT" },
	);
	assert.deepEqual(
		JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
		{
			iss: "00000000-0000-4000-8000-000000000000",
			iat: FIXED_TIME,
			exp: FIXED_TIME + 1_200,
			aud: "appstoreconnect-v1",
		},
	);
	assert.equal(Buffer.from(encodedSignature, "base64url").length, 64);
	assert.equal(
		verifyBytes(
			"sha256",
			Buffer.from(`${encodedHeader}.${encodedPayload}`),
			{
				key: createPublicKey(PRIVATE_KEY),
				dsaEncoding: "ieee-p1363",
			},
			Buffer.from(encodedSignature, "base64url"),
		),
		true,
	);
});

test("paginates all build fixtures and allocates one above the maximum", async () => {
	const calls = [];
	const pages = [
		buildPage(
			[build("build-a", "41"), build("build-b", "105")],
			`https://api.appstoreconnect.apple.com/v1/builds?filter%5Bapp%5D=${APP_ID}&cursor=second`,
			4,
		),
		buildPage([build("build-c", "87"), build("build-d", "106")], null, 4),
	];

	const next = await allocateAppStoreBuild({
		appId: APP_ID,
		token: "fixture-token",
		fetchImpl: fixtureFetch(pages, calls),
	});

	assert.equal(next, 107);
	assert.equal(calls.length, 2);
	assert.match(calls[0].url, /filter%5Bapp%5D=1234567890/);
	assert.equal(calls[0].options.redirect, "error");
	assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-token");
});

test("allocates build one when the application has no builds", async () => {
	const next = await allocateAppStoreBuild({
		appId: APP_ID,
		token: "fixture-token",
		fetchImpl: fixtureFetch([buildPage([])]),
	});
	assert.equal(next, 1);
});

test("uses the durable floor when App Store Connect visibility lags", async () => {
	const next = await allocateAppStoreBuild({
		appId: APP_ID,
		token: "fixture-token",
		buildNumberFloor: 1_234_501,
		fetchImpl: fixtureFetch([buildPage([build("visible-build", "106")])]),
	});
	assert.equal(next, 1_234_501);
});

const rejectedFixtures = [
	{
		name: "fractional build version",
		page: buildPage([build("bad", "3.1")]),
		error: /nonnumeric build version/,
	},
	{
		name: "numeric build stored as a number",
		page: buildPage([build("bad", 12)]),
		error: /nonnumeric build version/,
	},
	{
		name: "empty pagination URL",
		page: buildPage([build("bad", "12")], ""),
		error: /malformed pagination state/,
	},
	{
		name: "foreign pagination origin",
		page: buildPage(
			[build("bad", "12")],
			`https://example.com/v1/builds?filter%5Bapp%5D=${APP_ID}`,
		),
		error: /unsafe pagination URL/,
	},
	{
		name: "pagination for another application",
		page: buildPage(
			[build("bad", "12")],
			"https://api.appstoreconnect.apple.com/v1/builds?filter%5Bapp%5D=999",
		),
		error: /unsafe pagination URL/,
	},
	{
		name: "pagination ending before the declared total",
		page: buildPage([build("bad", "12")], null, 2),
		error: /ended before every build was read/,
	},
];

for (const fixture of rejectedFixtures) {
	test(`fails closed for ${fixture.name}`, async () => {
		await assert.rejects(
			allocateAppStoreBuild({
				appId: APP_ID,
				token: "fixture-token",
				fetchImpl: fixtureFetch([fixture.page]),
			}),
			fixture.error,
		);
	});
}

test("main writes the allocated build to stdout and GITHUB_OUTPUT", async () => {
	const directory = await mkdtemp(join(tmpdir(), "allocator-test-"));
	const output = join(directory, "github-output");
	let stdout = "";
	const originalWrite = process.stdout.write;
	process.stdout.write = (value) => {
		stdout += value;
		return true;
	};

	try {
		const number = await main({
			environment: {
				ASC_KEY_ID: "KEY123ABCD",
				ASC_ISSUER_ID: "00000000-0000-4000-8000-000000000000",
				ASC_PRIVATE_KEY: PRIVATE_KEY.replaceAll("\n", "\\n"),
				ASC_APP_ID: APP_ID,
				BUILD_NUMBER_FLOOR: "1234501",
				GITHUB_OUTPUT: output,
			},
			fetchImpl: fixtureFetch([buildPage([build("existing", "9")])]),
			nowSeconds: FIXED_TIME,
		});

		assert.equal(number, 1_234_501);
		assert.equal(stdout, "1234501\n");
		assert.equal(await readFile(output, "utf8"), "build_number=1234501\n");
	} finally {
		process.stdout.write = originalWrite;
		await rm(directory, { recursive: true, force: true });
	}
});
