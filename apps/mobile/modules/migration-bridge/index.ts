import { requireNativeModule } from "expo-modules-core";

export interface MigrationEnvelope {
	schemaVersion: 1;
	theme: "system" | "light" | "dark";
	activeScanId: string | null;
}

export type MigrationEnvelopeReadResult =
	| { status: "absent" }
	| { status: "invalid" }
	| { status: "valid"; envelope: MigrationEnvelope };

export interface PhotoBrainMigrationBridgeModule {
	readEnvelope(): Promise<MigrationEnvelopeReadResult>;
	initializeEnvelope(
		theme: MigrationEnvelope["theme"],
		activeScanId: string | null,
	): Promise<boolean>;
	setTheme(theme: MigrationEnvelope["theme"]): Promise<boolean>;
	setActiveScanId(activeScanId: string | null): Promise<boolean>;
}

export default requireNativeModule<PhotoBrainMigrationBridgeModule>(
	"PhotoBrainMigrationBridge",
);
