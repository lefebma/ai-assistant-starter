# Projects

Drop STATE.md files here to track project state. The ProjectProvider auto-discovers them.

## Structure

```
projects/
  my-company/
    project-name/
      STATE.md
    another-project/
      STATE.md
  personal/
    side-project/
      STATE.md
```

## STATE.md Format

```markdown
---
project: Human-readable project name
company: my-company
status: active
priority: high
---

# Project Name -- State

## Current Phase
What's happening now.

## Active Tasks
- [ ] Task one
- [ ] Task two
- [x] Completed task

## Blockers
- Waiting on X

## Recent Activity
- 2026-05-22: Did the thing
```

The assistant will inject relevant project context when your message mentions project-related keywords.
