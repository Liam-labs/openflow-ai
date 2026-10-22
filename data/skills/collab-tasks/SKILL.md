---
name: collab-tasks
description: >
  Turns a natural-language plan into a DevFlow Sprint → Phase → Task hierarchy with consistent naming and descriptions, and creates it through the DevFlow API. Use when a Team Lead needs a sprint structure generated from a plan.
---
# Collab Tasks

This skill parses project plans and generates structured task hierarchies for DevFlow collaboration channels.

## Your Role

When given a plan (text, markdown, or outline), you:
1. Identify logical sprint boundaries (major iterations)
2. Break each sprint into phases (logical work groupings)
3. Extract individual tasks from the plan
4. Create a consistent hierarchy via DevFlow Agent API

## Parsing Guidelines

### Sprint Identification

Look for:
- Major milestones or iterations
- Time-based sections (Week 1, Phase 1, etc.)
- Feature groupings (Core Features, Polish, etc.)
- If unclear, create 1-2 sprints max (avoid over-planning)

**Naming convention:** "Sprint N: [Brief Description]"
Example: "Sprint 1: Core Features"

### Phase Identification

Look for:
- Logical subsystems (Auth, Dashboard, API, etc.)
- Work streams that can be parallelized
- Related features that form a cohesive unit
- Typically 2-5 phases per sprint

**Naming convention:** "Phase N: [System/Feature]"
Example: "Phase 1: Authentication"

### Task Extraction

Look for:
- Concrete actionable items
- Technical implementation steps
- UI/UX work items
- Testing and documentation tasks

**Naming convention:** Brief imperative statement
Example: "Implement JWT login flow"

**Description:** Add context, acceptance criteria, or notes
Example: "Use JWT tokens stored in httpOnly cookies. Include refresh token logic."

## API Usage

You have access to the DevFlow Agent API via bearer token.

### Required Environment Variables

```bash
source ~/.secrets
# These must be set:
# - DEVFLOW_API_TOKEN: Your API token
# - CHANNEL_ID: The collab channel ID
# - PARTICIPANT_ID: Your participant ID in the channel
```

### API Endpoint

**Base URL:** `$DEVFLOW_URL/api/agent` (use `${DEVFLOW_URL:-http://localhost:3000}`; never hard-code `localhost:3000`)

### Example API Calls

**1. Create Sprint**

```bash
curl -X POST ${DEVFLOW_URL:-http://localhost:3000}/api/agent \
  -H "Authorization: Bearer $DEVFLOW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "sprints.create",
    "channelId": "'$CHANNEL_ID'",
    "participantId": "'$PARTICIPANT_ID'",
    "name": "Sprint 1: Core Features",
    "description": "Initial implementation of core functionality",
    "startDate": "2026-02-10T00:00:00Z",
    "endDate": "2026-02-24T23:59:59Z"
  }'
```

**2. Create Phase**

```bash
curl -X POST ${DEVFLOW_URL:-http://localhost:3000}/api/agent \
  -H "Authorization: Bearer $DEVFLOW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "phases.create",
    "channelId": "'$CHANNEL_ID'",
    "participantId": "'$PARTICIPANT_ID'",
    "sprintId": "'$SPRINT_ID'",
    "name": "Phase 1: Authentication",
    "description": "User login, session management, JWT tokens",
    "color": "#3B82F6"
  }'
```

**3. Create Task**

```bash
curl -X POST ${DEVFLOW_URL:-http://localhost:3000}/api/agent \
  -H "Authorization: Bearer $DEVFLOW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "tasks.create",
    "channelId": "'$CHANNEL_ID'",
    "participantId": "'$PARTICIPANT_ID'",
    "sprintId": "'$SPRINT_ID'",
    "phaseId": "'$PHASE_ID'",
    "title": "Implement JWT login flow",
    "description": "Use JWT tokens in httpOnly cookies with refresh logic",
    "priority": "high"
  }'
```

## Workflow

1. **Receive plan text** from user (via file or direct input)
2. **Parse plan** into sprint/phase/task structure
3. **Confirm structure** with user (show hierarchical outline)
4. **Create entities** via API in order: sprints → phases → tasks
5. **Report summary** with IDs and counts
6. **Post notification** to channel about new structure

## Output Format

After creating structure, show summary:

```
✅ Sprint structure created!

**Sprint 1: Core Features** (Feb 10 - Feb 24)
  📁 Phase 1: Authentication (5 tasks)
  📁 Phase 2: Dashboard (8 tasks)
  📁 Phase 3: API Integration (6 tasks)

**Sprint 2: Polish & Testing** (Feb 25 - Mar 10)
  📁 Phase 1: UI/UX Improvements (4 tasks)
  📁 Phase 2: Testing & Docs (7 tasks)

**Total:** 2 sprints, 5 phases, 30 tasks

Team members can now view the task board and claim work!
```

Then post this summary to the collab channel using:

```bash
curl -X POST ${DEVFLOW_URL:-http://localhost:3000}/api/agent \
  -H "Authorization: Bearer $DEVFLOW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "collab.message",
    "channelId": "'$CHANNEL_ID'",
    "participantId": "'$PARTICIPANT_ID'",
    "content": "<summary message here>"
  }'
```

## Error Handling

- **404 errors:** Channel or participant not found - check IDs
- **403 errors:** Insufficient permissions - Team Lead role may be required
- **400 errors:** Invalid data - check field formats (dates must be ISO 8601)
- **Parsing ambiguity:** Ask clarifying questions before creating structure

## Priority Assignment

When extracting tasks, infer priority:
- **High:** Critical features, blockers, security issues
- **Normal:** Standard features, most tasks (default)
- **Low:** Nice-to-haves, polish, optional enhancements

## Color Coding for Phases

Assign colors to phases for visual distinction:
- **#3B82F6** (Blue): Authentication, Security
- **#10B981** (Green): Data, Backend
- **#F59E0B** (Amber): UI/UX, Frontend
- **#8B5CF6** (Purple): Integration, API
- **#EC4899** (Pink): Testing, QA
- **#6366F1** (Indigo): Documentation, DevOps

## Example: Plan Parsing

**Input Plan:**

```markdown
# Project Plan

## Week 1-2: Foundation
- Set up authentication (JWT, sessions)
- Build dashboard layout
- Create API client

## Week 3-4: Features
- User profile management
- Settings page
- Dark mode support

## Week 5: Polish
- UI refinements
- Testing
- Documentation
```

**Your Output:**

1. **Parse structure:**
   - Sprint 1: Foundation (Weeks 1-2)
     - Phase 1: Authentication (1 task)
     - Phase 2: Dashboard (1 task)
     - Phase 3: API Client (1 task)
   - Sprint 2: Features (Weeks 3-4)
     - Phase 1: User Management (2 tasks)
     - Phase 2: Customization (1 task)
   - Sprint 3: Polish (Week 5)
     - Phase 1: Finalization (3 tasks)

2. **Create via API** (sprints first, then phases, then tasks)

3. **Report summary** with counts and IDs

## Best Practices

- **Confirm before creating:** Always show the parsed structure and ask user "Does this look correct?" before making API calls
- **Atomic operations:** Create all entities for one sprint before moving to the next
- **Capture IDs:** Store sprint/phase IDs as you create them to link child entities
- **Handle errors gracefully:** If an API call fails, report the error and stop (don't create partial structures)
- **Be conservative:** If unclear, create fewer sprints/phases rather than too many

## Tips

- Use descriptive phase names (not just "Phase 1")
- Keep task titles concise (< 50 chars)
- Add context in task descriptions (why, how, acceptance criteria)
- Distribute tasks evenly across phases when possible
- Mark foundational work as high priority

---

**Remember:** Your goal is to make the Team Lead's life easier by transforming raw plans into actionable, well-organized task boards. Quality over quantity - a well-structured 20-task sprint is better than a chaotic 100-task mess.

To improve this skill, edit `~/DevFlow/data/skills/collab-tasks/SKILL.md` and redeploy it with `python3 ~/DevFlow/data/scaffolding/sync.py --skills-only --skill collab-tasks`.
