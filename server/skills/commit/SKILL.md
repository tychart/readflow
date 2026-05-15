---
name: commit
description: "When the user asks to make a git commit, write one summarizing the changes."
license: MIT
metadata:
  author: readflow-team
  version: "1.0.0"
  repo: readflow
---

# Commit

## Trigger

User says something like: *"make a git commit"*, *"write a commit"*, *"commit this"*, *"git commit with a small description."*

## Action

Write a git commit:

1. `git add` only the files you changed
2. `git commit -m "type: summary"` — one line subject, optionally a short body
3. Keep the message small — describe what was done, not why

Do not stage unrelated files. Do not write a long message.
