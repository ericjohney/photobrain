import Constants from "expo-constants";

// Default to localhost for development
// For iOS simulator: http://localhost:3000
// For Android emulator: http://10.0.2.2:3000
// For physical device: http://<your-ip>:3000
export const API_URL =
	Constants.expoConfig?.extra?.apiUrl ||
	process.env.EXPO_PUBLIC_API_URL ||
	"http://localhost:3000";
