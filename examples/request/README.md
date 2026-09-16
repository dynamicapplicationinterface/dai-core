# Request

One person writes a set of questions and sends a link. The person who opens it
answers in their browser. Nothing to install, no account, and nobody holds a
session on a server: the request and its answers live in the two copies, and
travel between them sealed.

Each side can only write its own part:

| Table         | Written by                 | Declared as      |
| ------------- | -------------------------- | ---------------- |
| `requests`    | the person who sends it    | `author=creator` |
| `questions`   | the person who sends it    | `author=creator` |
| `answers`     | the person who answers     | `author=joiner`  |
| `submissions` | the person who answers     | `author=joiner`  |

That is held in two places, not one. The write surface refuses a copy that
tries to write the other side's table, with `ROLE_NOT_PERMITTED` naming the
table and which party tried. And a row that reaches a copy some other way — a
copy with the check removed, a hand-built batch — is stored but never admitted
to the `_current` views, so it never shows and never buries a legitimate row.
The page hiding the controls is a courtesy on top of both, not the guard.

One rule in this example is **not** enforced that way. Once the request has
been opened, the page stops offering to add or remove questions, so a question
never changes under an answer. That lock is only the page not showing the
controls. The writer's copy can still write the `questions` table, and nothing
refuses it. The roles are a guarantee; the lock is a convention this page
follows. If it ever has to hold, it needs a rule the runtime enforces, not a
hidden button.

## What waits on you

The application tells the host which requests wait on this person, so the
home-screen icon can show a number when something arrives while the app is
closed. The rule:

- **Answering:** the request is open and at least one question has no answer.
- **Writing:** answers were sent back that you have not had on screen since.
  Having the request showing counts as seeing them; that is remembered on this
  device only.

Nothing else makes a request wait. A closed request does not, and neither does
a question added or an answer edited after it was sent back. The report is sent
whole every time the page redraws.

Between opens the icon's number is a hint, not a count to rely on: the host adds
requests whose mailbox moved since the last report, and a move that is not one
of the above raises it too. Opening the app resets it.

The reasoning for each table is in `schema.sql`; the application is `app.js`.
