# CrystalFront RTS — LLM Coding Guide

> For Qwen3.6 27B — keep prompts concise; this model drifts on long context.

## 1. Don't Copy-Paste — Extract After 2nd Use
You copy-pasted the same 40-line match-state builder into 4 places. After the 2nd copy, stop and extract a function. This single change cut 120 lines and prevented future drift bugs.

## 2. Types Live in `shared/` Only
Never re-define a type in `server/` or `client/` that already exists in `shared/`. Every time you duplicate, they diverge (e.g., `attackCooldown` existed server-side but not in shared). The server has internal types with `Map`/`Set` — those are fine to keep separate from the wire types.

## 3. Test Against Real Constants, Not Guessed Values
Your tests asserted `viewportWidth === 600` but the actual config had `960`. Always read the source constant before writing the assertion. When in doubt, run the test immediately after writing it.

## 4. Always Run Tests Before Committing
4 tests were returning false negatives due to stale assumptions (contested node positions, WS_EVENT enum completeness). If you'd run `tsx tests/index.ts` you'd have caught them. Add this to your pre-commit habit.

## 5. Production Code Has No `console.log`
You left ~30 debug logs in the server and client. Before tagging a release, grep for `console.log` and remove them — or gate behind `if (process.env.DEBUG)`.

## 6. Every Feature Needs Its Inverse
When you add a feature, immediately ask: "what stops this? what cleans this up?"
- Added matches → needed cleanup timer (ended matches leaked memory)
- Added WebSocket server → needed ping/pong keep-alive
- Added command processing → needed rate limiting
- Added supply depots → needed maxSupply subtraction on destruction

## 7. Build Verification Checklist (Before Every Commit)
```
□ tsc --noEmit         (zero errors)
□ vitest run           (all pass)
□ tsx tests/index.ts   (all pass, exit code 0)
□ npm run build        (clean build)
```

## 8. Express Version: Pin to `^4.21.0`
You used Express 5 which is still unstable. For server-authoritative game servers, stability matters more than new features.

## 9. Server Index Pattern
- New handler? Add a `case CLIENT_MSG.X:` block
- Broadcasting match state? Use `buildMatchStatePayload(match)` — never inline
- Match → lobby lookup? Use `matchLobbyMap.get(matchId)` — O(1), not O(n) scan
- New game command? Add to the command rate limiter's allowed list

## 10. Short Prompt Pattern That Works
```
Task: [one sentence]
Context: file paths, existing function to reuse
Rules:
- Don't duplicate types (check shared/src/types.ts first)
- Extract helper if used 2+ times
- Test assertion values must match actual constants
- No console.log in final code
- Run tests after changes
```
