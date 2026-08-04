# Slack app setup

WorkLog AI uses **per-user Slack OAuth**: each teammate signs in from the extension and
the backend stores *their own* user token. A user token is required because
`search.messages` only works with user tokens, and because the "finish work" reply
should appear as **you**.

Two token scopes matter and one flow. You configure the app once; teammates just click
**Sign in with Slack**.

> Your workspace may require an admin to approve the app. Loop them in early.

## 1. Create the app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it `WorkLog AI`, pick your workspace, **Create App**.

## 2. Add User Token scopes

**OAuth & Permissions → Scopes → User Token Scopes** (NOT Bot Token Scopes). Add:

- `search:read` — find your "before you start work" post across channels.
- `chat:write` — post the "finish work" reply as you.
- `users:read` — resolve your own identity.

## 3. Add the redirect URL

Sign-in runs in a normal browser tab and Slack redirects back to the **backend**, so the
redirect URL is your backend's public address:

```
<PUBLIC_URL>/auth/slack/callback
```

1. Set `PUBLIC_URL` in `backend/.env` to a URL the browser can reach (ngrok while
   developing, your real host once deployed). It must match `BACKEND_URL` in
   `extension/src/config.js`.
2. In the Slack app: **OAuth & Permissions → Redirect URLs → Add** that exact URL →
   **Save URLs**.

The extension's **Options → Admin setup** shows the exact string to paste. Note this URL
changes whenever `PUBLIC_URL` does — a new ngrok domain means re-registering it.

## 4. Copy the app credentials

From **Basic Information → App Credentials**:

- **Client ID** → set `SLACK_CLIENT_ID` in `extension/src/config.js` (it ships with the
  build, so teammates never type it).
- **Client Secret** → put into `backend/.env` as `SLACK_CLIENT_SECRET` (with `SLACK_CLIENT_ID`).
  The secret belongs **only** to the backend, never the extension.

## 5. Set the marker phrase

In `backend/.env`, set `START_MARKER` to the exact phrase your morning post contains,
e.g. `before you start work`. The backend searches for `from:me on:<today> "<marker>"`.

## 6. Sign in & test

1. Start the backend (`npm start` in `backend/`).
2. In the extension **Options**, click **Sign in with Slack**, approve the scopes.
3. You should see "Signed in as … ✓".
4. Open a Timebins tab (or any tab) and click the extension icon → the modal loads your
   morning post. If you posted today, you'll see parsed items; if not, `No "<marker>" post found`.

## Notes & gotchas

- **Sign-in is required.** There is no shared or fallback token: a request without a
  valid session is rejected with a 401. This is deliberate — a fallback token would
  silently post *someone else's* update under the app owner's name.

- **Search indexing lag:** `search.messages` can take a few seconds to see a brand-new
  message. Only matters while testing.
- **Visibility:** search only returns messages *you* can see. Exactly what we want.
- **Per teammate:** everyone signs in with their own account; nobody posts as anyone else.
- **AI is optional:** none of the above involves AI. Leave `AI_ENABLED=false` and everything
  works. Set it to `true` + add `ANTHROPIC_API_KEY` only for cleaner parsing/analysis.
