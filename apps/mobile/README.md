# PhotoBrain Mobile

React Native Expo mobile app for PhotoBrain - AI-powered photo management.

## Features

- 📱 Native iOS and Android support
- 🔍 Semantic photo search using CLIP embeddings
- 🖼️ Fast photo grid with optimized image loading
- 🔄 Pull-to-refresh and directory scanning
- 📸 Full-screen photo viewer with metadata
- 🎨 Native UI components and smooth animations

## Prerequisites

- [Bun](https://bun.sh/) installed
- [Expo CLI](https://docs.expo.dev/get-started/installation/) installed globally
- [Expo Go](https://expo.dev/client) app on your mobile device (for testing)
- PhotoBrain API server running (default: http://localhost:3000)

## Setup

1. Install dependencies:

```bash
bun install
```

2. Configure API URL:

Copy `.env.example` to `.env` and update the API URL:

```bash
cp .env.example .env
```

For **iOS Simulator**: Use `http://localhost:3000`
For **Android Emulator**: Use `http://10.0.2.2:3000`
For **Physical Device**: Use `http://<your-computer-ip>:3000`

## Development

### Start Expo development server:

```bash
bun run start
```

### Run on iOS:

```bash
bun run ios
```

### Run on Android:

```bash
bun run android
```

### Run on Web:

```bash
bun run web
```

## Shared Code

This mobile app shares code with the web app through workspace packages:

- `@photobrain/api-client` - API client and TypeScript type definitions
- `@photobrain/utils` - Shared utility functions (formatFileSize, formatDate, etc.)

## Project Structure

```
apps/mobile/
├── src/
│   ├── components/       # Reusable UI components
│   │   ├── PhotoGrid.tsx
│   │   ├── SearchBar.tsx
│   │   └── PhotoModal.tsx
│   ├── screens/          # Main app screens
│   │   ├── DashboardScreen.tsx
│   │   ├── CollectionsScreen.tsx
│   │   ├── PreferencesScreen.tsx
│   │   └── AboutScreen.tsx
│   └── config.ts         # App configuration
├── App.tsx               # Main app entry point
├── app.json              # Expo configuration
└── package.json
```

## Technology Stack

- **React Native** - Cross-platform mobile framework
- **Expo** - React Native development platform
- **React Navigation** - Navigation library
- **expo-image** - Optimized image component
- **TypeScript** - Type safety

## Screens

### Dashboard

- Photo grid with responsive layout (3 columns)
- Semantic search bar with debounced input
- Pull-to-refresh functionality
- Scan button for triggering directory scans
- Tap photos to view in full-screen

### Collections

- Placeholder for future collections feature

### Preferences

- Placeholder for app settings and preferences

### About

- App version and information
- Technology stack details
- Feature list

## API Integration

The mobile app connects to the PhotoBrain backend API and supports:

- `GET /api/photos` - Fetch all photos
- `GET /api/photos/search?q=query` - Semantic search
- `GET /api/photos/:id/file` - Fetch photo file
- `POST /api/scan` - Trigger directory scan

## Troubleshooting

### Cannot connect to API

1. Ensure the backend API is running on port 3000
2. Check your `.env` file has the correct API URL
3. For physical devices, ensure your phone and computer are on the same network
4. For Android emulator, use `http://10.0.2.2:3000` instead of `localhost`

### Images not loading

1. Verify API URL is correct
2. Check network permissions in Expo
3. Ensure photos exist in the backend database

## Building for Production

### iOS

```bash
eas build --platform ios
```

### Android

```bash
eas build --platform android
```

Refer to [Expo's build documentation](https://docs.expo.dev/build/introduction/) for detailed instructions.
