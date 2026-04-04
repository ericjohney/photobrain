import { useEffect } from "react";
import { Alert, Platform } from "react-native";
import * as Updates from "expo-updates";

export function useOTAUpdates() {
	useEffect(() => {
		if (__DEV__) return;
		if (Platform.OS === "web") return;

		async function checkForUpdate() {
			try {
				const update = await Updates.checkForUpdateAsync();
				if (!update.isAvailable) return;

				const { isNew } = await Updates.fetchUpdateAsync();
				if (!isNew) return;

				Alert.alert(
					"Update Available",
					"A new version of PhotoBrain is ready. Restart now?",
					[
						{ text: "Later", style: "cancel" },
						{
							text: "Restart",
							onPress: () => Updates.reloadAsync(),
						},
					],
				);
			} catch {
				// Silently ignore — OTA should never crash the app
			}
		}

		checkForUpdate();
	}, []);
}
