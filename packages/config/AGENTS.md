# Shared Configuration Agent Guide

Scope: `packages/config`.

This package contains the shared TypeScript configuration package. It currently exports only `./tsconfig.json` and has no runtime code or scripts.

Use it as a dev dependency when an app or package needs the repository's shared TypeScript base configuration. Keep application-specific compiler settings in the app's own `tsconfig.json`, especially for Expo/Metro path and entrypoint behavior.

There are no package-local tests, build tasks, or typecheck tasks. Changes to this package can affect every consumer, so run the relevant app/package validation and `bun run ci:check` after editing it.
