# Agent / AI working agreements

## After every code or project change

1. **Bump the version revision (patch)**  
   Keep these files in sync (same semver, e.g. `1.1.x` → increment `x`):
   - `manifest.json` → `version`
   - `package.json` → `version`
   - `versions.json` → add one line mapping the new version to `minAppVersion` (same as the latest entry unless `manifest.json`’s `minAppVersion` changed).

2. **Commit to local git**  
   Stage all related changes and create a commit with a short, accurate message (what changed and why).

3. **Build when needed**  
   If TypeScript or bundled `main.js` is part of the change, run `npm run build` before committing so `main.js` matches `main.ts`.

Pure documentation-only edits should still bump the patch version and commit, so release artifacts and history stay aligned.
