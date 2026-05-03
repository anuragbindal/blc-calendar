# BLC-Calendar

A frontend-only Google Calendar viewer/editor.

- Sign in with Google.
- See your calendars in **Day**, **3 Day**, **Month**, and **Agenda** views.
- Toggle individual calendars on and off (sidebar).
- Drag-drop, resize, click-to-edit, and create-by-drag work, with every change
  pushed straight to Google Calendar via the official API.
- No backend, no database. Tokens live in memory only — closing the tab signs
  you out fully.

## Setup

You need a Google OAuth Client ID before the app will run. Client IDs for
browser apps are not secret (they're sent to the browser anyway); the security
boundary is the *Authorized JavaScript origins* list on the OAuth client.

### 1. Create the Google Cloud project

1. Open <https://console.cloud.google.com/> and create a project (or pick one).
2. **APIs & Services → Library** → search for *Google Calendar API* → enable.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Fill in the required app fields (name, support email).
   - Scopes: you don't need to add any here — the app requests them at runtime.
   - **Test users**: add your own Google account while the app is in *Testing*
     mode. (You can publish later for unrestricted use.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: add every URL where the app will run.
     Examples:
     - `http://localhost:8080` (for local testing)
     - `https://yourname.github.io` (GitHub Pages root)
     - `https://your-custom-domain.example`
     Note: the path is ignored — only scheme + host + port count.
   - You do **not** need an authorized redirect URI for this app (it uses the
     token model, not the redirect flow).
5. Copy the resulting **Client ID** (looks like
   `1234567890-abcdef.apps.googleusercontent.com`).

### 2. Configure the app

Edit `config.js` and replace the placeholder:

```js
window.APP_CONFIG = {
  CLIENT_ID: "1234567890-abcdef.apps.googleusercontent.com",
};
```

### 3. Run locally

From the project directory:

```sh
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

### 4. Deploy

Any static host works. The simplest options:

- **GitHub Pages**: push the repo, enable Pages on the main branch. The
  resulting URL must be in your OAuth client's *Authorized JavaScript origins*.
- **Netlify / Vercel / Cloudflare Pages**: drag-and-drop or connect the repo;
  add the deployed URL to the OAuth origins list.

## Notes & limits

- **Access tokens last about 1 hour.** When one expires, the app silently
  re-acquires a new one in the background. There is no refresh token (this is
  by design for browser-only OAuth flows). Closing the tab signs you out fully.
- **Recurring events**: drag/edit/delete affects the single instance you act
  on, not the whole series. A full recurrence-rule editor is not in v1.
- **Read-only calendars** (e.g. holidays, subscribed calendars where you have
  reader access) show events but disable drag/edit/delete.
- **Event count cap**: each calendar fetch loads up to 2500 events per
  calendar per visible window — fine for normal use, but extremely busy month
  views on a single calendar could hit it. Pagination is not implemented in v1.
- **Time zone**: events are created in your browser's current time zone.
  Existing events keep whatever time zone they were created with on Google.
