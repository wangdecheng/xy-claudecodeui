# Repository Guidelines

## Project Structure & Module Organization

This is a Vite + React frontend with an Express/Node backend and optional Electron desktop packaging. The onsite workflow is the primary product area; treat `onsite` components, modules, routes, state, and translations as core paths. Frontend code lives in `src/`, with feature UI under `src/components/`, hooks in `src/hooks/`, contexts in `src/contexts/`, utilities in `src/utils/`, and translations in `src/i18n/locales/`. Backend code lives in `server/`, especially `server/modules/` for feature modules and `server/shared/` for contracts. Cross-runtime shared code belongs in `shared/`. Static assets are in `public/`; Electron files are in `electron/`; Docker and release support live in `docker/` and `scripts/`.

## Build, Test, and Development Commands

- `npm run dev` starts the backend and Vite client together.
- `npm run client` starts only the Vite dev server.
- `npm run server:dev` starts only the backend through `tsx`.
- `npm run build` builds both client (`dist/`) and server (`dist-server/`).
- `npm run typecheck` runs TypeScript checks for frontend and backend configs.
- `npm run lint` checks `src/` and `server/`; use `npm run lint:fix` for autofixes.

## Coding Style & Naming Conventions

Use ES modules, React function components, and TypeScript where existing files do. ESLint enforces grouped imports: built-ins, external packages, internal aliases, parent, sibling, then index imports. Component files use `PascalCase.tsx`; hooks use `useName.ts`; utility and service files use descriptive `kebab-case` or existing module naming. Keep Tailwind classes valid and ordered. Avoid broad cross-module backend imports; respect `server/modules/*` boundaries and shared contract files.

## Testing Guidelines

Tests use Node’s built-in `node:test` with `node:assert/strict`; React rendering tests may use `react-dom/server`. Place backend tests under the relevant `server/**/tests/` directory or beside the unit as `*.test.ts` / `*.test.js`. Frontend regression tests can live beside components as `*.test.tsx`. There is no aggregate `npm test` script currently; run focused tests with `npx tsx --test path/to/file.test.ts` or `node --test path/to/file.test.js`, then run `npm run typecheck` and `npm run lint`.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits via commitlint: `feat: ...`, `fix(scope): ...`, `docs: ...`, `refactor: ...`, and similar types. Keep messages imperative and scoped when helpful, for example `fix(onsite): preserve problem history on reload`. Pull requests should explain what changed and why, link issues, include screenshots for UI changes, and confirm `npm run build`, `npm run typecheck`, and `npm run lint` pass.

## Security & Configuration Tips

Do not commit local credentials, API keys, generated databases, or machine-specific paths. Keep configuration changes documented in `README.md`, `docs/`, or the relevant module README when they affect setup or deployment.
