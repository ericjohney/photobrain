#!/usr/bin/env node

import { createPrivateKey, sign as signBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const APP_STORE_CONNECT_ORIGIN = "https://api.appstoreconnect.apple.com";
const BUILDS_PATH = "/v1/builds";
const TOKEN_LIFETIME_SECONDS = 20 * 60;
const MAX_PAGES = 10_000;

function fail(message) {
	throw new Error(message);
}

function encodeBase64URL(value) {
	return Buffer.from(value).toString("base64url");
}

function normalizePrivateKey(value) {
	const trimmed = value.trim();
	return trimmed.includes("\\n") && !trimmed.includes("\n")
		? trimmed.replaceAll("\\n", "\n")
		: trimmed;
}

export function createAppStoreConnectToken({
	keyId,
	issuerId,
	privateKey,
	nowSeconds = Math.floor(Date.now() / 1_000),
}) {
	if (!keyId || !issuerId || !privateKey) {
		fail("App Store Connect JWT inputs must be non-empty");
	}
	if (!/^[A-Z0-9]{10}$/.test(keyId)) {
		fail("ASC_KEY_ID must be a 10-character alphanumeric key ID");
	}
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			issuerId,
		)
	) {
		fail("ASC_ISSUER_ID must be a UUID");
	}
	if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
		fail("JWT clock must be a positive integer");
	}

	let key;
	try {
		key = createPrivateKey(normalizePrivateKey(privateKey));
	} catch {
		fail("ASC_PRIVATE_KEY is not a valid private key");
	}
	if (key.type !== "private" || key.asymmetricKeyType !== "ec") {
		fail("ASC_PRIVATE_KEY must be an EC private key");
	}
	if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
		fail("ASC_PRIVATE_KEY must use the P-256 curve");
	}

	const header = encodeBase64URL(
		JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }),
	);
	const payload = encodeBase64URL(
		JSON.stringify({
			iss: issuerId,
			iat: nowSeconds,
			exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
			aud: "appstoreconnect-v1",
		}),
	);
	const signingInput = `${header}.${payload}`;
	const signature = signBytes("sha256", Buffer.from(signingInput), {
		key,
		dsaEncoding: "ieee-p1363",
	}).toString("base64url");
	return `${signingInput}.${signature}`;
}

function buildsURL(appId) {
	const url = new URL(BUILDS_PATH, APP_STORE_CONNECT_ORIGIN);
	url.searchParams.set("filter[app]", appId);
	url.searchParams.set("fields[builds]", "version");
	url.searchParams.set("limit", "200");
	return url;
}

function validatedPageURL(value, appId) {
	let url;
	try {
		url = new URL(value, APP_STORE_CONNECT_ORIGIN);
	} catch {
		fail("App Store Connect returned a malformed pagination URL");
	}
	if (
		url.origin !== APP_STORE_CONNECT_ORIGIN ||
		url.pathname !== BUILDS_PATH ||
		url.username ||
		url.password ||
		url.searchParams.get("filter[app]") !== appId
	) {
		fail("App Store Connect returned an unsafe pagination URL");
	}
	return url;
}

async function readPage(response) {
	if (!response || typeof response.ok !== "boolean") {
		fail("App Store Connect returned an invalid HTTP response");
	}
	if (!response.ok) {
		fail(
			`App Store Connect builds request failed with HTTP ${response.status}`,
		);
	}

	let page;
	try {
		page = JSON.parse(await response.text());
	} catch {
		fail("App Store Connect returned malformed JSON");
	}
	if (
		!page ||
		typeof page !== "object" ||
		Array.isArray(page) ||
		!Array.isArray(page.data) ||
		!page.links ||
		typeof page.links !== "object" ||
		Array.isArray(page.links) ||
		!page.meta ||
		typeof page.meta !== "object" ||
		Array.isArray(page.meta) ||
		!page.meta.paging ||
		typeof page.meta.paging !== "object" ||
		Array.isArray(page.meta.paging) ||
		!Number.isSafeInteger(page.meta.paging.total) ||
		page.meta.paging.total < 0 ||
		!Number.isSafeInteger(page.meta.paging.limit) ||
		page.meta.paging.limit <= 0 ||
		page.data.length > page.meta.paging.limit
	) {
		fail("App Store Connect returned a malformed builds page");
	}
	return page;
}

function buildNumber(build) {
	if (
		!build ||
		typeof build !== "object" ||
		Array.isArray(build) ||
		build.type !== "builds" ||
		typeof build.id !== "string" ||
		build.id.length === 0 ||
		!build.attributes ||
		typeof build.attributes !== "object" ||
		Array.isArray(build.attributes)
	) {
		fail("App Store Connect returned a malformed build record");
	}

	const version = build.attributes.version;
	if (typeof version !== "string" || !/^[1-9]\d*$/.test(version)) {
		fail("App Store Connect returned a nonnumeric build version");
	}
	const value = Number(version);
	if (!Number.isSafeInteger(value)) {
		fail("App Store Connect returned an out-of-range build version");
	}
	return value;
}

export async function allocateAppStoreBuild({
	appId,
	token,
	buildNumberFloor = 1,
	fetchImpl = globalThis.fetch,
}) {
	if (!/^\d+$/.test(appId ?? "")) {
		fail("ASC_APP_ID must be a numeric App Store Connect application ID");
	}
	if (!token || typeof fetchImpl !== "function") {
		fail("App Store Connect allocator inputs are incomplete");
	}
	if (!Number.isSafeInteger(buildNumberFloor) || buildNumberFloor <= 0) {
		fail("BUILD_NUMBER_FLOOR must be a positive safe integer");
	}

	let nextURL = buildsURL(appId);
	let maximum = 0;
	let pages = 0;
	let expectedTotal;
	let recordCount = 0;
	const visitedURLs = new Set();
	const visitedBuilds = new Set();

	while (nextURL) {
		if (pages++ >= MAX_PAGES) {
			fail("App Store Connect pagination exceeded the safety limit");
		}
		const requestURL = nextURL.href;
		if (visitedURLs.has(requestURL)) {
			fail("App Store Connect returned a pagination cycle");
		}
		visitedURLs.add(requestURL);

		let response;
		try {
			response = await fetchImpl(requestURL, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
				redirect: "error",
			});
		} catch {
			fail("App Store Connect builds request failed");
		}

		const page = await readPage(response);
		const pageTotal = page.meta.paging.total;
		if (expectedTotal === undefined) {
			expectedTotal = pageTotal;
		} else if (pageTotal !== expectedTotal) {
			fail("App Store Connect build total changed during pagination");
		}
		for (const build of page.data) {
			const value = buildNumber(build);
			if (visitedBuilds.has(build.id)) {
				fail("App Store Connect returned a duplicate build record");
			}
			visitedBuilds.add(build.id);
			recordCount += 1;
			maximum = Math.max(maximum, value);
		}
		if (recordCount > expectedTotal) {
			fail("App Store Connect returned more builds than its pagination total");
		}

		if (page.links.next === undefined || page.links.next === null) {
			nextURL = null;
		} else if (
			typeof page.links.next === "string" &&
			page.links.next.length > 0
		) {
			nextURL = validatedPageURL(page.links.next, appId);
		} else {
			fail("App Store Connect returned malformed pagination state");
		}
	}
	if (recordCount !== expectedTotal) {
		fail("App Store Connect pagination ended before every build was read");
	}
	if (maximum === Number.MAX_SAFE_INTEGER) {
		fail("App Store Connect build version cannot be incremented safely");
	}
	return Math.max(maximum + 1, buildNumberFloor);
}

function requiredEnvironment(environment, name) {
	const value = environment[name];
	if (typeof value !== "string" || value.trim().length === 0) {
		fail(`${name} is required`);
	}
	return name === "ASC_PRIVATE_KEY" ? value : value.trim();
}

function buildNumberFloor(environment) {
	const value = environment.BUILD_NUMBER_FLOOR;
	if (value === undefined) {
		return 1;
	}
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value.trim())) {
		fail("BUILD_NUMBER_FLOOR must be a canonical positive integer");
	}
	const floor = Number(value.trim());
	if (!Number.isSafeInteger(floor)) {
		fail("BUILD_NUMBER_FLOOR must be a safe integer");
	}
	return floor;
}

export async function main({
	environment = process.env,
	fetchImpl = globalThis.fetch,
	nowSeconds,
} = {}) {
	const appId = requiredEnvironment(environment, "ASC_APP_ID");
	const floor = buildNumberFloor(environment);
	const token = createAppStoreConnectToken({
		keyId: requiredEnvironment(environment, "ASC_KEY_ID"),
		issuerId: requiredEnvironment(environment, "ASC_ISSUER_ID"),
		privateKey: requiredEnvironment(environment, "ASC_PRIVATE_KEY"),
		nowSeconds,
	});
	const number = await allocateAppStoreBuild({
		appId,
		token,
		buildNumberFloor: floor,
		fetchImpl,
	});
	process.stdout.write(`${number}\n`);

	if (environment.GITHUB_OUTPUT) {
		await appendFile(environment.GITHUB_OUTPUT, `build_number=${number}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
	return number;
}

const invokedPath = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: undefined;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		process.stderr.write(`Build allocation failed: ${error.message}\n`);
		process.exitCode = 1;
	});
}
