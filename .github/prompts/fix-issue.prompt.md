---
mode: agent
description: Plan a fix for a vfvic/event-map GitHub issue. Provide the issue number as input.
tools:
  - github
  - codebase
---

You are operating in **PLAN MODE**. Do not write or modify any code yet.

The issue number to fix is: $ISSUE_NUMBER

---

## Step 1 — Fetch the issue

Use the GitHub tool to fetch the full details of issue #$ISSUE_NUMBER from the `vfvic/event-map` repository, including the title, body, and labels.

---

## Step 2 — Understand the codebase

Search the codebase for only the files relevant to the issue. Start with the top-level structure, then read the files most likely involved (e.g. `script.js`, `styles.css`, `index.html`, `config.js`). Do not read files unrelated to the issue.

---

## Step 3 — Identify the root cause

State clearly:
- What is broken or missing
- Which file(s) and line(s) are responsible
- Why the current behaviour occurs

Keep this to 3–5 sentences maximum.

---

## Step 4 — Write the implementation plan

Structure the plan exactly as follows:

### Branch name
`fix/issue-$ISSUE_NUMBER-<short-slug>`

### Files to change
List each file and exactly what will be changed in it. Plain English only — no code yet.

### Implementation steps
A numbered list of the precise changes to make, in order. Each step must be atomic and unambiguous.

### What will NOT change
List anything adjacent to the fix that will be deliberately left untouched to avoid side-effects.

### Risks & side-effects to verify after implementation
List anything that could be inadvertently affected and should be manually checked after the fix.

### Test checklist
The specific checks a reviewer should carry out to confirm the fix works and has introduced no regressions.

---

## Step 5 — Stop and await approval

End your response with exactly this line:

> ✅ Plan complete for issue #$ISSUE_NUMBER. Please review the plan above and type **"implement"** when ready to proceed.

Do not write or modify any code until the user types "implement".

---

## When the user types "implement"

Follow these rules strictly:

1. **Cut a branch from main first:**
   ```bash
   git checkout main
   git pull origin main
   git checkout -b fix/issue-$ISSUE_NUMBER-<short-slug>
   ```

2. **Make the smallest possible change** that fixes the issue. Do not refactor, rename, reorganise, or improve anything outside the direct scope of the fix.

3. **Do not introduce new dependencies**, abstractions, utility functions, or patterns unless the issue explicitly requires them.

4. **After implementing**, perform a self-review before committing:
   - Re-read every line changed
   - Check for syntax errors, typos, and unintended whitespace changes
   - Confirm no files outside the plan were touched

5. **Stop after implementation.** Do not stage, commit, or push any changes. Leave that to the developer.

6. **Report back** with:
   - A summary of every change made and which lines were affected
   - The branch name ready to push
   - A suggested commit message for the developer to use:
     `fix: <short description> (closes #$ISSUE_NUMBER)`
   - The test checklist from the plan for the reviewer to action before merging
