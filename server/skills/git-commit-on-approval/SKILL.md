---
name: git-commit-on-approval
description: "When the user says 'Awesome, it works great! Would you now be able to write a git commit with a small description detailing what you did?' — write a concise git commit summarizing what was done."
license: MIT
metadata:
  author: readflow-team
  version: "1.0.0"
  repo: readflow
---

# Git Commit on Approval

## Trigger

User says: *"Awesome, it works great! Would you now be able to write a git commit with a small description detailing what you did?"*

Or any close variant expressing approval + asking for a commit.

## Action

Write a single `git commit` with:

- A short, descriptive message
- Include only the changes you made (staged or selectively added)
- Keep the description small — one or two sentences max

Example:

```bash
git add <files>
git commit -m "feat: <summary line>

<1-2 sentence description of what was done>"
```

Do not commit unrelated files. Do not amass a huge message. Keep it tight.
