---
name: audit-waves
description: Process audit findings from nx-audit-findings.jsonl into prioritized beads issues and specs.
---

# Audit Waves — Nexus

Process findings from `~/.claude/scripts/state/nx-audit-findings.jsonl` into actionable work items.

---

## Phase 0 — Load Findings

```bash
# Count unprocessed findings by severity
jq 'select(.processed == false) | .severity' ~/.claude/scripts/state/nx-audit-findings.jsonl 2>/dev/null | sort | uniq -c

# Show all unprocessed P1s
jq 'select(.processed == false and .severity == "P1")' ~/.claude/scripts/state/nx-audit-findings.jsonl 2>/dev/null
```

If no unprocessed findings: `echo "No findings to process. Run /audit-all first."`

---

## Phase 1 — Triage

Group findings by domain and severity. For each group:

| Severity | Action |
|----------|--------|
| P1 | Create beads bug immediately (`bd create --type=bug --priority=1`) |
| P2 | Create beads task (`bd create --type=task --priority=2`) |
| P3 | Create beads backlog (`bd create --type=task --priority=3`) |
| GCF | Create beads feature (`bd create --type=feature --priority=4`) |

---

## Phase 2 — Create Issues

For each unprocessed finding, create a beads issue:

```bash
# Example for P1
bd create --title="[domain] description" \
  --description="Finding from audit cycle [date]. File: file:line. Context: description." \
  --type=bug --priority=1

# Mark finding as processed
python3 -c "
import json, sys
lines = open('$HOME/.claude/scripts/state/nx-audit-findings.jsonl').readlines()
out = []
for line in lines:
    obj = json.loads(line)
    if obj.get('description') == 'FINDING_DESCRIPTION':
        obj['processed'] = True
    out.append(json.dumps(obj))
open('$HOME/.claude/scripts/state/nx-audit-findings.jsonl', 'w').write('\n'.join(out) + '\n')
"
```

---

## Phase 3 — Domain Specs

If 3+ findings in the same domain, consider creating an openspec:

```bash
/feature "Fix [domain] audit findings — wave [date]"
```

Group related P2/P3 findings from the same domain into a single spec for efficiency.

---

## Phase 4 — Domain Memory Update

After processing, update the relevant domain memory files with notes for next cycle:

```bash
# Append to .claude/audit/memory/[domain]-memory.md
echo "
## Wave [date]

### Issues Found ($(date +%Y-%m-%d))
| Sev | Description | Issue |
|-----|-------------|-------|
| [severity] | [description] | [beads-id] |

### Notes for next audit
- [what to check next cycle based on this wave]
" >> /home/nyaptor/dev/nx/.claude/audit/memory/[domain]-memory.md
```

---

## Output

```
## Audit Wave — [date]

Findings processed: N
  P1 → N bugs created
  P2 → N tasks created  
  P3 → N backlog items created
  GCF → N features created

Specs opened:
  - [spec-name] (N findings grouped)

Memory updated:
  - [domain]-memory.md (N domains)
```
