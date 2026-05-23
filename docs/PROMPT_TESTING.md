# Esma prompt testing (production_v2)

After changing the Esma prompt, validate before leaving it live.

## 1. Export recent threads

- **UI:** `/prompt-lab` → Export → bot **esma**, min messages **4**, limit **50** → Download JSON
- **CLI:** `npm run export:conversations -- --bot=esma --limit=50 --minMessages=4`

Pick ~10 threads where replies felt robotic (echo pattern, too many emojis, no link when he asked for more).

## 2. A/B in Prompt Lab

1. Open `/prompt-lab/test?botId=esma&subscriberId=SUBSCRIBER_ID`
2. **Prompt A:** `bot:esma` (current production_v2)
3. **Prompt B:** `variant:production` (old prompt) or a draft you edited
4. Mode: **Next reply only** first; then **Replay full conversation** on 2–3 bad threads

Check that v2:

- Does not mirror his exact sexual phrases back
- Varies message length (not always two lines + emoji)
- Uses emojis rarely
- Mentions private link only when he asks for more / pics (phase 3)

## 3. CLI quick check

```bash
npm run test:prompt -- --variant=production_v2
npm run test:prompt -- --variant=production
```

## 4. Promote (optional)

If using Redis draft override: `/prompt-lab` → promote draft.  
Production file already points to `production_v2` in `prompts/esma.js` after deploy.

## Env vars (Esma)

| Variable | Purpose |
|----------|---------|
| `EXCLU_ESMA_LINK` | Link text in DMs when he asks where to go |
| `ESMA_CONTENT_DESCRIPTION` | What she sells (injected into prompt) |
| `ESMA_EXCLUSIVE_LINK` | Redirect target after `/r/...` click tracking |
