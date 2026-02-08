# Login flow user stories (fufnotes)

This doc describes how the **login flow** and the **login view** are intended to work.

For post-login note actions (create/edit/search/export/conflicts), see: [notes-view-user-stories.md](notes-view-user-stories.md)

## User stories

- As a new user without an account, I can enter my email and press **Log in**, and the app will create my account on first successful sign-in.
- As an existing user, I can enter my email and press **Log in** to start a new sign-in session.
- As a user, I can complete sign-in either by clicking the emailed magic link **or** by copy/pasting the emailed sign-in code.
- As a user, if I request multiple emails, only the newest email/code should be expected to work (one-time/expiring codes).
- As a user, if I see a “recently sent” cooldown message, I can still finish sign-in using the most recent email.

## Login view behavior

### Initial state

- Shows:
  - Email input
  - Primary button labeled **Log in**
  - A note: “If you don’t have an account yet, entering your email will create one.”
- Hides:
  - Code input (not shown until after email submit)

### After the user clicks “Log in” with an email

- The email input is replaced with a clear status line:
  - “Logging in as <email>”
- The code field becomes visible.
- The primary button changes to: **Submit code from email**
- A note explains that clicking the magic link is equally correct.

### When the user clicks “Log in” with an email

- The app calls `POST /auth/passhroom/start`.
- While the request is in flight:
  - Button disables and shows “Sending…”
  - The UI shows a short “something is happening” indicator
- After the request succeeds:
  - The UI transitions to the code stage (see above)

### When the user clicks “Log in” with a code

- The user pastes the code and clicks **Submit code from email**.
- The app calls `POST /auth/passhroom/code`.
- On success:
  - The app obtains its normal httpOnly session cookie and loads the notes UI.

### Error handling

- If starting sign-in fails (network/502/etc), keep the button enabled and show an error.
- If code exchange fails (invalid/expired code), keep the code box visible and show an error so the user can paste again.
