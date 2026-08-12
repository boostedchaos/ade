# Argus rebrand — build prompt

Paste the block below into a fresh session started in
`/Users/kylewelch/Documents/PROJECTS/ADE Windows 11/source`.

---

Build the Argus rebrand and design refresh of this app.

The contract is `docs/specs/argus-rebrand/SPEC.md`. Read it first, in full,
before touching anything. It records five rulings on gaps in the design brief
and two decisions Kyle has already made — those are settled; do not re-open
them.

The design record of record is `docs/design/argus/DESIGN-BRIEF.md` plus the 2×
screenshots in `docs/design/argus/screenshots/`. The brief is authoritative for
what things should look like; the SPEC is authoritative for what we decided and
how we ship. Where they disagree, the SPEC wins — it was written after auditing
the brief against this tree.

How to run it:

- Work on a new branch `argus-rebrand` off `main`. Push to remote `boosted`,
  never `origin`.
- Eight phases, in the order the SPEC gives them. **Commit at every phase
  boundary and post a one-line progress note** — Kyle may stop you at any
  moment and a stop must be cheap.
- Keep `docs/specs/argus-rebrand/PROGRESS.md` current as you go: current phase,
  open items, anything you deferred and why. Create it in phase 1.
- Read the "Traps recorded from prior builds" section before your first build or
  test run. They have each cost real time in this repo.

When you finish, write `docs/specs/argus-rebrand/BUILD-REPORT.md` with evidence
for all six ship gates, a screen-by-screen visual comparison checklist, and an
honest list of anything you did not do and why.

Do not publish a release and do not merge to `main`. Both are Kyle's call.

---

## Notes for whoever kicks this off

- Expect the build to want several sessions. The SPEC's `PROGRESS.md`
  convention is the resume path — a fresh session should be able to read
  `SPEC.md` + `PROGRESS.md` and continue without re-deriving anything.
- Phase 1 alone (`ink.ts` + `daylight.ts` + the `globals.css` fallback block) is
  small and delivers most of the visual change. It is a reasonable place to stop
  and look before committing to the rest.
- Phase 8 is the irreversible-feeling one: it changes `appId`, so the resulting
  app installs alongside `/Applications/ADE.app` rather than over it. That is
  the approved outcome, not a mistake.
