# Neynar username lookup issue (`joshisdead.eth`)

## Summary
- Neynar API lookups for `joshisdead.eth` return no user (fid/score is `null`), while Neynar Explorer shows the user with score ≈0.99 (`https://explorer.neynar.com/joshisdead.eth?tab=users`).
- Code path uses official endpoints (`by-username`, `search`) and a suffix-stripper (`.eth`, `.base`, `.lens`, `.btc`, `.sol`). Still no hit.
- Other inputs (e.g., FID=123) return scores, so API key/requests are working.

## Repro (local)
```
NEYNAR_API_KEY=<from .env.local> npm run test:neynar-score joshisdead.eth
```
Output:
```
username=joshisdead.eth fid=unknown score=null
```

Direct call (same result):
```
node --import tsx/esm -e "import { getNeynarScoreByUsername } from './src/clients/neynar.js'; (async()=>{console.log(await getNeynarScoreByUsername('joshisdead.eth'));})();"
```

## What the client does
Order of attempts in `getNeynarScoreByUsername`:
1) Try `by-username` (`v2/farcaster/user/by-username`, fallback `v1/user/by-username`) with the provided handle (trim/@strip, lowercased).
2) If missing, try `search` (`v2/farcaster/user/search?q=<query>&limit=25`) and pick an exact username match (case-insensitive) or first result.
3) If still missing, strip known suffixes (`.eth`, `.base`, `.lens`, `.btc`, `.sol`) and repeat steps 1–2.
4) If a FID is found without a score, fetch bulk by FID to read `user.score`/`experimental.neynar_user_score`.

All of these return empty for `joshisdead.eth`; other FIDs work.

## Observations / hypotheses
- Farcaster fnames typically do not allow dots; `joshisdead.eth` may be ENS/display, not an actual fname. Explorer likely searches ENS/display metadata, while the API `by-username/search` filters to real fnames.
- If the actual fname is different (e.g., `joshisdead`), API would return a result; the Explorer UI masks this difference.
- Neynar might expose ENS search via a different endpoint (not `by-username`/`search`), e.g., an identity/resolve endpoint that maps ENS → fid.
- Earlier a transient DNS issue occurred (`EAI_AGAIN api.neynar.com`); reruns succeed for other inputs, so connectivity is fine now.

## Next steps to resolve
1) Confirm the actual fname/FID from Explorer (copy FID from the user page) and query by FID:  
   `npm run test:neynar-score <FID>` — should return the score.
2) If ENS → fid resolution is needed, add an ENS/custody-address lookup flow (Neynar has address lookup endpoints); Explorer likely uses that.
3) If API should return ENS matches on `/search`, check with Neynar support or docs for ENS-aware search endpoint; current endpoints ignore the dot-handle.
