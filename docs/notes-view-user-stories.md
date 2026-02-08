# Notes view user stories

These cover what a user can do in the notes UI **after sign-in**.

For sign-in steps and the lock screen behavior, see: [login-flow-user-stories.md](login-flow-user-stories.md)

## Notes list / navigation

- As a user, I can see a list of my notes with title, last-updated time, and revision.
- As a user, I can search/filter notes by title text (and by note id).
- As a user, I can open a note from the list to edit it.
- As a user, I can refresh to re-fetch the list and the current note from the server.
- As a mobile user, I can pull-to-refresh (when at the top of the page and not interacting with an input).
- As a user, I can log out, which ends my session on this device.

## Create

- As a user, I can create a new note explicitly with the “New” button.
- As a user, I can start typing a title/content before creating a note; saving will create it automatically.

## Edit / save

- As a user, I can edit a note’s title.
- As a user, I can edit a note’s markdown content.
- As a user, my changes autosave shortly after I stop typing.
- As a user, my changes save when I leave a field (blur).
- As a user, I can click “Save” to save immediately.
- As a user, I can indent/outdent selected lines using Tab / Shift+Tab.

## Preview

- As a user, I can toggle between Edit and Preview (on smaller screens).
- As a user on large screens, I can view preview alongside the editor (preview is forced on).

## Insert / export

- As a user, I can insert an image markdown link by providing an `http://` or `https://` image URL and optional alt text.
- As a user, I can export the current note’s markdown to a local `.md` file.

## Delete

- As a user, I can delete the current note (with a confirmation prompt).

## Conflict handling

- As a user, if the note changes on the server while I’m editing, I can resolve the conflict by:
  - using the server version,
  - overwriting with my version, or
  - saving my version as a new copy.
