# data/

Runtime state lives here and is created on first run:

- `tracking.json` - tracked accounts, groups, tiers, blacklist, polling mode
- `cursors.json` - per-account since_id cursors, so no post is read twice
- `usage.json` - API read counters behind the local budget brake

These files are git-ignored: they are local to your machine.
