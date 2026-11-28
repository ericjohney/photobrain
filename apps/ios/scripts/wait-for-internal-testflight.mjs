import { setTimeout as delay } from "node:timers/promises";
import { createAppStoreConnectToken } from "./allocate-app-store-build.mjs";

const { ASC_APP_ID, ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, BUILD_NUMBER } = process.env;
async function get(path, query = {}) {
	const url = new URL(path, "https://api.appstoreconnect.apple.com");
	url.search = new URLSearchParams(query);
	const token = createAppStoreConnectToken({
		keyId: ASC_KEY_ID,
		issuerId: ASC_ISSUER_ID,
		privateKey: ASC_PRIVATE_KEY,
	});
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) throw new Error(`App Store Connect returned HTTP ${response.status} for ${path}`);
	return response.json();
}

const deadline = Date.now() + 60 * 60 * 1000;
while (Date.now() < deadline) {
	let state, internal, groups;
	try {
		const builds = await get("/v1/builds", {
			"filter[app]": ASC_APP_ID,
			"filter[version]": BUILD_NUMBER,
			include: "buildBetaDetail,betaGroups",
		});
		const build = builds.data[0];
		state = build?.attributes.processingState;
		internal = builds.included?.find(x => x.type === "buildBetaDetails")?.attributes.internalBuildState;
		if (state === "VALID" && internal === "IN_BETA_TESTING") {
			groups = builds.included.filter(group => group.type === "betaGroups" && group.attributes.isInternalGroup);
			if (!groups.length) {
				const available = await get(`/v1/apps/${ASC_APP_ID}/betaGroups`, { limit: "200" });
				groups = available.data.filter(group => group.attributes.isInternalGroup && group.attributes.hasAccessToAllBuilds);
			}
		}
	} catch (error) {
		console.log(error.message);
	}
	console.log(`Build ${BUILD_NUMBER}: ${state ?? "awaiting Apple"} / ${internal ?? "pending"}`);
	if (groups?.length) {
		console.log(`Available in internal TestFlight: ${groups.map(group => group.attributes.name).join(", ")}`);
		process.exit(0);
	}
	if (["FAILED", "INVALID"].includes(state) || ["EXPIRED", "PROCESSING_EXCEPTION", "MISSING_EXPORT_COMPLIANCE"].includes(internal)) {
		throw new Error(`Build requires attention: ${state} / ${internal}`);
	}
	await delay(30000);
}
throw new Error("Timed out waiting for internal TestFlight availability");
