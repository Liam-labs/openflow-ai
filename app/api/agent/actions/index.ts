/**
 * Agent API Action Registry
 *
 * Central registry for all action handlers. Each action is mapped to:
 * - A handler function that executes the action
 * - A required permission scope
 * - A description for documentation
 */

import type {
  AgentActionHandler,
  AgentActionEntry,
  ApiTokenScope,
} from '@/lib/types';

// Import action modules
import * as authActions from './auth';
import * as hearingActions from './hearing';
import * as projectsActions from './projects';
import * as pm2Actions from './pm2';
import * as sessionsActions from './sessions';
import * as collabActions from './collab';
import * as tasksActions from './tasks';
import * as sprintsActions from './sprints';
import * as phasesActions from './phases';
import * as loopsActions from './loops';
import * as docsActions from './docs';
import * as browserActions from './browser';
import * as rosterActions from './roster';
import * as modelsActions from './models';
import * as directivesActions from './directives';
import * as rolesActions from './roles';
import * as teamsActions from './teams';
import * as terminalTasksActions from './terminal-tasks';
import * as powershellActions from './powershell';
import * as cronActions from './cron';
import * as watchdogActions from './watchdog';
import * as gatewayActions from './gateway';
import * as usageActions from './usage';
import { handleTeamsBridgeAction } from './teams-bridge';
import { handleSlackBridgeAction } from './slack-bridge';
import * as skillsActions from './skills';
import * as computerUseActions from './computer-use';
import * as keepAliveActions from './keep-alive';
import * as toolsActions from './tools';
import * as errorsActions from './errors';
import * as catalogActions from './catalog';
import * as supabaseActions from './supabase';
import * as consolidateActions from './consolidate';
import * as outlookWatchesActions from './outlook-watches';
import { PRODUCT_NAME } from '@/lib/brand';

/**
 * Action registry
 * Maps action names to their handlers, required scopes, and descriptions
 */
const actionRegistry: Record<string, AgentActionEntry> = {
  // Hearing sessions: explicit client/participant bindings are enforced by the handler.
  'hearing.delivery_selftest': { handler: hearingActions.execute, requiredScope: 'admin', description: 'Exercise server-to-host hearing delivery against the isolated synthetic fixture only (constant content).' },
  'hearing.source_selftest': { handler: hearingActions.execute, requiredScope: 'admin', description: 'Verify the invented source fixture through a chosen host (hearing-source-verify v1); identities only.' },
  'hearing.delivery_trace': { handler: hearingActions.execute, requiredScope: 'admin', description: 'Content-free stage timeline (post, host inbox commit, wrapper inject/ingest, packet fetch, reply, expiry) for one hearing request.' },
  'hearing.cases': { handler: hearingActions.execute, requiredScope: 'read', description: 'Hearing protocol v1: cases; commissioned identity required.' },
  'hearing.open': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: open; commissioned identity required.' },
  'hearing.connection.check': { handler: hearingActions.execute, requiredScope: 'write', description: 'Content-free selected-agent connection check for the owning hearing client.' },
  'hearing.connection.ack': { handler: hearingActions.execute, requiredScope: 'write', description: 'Acknowledge an exact hearing connection check using the selected participant credential.' },
  'hearing.decide': { handler: hearingActions.execute, requiredScope: 'write', description: 'Classify current hearing response turn.' },
  'hearing.dispatch': { handler: hearingActions.execute, requiredScope: 'write', description: 'Dispatch one current response turn to selected case agent.' },
  'hearing.turn': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: acknowledged completed-source turn records.' },
  'hearing.append': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: append; commissioned identity required.' },
  'hearing.context': { handler: hearingActions.execute, requiredScope: 'read', description: 'Hearing protocol v1: context; commissioned identity required.' },
  'hearing.poll': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: poll; commissioned identity required.' },
  'hearing.heartbeat': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: heartbeat; commissioned identity required.' },
  'hearing.control': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: control; commissioned identity required.' },
  'hearing.resume': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: resume; commissioned identity required.' },
  'hearing.packet': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: packet; commissioned identity required.' },
  'hearing.prepare': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: complete packet before the model turn; no reading status or presence change; commissioned identity required.' },
  'hearing.ingested': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: stamp agent-side ingestion of a prepared packet; commissioned identity required.' },
  'hearing.reply': { handler: hearingActions.execute, requiredScope: 'write', description: 'Hearing protocol v1: reply; commissioned identity required.' },
  'hearing.evidence': { handler: hearingActions.execute, requiredScope: 'read', description: 'Hearing protocol v1: evidence; commissioned identity required.' },

  // ============================================
  // Authentication Actions
  // ============================================
  'auth.validate': {
    handler: authActions.validate,
    requiredScope: 'read',
    description: 'Validate the current API token',
  },
  'auth.whoami': {
    handler: authActions.whoami,
    requiredScope: 'read',
    description: 'Get current token metadata and permissions',
  },

  // ============================================
  // Projects Actions
  // ============================================
  'projects.list': {
    handler: projectsActions.list,
    requiredScope: 'read',
    description: 'List all projects',
  },
  'projects.get': {
    handler: projectsActions.get,
    requiredScope: 'read',
    description: 'Get a single project by ID',
  },
  'projects.create': {
    handler: projectsActions.create,
    requiredScope: 'write',
    description: 'Create a new project',
  },
  'projects.update': {
    handler: projectsActions.update,
    requiredScope: 'write',
    description: 'Update project configuration',
  },
  'projects.delete': {
    handler: projectsActions.remove,
    requiredScope: 'admin',
    description: 'Delete a project',
  },
  'projects.health': {
    handler: projectsActions.health,
    requiredScope: 'read',
    description: 'Run health checks for a project',
  },

  // ============================================
  // PM2 Actions
  // ============================================
  'pm2.list': {
    handler: pm2Actions.list,
    requiredScope: 'read',
    description: 'List all PM2 processes',
  },
  'pm2.status': {
    handler: pm2Actions.status,
    requiredScope: 'read',
    description: 'Get status of a specific PM2 process',
  },
  'pm2.start': {
    handler: pm2Actions.start,
    requiredScope: 'write',
    description: 'Start a PM2 process',
  },
  'pm2.stop': {
    handler: pm2Actions.stop,
    requiredScope: 'write',
    description: 'Stop a PM2 process',
  },
  'pm2.restart': {
    handler: pm2Actions.restart,
    requiredScope: 'write',
    description: 'Restart a PM2 process',
  },
  'pm2.logs': {
    handler: pm2Actions.logs,
    requiredScope: 'read',
    description: 'Get recent logs from a PM2 process',
  },

  // ============================================
  // Sessions Actions
  // ============================================
  'sessions.list': {
    handler: sessionsActions.list,
    requiredScope: 'read',
    description: 'List active Claude sessions',
  },
  'sessions.get': {
    handler: sessionsActions.get,
    requiredScope: 'read',
    description: 'Get details of a specific session',
  },
  'sessions.register': {
    handler: sessionsActions.register,
    requiredScope: 'write',
    description: 'Register this agent as a session',
  },
  'sessions.heartbeat': {
    handler: sessionsActions.heartbeat,
    requiredScope: 'write',
    description: 'Update session status/heartbeat',
  },
  'sessions.end': {
    handler: sessionsActions.end,
    requiredScope: 'write',
    description: 'Unregister/terminate a session',
  },
  'sessions.spawn': {
    handler: sessionsActions.spawn,
    requiredScope: 'write',
    description: 'Spawn a new terminal agent',
  },
  'sessions.spawn_pty': {
    handler: sessionsActions.spawnPty,
    requiredScope: 'write',
    description: 'Spawn a PTY-managed agent',
  },

  // ============================================
  // Collaboration Channel Actions
  // ============================================
  'collab.channels.list': {
    handler: collabActions.listChannels,
    requiredScope: 'read',
    description: 'List all collaboration channels',
  },
  'collab.channels.get': {
    handler: collabActions.getChannel,
    requiredScope: 'read',
    description: 'Get details of a specific channel',
  },
  'collab.channels.create': {
    handler: collabActions.createChannel,
    requiredScope: 'write',
    description: 'Create a new collaboration channel',
  },
  'collab.channels.delete': {
    handler: collabActions.deleteChannel,
    requiredScope: 'admin',
    description: 'Delete a collaboration channel',
  },
  'collab.channels.create_subchannel': {
    handler: collabActions.createSubChannel,
    requiredScope: 'write',
    description: 'Create a private sub-channel within an existing channel',
  },
  'collab.join': {
    handler: collabActions.join,
    requiredScope: 'write',
    description: 'Join a collaboration channel',
  },
  'collab.leave': {
    handler: collabActions.leave,
    requiredScope: 'write',
    description: 'Leave a collaboration channel',
  },
  'collab.message': {
    handler: collabActions.message,
    requiredScope: 'write',
    description: 'Send a message to a channel',
  },
  'collab.cross_channel_message': {
    handler: collabActions.message,
    requiredScope: 'write',
    description: 'Send a message between channels while preserving the source agent identity and injecting an exact cross-channel reply route',
  },
  'collab.presence': {
    handler: collabActions.presence,
    requiredScope: 'read',
    description: 'List who is online, away, or offline in a channel (check before addressing a cross-channel message)',
  },
  'collab.poll': {
    handler: collabActions.poll,
    requiredScope: 'read',
    description: 'Poll for new messages in a channel',
  },
  'collab.heartbeat': {
    handler: collabActions.heartbeat,
    requiredScope: 'write',
    description: 'Update presence status in a channel',
  },
  'collab.react': {
    handler: collabActions.react,
    requiredScope: 'write',
    description: 'Add an emoji reaction to a message',
  },
  'collab.recall': {
    handler: collabActions.recall,
    requiredScope: 'write',
    description: 'Recall an agent from another channel back to home channel',
  },

  // ============================================
  // Task Board Actions
  // ============================================
  'tasks.list': {
    handler: tasksActions.list,
    requiredScope: 'read',
    description: 'List tasks in a channel',
  },
  'tasks.create': {
    handler: tasksActions.create,
    requiredScope: 'write',
    description: 'Create a new task',
  },
  'tasks.update': {
    handler: tasksActions.update,
    requiredScope: 'write',
    description: 'Update a task',
  },
  'tasks.claim': {
    handler: tasksActions.claim,
    requiredScope: 'write',
    description: 'Claim a task',
  },
  'tasks.unclaim': {
    handler: tasksActions.unclaim,
    requiredScope: 'write',
    description: 'Release a claimed task',
  },
  'tasks.complete': {
    handler: tasksActions.complete,
    requiredScope: 'write',
    description: 'Mark a task as complete',
  },
  'tasks.assigned': {
    handler: tasksActions.assigned,
    requiredScope: 'read',
    description: 'Get in-progress tasks assigned to a participant in a channel',
  },
  'tasks.delete': {
    handler: tasksActions.remove,
    requiredScope: 'write',
    description: 'Delete a task',
  },
  'tasks.current': {
    handler: tasksActions.current,
    requiredScope: 'read',
    description: 'Get the active in-progress task claimed by a participant',
  },
  'tasks.next': {
    handler: tasksActions.next,
    requiredScope: 'read',
    description: 'Get the next unclaimed todo task in a channel',
  },
  'tasks.workflow': {
    handler: tasksActions.workflow,
    requiredScope: 'read',
    description: 'Sprint workflow entry: returns current task or next available; use at session start',
  },

  // ============================================
  // Sprint Management Actions
  // ============================================
  'sprints.list': {
    handler: sprintsActions.list,
    requiredScope: 'read',
    description: 'List sprints in a channel',
  },
  'sprints.create': {
    handler: sprintsActions.create,
    requiredScope: 'write',
    description: 'Create a new sprint',
  },
  'sprints.update': {
    handler: sprintsActions.update,
    requiredScope: 'write',
    description: 'Update sprint details',
  },
  'sprints.activate': {
    handler: sprintsActions.activate,
    requiredScope: 'write',
    description: 'Activate a sprint (deactivates others)',
  },
  'sprints.complete': {
    handler: sprintsActions.complete,
    requiredScope: 'write',
    description: 'Mark sprint as completed',
  },
  'sprints.progress': {
    handler: sprintsActions.progress,
    requiredScope: 'read',
    description: 'Get sprint progress with phase breakdown',
  },
  'sprints.health': {
    handler: sprintsActions.health,
    requiredScope: 'read',
    description: 'Audit sprint health: stale tasks, inactive agents, skipped phases, abandoned work',
  },
  'sprints.delete': {
    handler: sprintsActions.remove,
    requiredScope: 'write',
    description: 'Delete a sprint',
  },
  'sprints.reminder': {
    handler: sprintsActions.reminder,
    requiredScope: 'write',
    description: 'Check all channels for incomplete active sprints and post reminders (cron-friendly)',
  },
  'sprints.daily_summary': {
    handler: sprintsActions.dailySummary,
    requiredScope: 'write',
    description: 'Generate and post daily sprint summary to all channels (cron-friendly)',
  },
  'sprints.pause_reminder': {
    handler: sprintsActions.pauseReminder,
    requiredScope: 'write',
    description: 'Pause sprint reminders for a channel. Params: channelId, duration (1day|1week|1month), or clear:true to resume.',
  },
  'sprints.reminderSnooze': {
    handler: sprintsActions.reminderSnooze,
    requiredScope: 'write',
    description: 'Snooze stall reminders for a sprint. Params: sprintId, channelId, until (ISO timestamp), reason (optional). Auto-clears at until or on task update.',
  },
  'sprints.reminderUnsnooze': {
    handler: sprintsActions.reminderUnsnooze,
    requiredScope: 'write',
    description: 'Cancel sprint reminder snooze immediately. Params: sprintId, channelId.',
  },

  // ============================================
  // Phase Management Actions
  // ============================================
  'phases.list': {
    handler: phasesActions.list,
    requiredScope: 'read',
    description: 'List phases in a sprint or channel',
  },
  'phases.create': {
    handler: phasesActions.create,
    requiredScope: 'write',
    description: 'Create a new phase',
  },
  'phases.update': {
    handler: phasesActions.update,
    requiredScope: 'write',
    description: 'Update phase details',
  },
  'phases.progress': {
    handler: phasesActions.progress,
    requiredScope: 'read',
    description: 'Get phase progress',
  },
  'phases.reorder': {
    handler: phasesActions.reorder,
    requiredScope: 'write',
    description: 'Reorder phase within or between sprints',
  },
  'phases.delete': {
    handler: phasesActions.remove,
    requiredScope: 'write',
    description: 'Delete a phase',
  },

  // ============================================
  // Ralph Loop Actions
  // ============================================
  'loops.list': {
    handler: loopsActions.list,
    requiredScope: 'read',
    description: 'List active and history loops',
  },
  'loops.get': {
    handler: loopsActions.get,
    requiredScope: 'read',
    description: 'Get details of a specific loop',
  },
  'loops.submit_input': {
    handler: loopsActions.submitInput,
    requiredScope: 'write',
    description: 'Submit human input to an awaiting loop',
  },
  'loops.cancel': {
    handler: loopsActions.cancel,
    requiredScope: 'write',
    description: 'Cancel a running loop',
  },
  'loops.register': {
    handler: loopsActions.register,
    requiredScope: 'write',
    description: 'Register a project for loop monitoring',
  },

  // ============================================
  // Documentation Actions
  // ============================================
  'docs.list': {
    handler: docsActions.list,
    requiredScope: 'read',
    description: 'List all documents',
  },
  'docs.get': {
    handler: docsActions.get,
    requiredScope: 'read',
    description: 'Get a document by ID',
  },
  'docs.search': {
    handler: docsActions.search,
    requiredScope: 'read',
    description: 'Search documents',
  },
  'docs.create': {
    handler: docsActions.create,
    requiredScope: 'write',
    description: 'Create a new document',
  },
  'docs.delete': {
    handler: docsActions.remove,
    requiredScope: 'write',
    description: 'Delete a document',
  },

  // ============================================
  // Browser Testing Actions
  // ============================================
  'browser.status': {
    handler: browserActions.status,
    requiredScope: 'read',
    description: 'Get browser bridge status',
  },
  'browser.submit': {
    handler: browserActions.submit,
    requiredScope: 'write',
    description: 'Submit a browser test task',
  },
  'browser.result': {
    handler: browserActions.result,
    requiredScope: 'read',
    description: 'Get results of a browser task',
  },
  'browser.cancel': {
    handler: browserActions.cancel,
    requiredScope: 'write',
    description: 'Cancel a pending browser task',
  },

  // ============================================
  // Model Registry Actions
  // ============================================
  'models.list': {
    handler: modelsActions.list,
    requiredScope: 'read',
    description: 'List available AI models with roleDefaults and current overrides',
  },
  'models.sync': {
    handler: modelsActions.sync,
    requiredScope: 'write',
    description: 'Upsert or remove models in the registry. Params: upsert (ModelEntry[]), remove (string[])',
  },
  'models.setOverride': {
    handler: modelsActions.setOverride,
    requiredScope: 'write',
    description: 'Set a per-agent model override. Params: agentName, model, provider?, setBy?',
  },
  'models.removeOverride': {
    handler: modelsActions.removeOverride,
    requiredScope: 'write',
    description: 'Remove a per-agent model override. Params: agentName',
  },
  'models.configure': {
    handler: modelsActions.configure,
    requiredScope: 'write',
    description: 'Store provider auth config (authType only — keys go to vault). Params: provider, authType, configured?',
  },
  // Sprint M P1 T6 (Reynolds, 2026-05-27). Mirror of POST /api/models/detect
  // into the agent-API dispatcher. Same idempotent runIntegrationDetectionAndPersist
  // call; per the dual-path coverage rule from Q1's spec, both paths converge
  // on the same persistence boundary under withFileLock.
  'models.detect': {
    handler: modelsActions.detect,
    requiredScope: 'write',
    description: 'Run model-integration detection across the registry and persist any changed integration blocks. Idempotent — no infra change → no write.',
  },

  // ============================================
  // Roster Management Actions
  // ============================================
  'roster.list': {
    handler: rosterActions.list,
    requiredScope: 'read',
    description: 'List roster agents for a channel',
  },
  'roster.add': {
    handler: rosterActions.add,
    requiredScope: 'write',
    description: 'Add agent to channel roster',
  },
  'roster.remove': {
    handler: rosterActions.remove,
    requiredScope: 'write',
    description: 'Remove agent from roster',
  },
  'roster.update': {
    handler: rosterActions.update,
    requiredScope: 'write',
    description: 'Update roster agent config',
  },
  'roster.spawn': {
    handler: rosterActions.spawn,
    requiredScope: 'write',
    description: 'Launch a rostered agent',
  },
  'roster.kill': {
    handler: rosterActions.kill,
    requiredScope: 'write',
    description: 'Force-kill a running roster agent',
  },
  'roster.respawn': {
    handler: rosterActions.respawn,
    requiredScope: 'write',
    description: 'Kill and relaunch a roster agent',
  },
  'roster.compactAgent': {
    handler: rosterActions.compactAgent,
    requiredScope: 'write',
    description: 'Send /compact to a running agent via its tmux session',
  },
  'roster.launch_all': {
    handler: rosterActions.launchAll,
    requiredScope: 'write',
    description: 'Relaunch all stopped/crashed agents in channel',
  },
  'roster.provision': {
    handler: rosterActions.provision,
    requiredScope: 'write',
    description: 'Add agent to roster with role and spawn in one call (for Team Leads)',
  },
  'roster.recall': {
    handler: rosterActions.recall,
    requiredScope: 'write',
    description: 'Recall an away agent back to its home channel',
  },
  'collab.interrupt': {
    handler: rosterActions.interrupt,
    requiredScope: 'write',
    description: 'Interrupt a running agent and flush memory to today.md',
  },
  'roster.directives.read': {
    handler: directivesActions.read,
    requiredScope: 'read',
    description: 'Read directive files (Personality, Directives, Expertise) for a roster agent',
  },
  'roster.directives.write': {
    handler: directivesActions.write,
    requiredScope: 'write',
    description: 'Write a directive file for a roster agent',
  },
  'roster.prepareRestart': {
    handler: rosterActions.prepareRestart,
    requiredScope: 'write',
    description: 'Broadcast restart warning to all running agents so they save state',
  },
  'roster.personalities': {
    handler: rosterActions.personalities,
    requiredScope: 'read',
    description: 'List available character personalities from data/roles/personalities/',
  },
  'roster.switchModel': {
    handler: rosterActions.switchModel,
    requiredScope: 'write',
    description: 'Hot-swap a roster agent to a different model. Params: channelId, agentId|agentName, targetModel. Updates model + respawns on new wrapper.',
  },
  'roster.mcp.list': {
    handler: rosterActions.listMcp,
    requiredScope: 'read',
    description: 'List available MCP servers (global ~/.mcp.json + optional project-level .mcp.json)',
  },
  'roster.keepAlive': {
    handler: keepAliveActions.keepAlive,
    requiredScope: 'write',
    description: 'Manage keep-alive pings for roster agents (modes: start, stop, status, update, ping)',
  },

  // ============================================
  // Skills & Commands Actions
  // ============================================
  'skills.list': {
    handler: skillsActions.list,
    requiredScope: 'read',
    description: 'List available Claude Code slash commands and skills',
  },

  // ============================================
  // Roles Actions
  // ============================================
  'roles.list': {
    handler: rolesActions.list,
    requiredScope: 'read',
    description: 'List all available agent roles',
  },
  'roles.get': {
    handler: rolesActions.get,
    requiredScope: 'read',
    description: 'Get a specific role by ID or slug',
  },

  // ============================================
  // Teams Actions
  // ============================================
  'teams.list': {
    handler: teamsActions.list,
    requiredScope: 'read',
    description: 'List all persistent teams',
  },
  'teams.get': {
    handler: teamsActions.get,
    requiredScope: 'read',
    description: 'Get a single team by ID',
  },
  'teams.create': {
    handler: teamsActions.create,
    requiredScope: 'write',
    description: 'Create a new team template',
  },
  'teams.update': {
    handler: teamsActions.update,
    requiredScope: 'write',
    description: 'Update team metadata',
  },
  'teams.delete': {
    handler: teamsActions.remove,
    requiredScope: 'admin',
    description: 'Delete a team',
  },
  'teams.launch': {
    handler: teamsActions.launch,
    requiredScope: 'write',
    description: 'Launch a team into a channel',
  },
  'teams.add_agent': {
    handler: teamsActions.addAgent,
    requiredScope: 'write',
    description: 'Add an agent to a team template',
  },
  'teams.remove_agent': {
    handler: teamsActions.removeAgent,
    requiredScope: 'write',
    description: 'Remove an agent from a team template',
  },
  'teams.update_agent': {
    handler: teamsActions.updateAgent,
    requiredScope: 'write',
    description: 'Update an agent in a team template',
  },

  // ============================================
  // Terminal Tasks (AI Terminal Sessions)
  // ============================================
  'terminal.list': {
    handler: terminalTasksActions.list,
    requiredScope: 'read',
    description: 'List terminal tasks (AI sessions)',
  },
  'terminal.submit': {
    handler: terminalTasksActions.submit,
    requiredScope: 'write',
    description: 'Submit a new AI terminal task (prompt + model)',
  },
  'terminal.get': {
    handler: terminalTasksActions.get,
    requiredScope: 'read',
    description: 'Get a specific terminal task by ID',
  },
  'terminal.cancel': {
    handler: terminalTasksActions.cancel,
    requiredScope: 'write',
    description: 'Cancel a running terminal task',
  },
  'terminal.models': {
    handler: terminalTasksActions.models,
    requiredScope: 'read',
    description: 'List available AI models across all engines (Claude, Gemini, Ollama)',
  },
  'terminal.launch': {
    handler: terminalTasksActions.launch,
    requiredScope: 'write',
    description: 'Launch a terminal session for subscription-based provider auth. Opens the provider CLI (e.g. claude, gemini) in a tmux session. Params: provider ("anthropic" | "google")',
  },

  // ============================================
  // PowerShell Sessions (Cross-Platform Shell)
  // ============================================
  'powershell.list': {
    handler: powershellActions.list,
    requiredScope: 'read',
    description: 'List PowerShell sessions',
  },
  'powershell.create': {
    handler: powershellActions.create,
    requiredScope: 'write',
    description: 'Create a new persistent PowerShell session',
  },
  'powershell.get': {
    handler: powershellActions.get,
    requiredScope: 'read',
    description: 'Get a PowerShell session with live output',
  },
  'powershell.send': {
    handler: powershellActions.send,
    requiredScope: 'write',
    description: 'Send a command to a PowerShell session',
  },
  'powershell.output': {
    handler: powershellActions.output,
    requiredScope: 'read',
    description: 'Get current output from a PowerShell session',
  },
  'powershell.close': {
    handler: powershellActions.close,
    requiredScope: 'write',
    description: 'Close a PowerShell session',
  },

  // ============================================
  // Cron Jobs (Scheduled Tasks)
  // ============================================
  'cron.list': {
    handler: cronActions.list,
    requiredScope: 'read',
    description: 'List all cron jobs',
  },
  'cron.create': {
    handler: cronActions.create,
    requiredScope: 'write',
    description: 'Create a new scheduled cron job',
  },
  'cron.update': {
    handler: cronActions.update,
    requiredScope: 'write',
    description: 'Update a cron job',
  },
  'cron.delete': {
    handler: cronActions.remove,
    requiredScope: 'write',
    description: 'Delete a cron job',
  },
  'cron.toggle': {
    handler: cronActions.toggle,
    requiredScope: 'write',
    description: 'Enable or disable a cron job',
  },
  'cron.trigger': {
    handler: cronActions.trigger,
    requiredScope: 'write',
    description: 'Manually trigger a cron job execution',
  },
  'cron.history': {
    handler: cronActions.history,
    requiredScope: 'read',
    description: 'Get execution history for a cron job',
  },

  // ============================================
  // Gateway Actions (WebGate)
  // ============================================
  'gateway.list': {
    handler: gatewayActions.list,
    requiredScope: 'read',
    description: 'List all exposed gateway services',
  },
  'gateway.expose': {
    handler: gatewayActions.expose,
    requiredScope: 'write',
    description: 'Expose a service via Cloudflare Tunnel (name, port, locked?)',
  },
  'gateway.remove': {
    handler: gatewayActions.remove,
    requiredScope: 'write',
    description: 'Remove an exposed service',
  },
  'gateway.lock': {
    handler: gatewayActions.lock,
    requiredScope: 'write',
    description: 'Add Zero Trust auth to a service',
  },
  'gateway.unlock': {
    handler: gatewayActions.unlock,
    requiredScope: 'write',
    description: 'Remove Zero Trust auth from a service',
  },
  'gateway.status': {
    handler: gatewayActions.status,
    requiredScope: 'read',
    description: 'Get WebGate tunnel status and ingress rules',
  },

  // ============================================
  // Service Watchdog Actions
  // ============================================
  'watchdog.status': {
    handler: watchdogActions.status,
    requiredScope: 'read',
    description: 'Get watchdog status for all monitored services',
  },
  'watchdog.logs': {
    handler: watchdogActions.logs,
    requiredScope: 'read',
    description: 'Get recent watchdog events/logs',
  },
  'watchdog.toggle': {
    handler: watchdogActions.toggle,
    requiredScope: 'write',
    description: 'Enable or disable watchdog for a service (runtime)',
  },
  'watchdog.reset': {
    handler: watchdogActions.reset,
    requiredScope: 'write',
    description: 'Reset cooldown for a service watchdog',
  },

  // ============================================
  // Microsoft Teams Integration Actions
  // ============================================
  'msteams.status': {
    handler: (body) => handleTeamsBridgeAction('msteams.status', body),
    requiredScope: 'read',
    description: 'Get Microsoft Teams bridge connection status',
  },
  'msteams.configure': {
    handler: (body) => handleTeamsBridgeAction('msteams.configure', body),
    requiredScope: 'write',
    description: 'Configure Microsoft Teams bridge credentials',
  },
  'msteams.test': {
    handler: (body) => handleTeamsBridgeAction('msteams.test', body),
    requiredScope: 'write',
    description: 'Test connection to Microsoft Graph API',
  },
  'msteams.list-teams': {
    handler: (body) => handleTeamsBridgeAction('msteams.list-teams', body),
    requiredScope: 'read',
    description: 'List available Microsoft Teams',
  },
  'msteams.list-channels': {
    handler: (body) => handleTeamsBridgeAction('msteams.list-channels', body),
    requiredScope: 'read',
    description: 'List channels in a Microsoft Teams team',
  },
  'msteams.map-channel': {
    handler: (body) => handleTeamsBridgeAction('msteams.map-channel', body),
    requiredScope: 'write',
    description: `Link a ${PRODUCT_NAME} channel to a Microsoft Teams channel`,
  },
  'msteams.unmap-channel': {
    handler: (body) => handleTeamsBridgeAction('msteams.unmap-channel', body),
    requiredScope: 'write',
    description: `Remove a ${PRODUCT_NAME}-to-Teams channel mapping`,
  },
  'msteams.mappings': {
    handler: (body) => handleTeamsBridgeAction('msteams.mappings', body),
    requiredScope: 'read',
    description: 'List all channel mappings',
  },
  'msteams.create-channel': {
    handler: (body) => handleTeamsBridgeAction('msteams.create-channel', body),
    requiredScope: 'write',
    description: 'Create a new channel in a Microsoft Teams team',
  },
  'msteams.subscribe': {
    handler: (body) => handleTeamsBridgeAction('msteams.subscribe', body),
    requiredScope: 'write',
    description: 'Create Graph API subscription for Teams channel notifications',
  },
  'msteams.unsubscribe': {
    handler: (body) => handleTeamsBridgeAction('msteams.unsubscribe', body),
    requiredScope: 'write',
    description: 'Remove Graph API subscription for a channel',
  },
  'msteams.errors': {
    handler: (body) => handleTeamsBridgeAction('msteams.errors', body),
    requiredScope: 'read',
    description: 'Get recent Teams bridge sync errors',
  },
  'msteams.delete-channel': {
    handler: (body) => handleTeamsBridgeAction('msteams.delete-channel', body),
    requiredScope: 'write',
    description: 'Delete a Teams channel via Graph API',
  },
  'msteams.update-channel': {
    handler: (body) => handleTeamsBridgeAction('msteams.update-channel', body),
    requiredScope: 'write',
    description: 'Update a Teams channel name or description',
  },
  'msteams.auto-sync': {
    handler: (body) => handleTeamsBridgeAction('msteams.auto-sync', body),
    requiredScope: 'write',
    description: 'Configure auto-sync settings for channel lifecycle',
  },
  'msteams.backfill-refs': {
    handler: (body) => handleTeamsBridgeAction('msteams.backfill-refs', body),
    requiredScope: 'write',
    description: 'Backfill missing ConversationReferences for channel mappings',
  },

  // ============================================
  // Slack Integration Actions
  // ============================================
  'slack.status': {
    handler: (body) => handleSlackBridgeAction('slack.status', body),
    requiredScope: 'read',
    description: 'Get Slack bridge connection status',
  },
  'slack.configure': {
    handler: (body) => handleSlackBridgeAction('slack.configure', body),
    requiredScope: 'write',
    description: 'Configure Slack bridge settings',
  },
  'slack.test': {
    handler: (body) => handleSlackBridgeAction('slack.test', body),
    requiredScope: 'write',
    description: 'Test connection to Slack API',
  },
  'slack.list-channels': {
    handler: (body) => handleSlackBridgeAction('slack.list-channels', body),
    requiredScope: 'read',
    description: 'List Slack workspace channels',
  },
  'slack.create-channel': {
    handler: (body) => handleSlackBridgeAction('slack.create-channel', body),
    requiredScope: 'write',
    description: 'Create a new Slack channel',
  },
  'slack.archive-channel': {
    handler: (body) => handleSlackBridgeAction('slack.archive-channel', body),
    requiredScope: 'write',
    description: 'Archive a Slack channel',
  },
  'slack.rename-channel': {
    handler: (body) => handleSlackBridgeAction('slack.rename-channel', body),
    requiredScope: 'write',
    description: 'Rename a Slack channel',
  },
  'slack.join-channel': {
    handler: (body) => handleSlackBridgeAction('slack.join-channel', body),
    requiredScope: 'write',
    description: 'Join a Slack channel (bot joins itself)',
  },
  'slack.map-channel': {
    handler: (body) => handleSlackBridgeAction('slack.map-channel', body),
    requiredScope: 'write',
    description: `Link a ${PRODUCT_NAME} channel to a Slack channel`,
  },
  'slack.unmap-channel': {
    handler: (body) => handleSlackBridgeAction('slack.unmap-channel', body),
    requiredScope: 'write',
    description: `Remove a ${PRODUCT_NAME}-to-Slack channel mapping`,
  },
  'slack.mappings': {
    handler: (body) => handleSlackBridgeAction('slack.mappings', body),
    requiredScope: 'read',
    description: 'List all Slack channel mappings',
  },
  'slack.auto-sync': {
    handler: (body) => handleSlackBridgeAction('slack.auto-sync', body),
    requiredScope: 'write',
    description: 'Configure Slack auto-sync settings for channel lifecycle',
  },
  'slack.errors': {
    handler: (body) => handleSlackBridgeAction('slack.errors', body),
    requiredScope: 'read',
    description: 'Get recent Slack bridge sync errors',
  },
  'slack.poller': {
    handler: (body) => handleSlackBridgeAction('slack.poller', body),
    requiredScope: 'write',
    description: 'Start, stop, or check status of Slack inbound message poller',
  },
  'slack.bulk-sync': {
    handler: (body) => handleSlackBridgeAction('slack.bulk-sync', body),
    requiredScope: 'write',
    description: `Create Slack channels for all unmapped ${PRODUCT_NAME} channels (use dryRun:true to preview)`,
  },
  'slack.post-sprint': {
    handler: (body) => handleSlackBridgeAction('slack.post-sprint', body),
    requiredScope: 'write',
    description: 'Post a rich sprint progress card to the mapped Slack channel',
  },
  'slack.post-health': {
    handler: (body) => handleSlackBridgeAction('slack.post-health', body),
    requiredScope: 'write',
    description: 'Post a health dashboard card to a Slack channel',
  },
  'slack.post-roster': {
    handler: (body) => handleSlackBridgeAction('slack.post-roster', body),
    requiredScope: 'write',
    description: 'Post an agent roster card to the mapped Slack channel',
  },
  'slack.refresh-home': {
    handler: (body) => handleSlackBridgeAction('slack.refresh-home', body),
    requiredScope: 'write',
    description: 'Refresh the Slack App Home tab for a user or all tracked users',
  },
  'slack.notifications': {
    handler: (body) => handleSlackBridgeAction('slack.notifications', body),
    requiredScope: 'write',
    description: 'Configure event-driven Slack notifications (enable/disable, set channel, event types)',
  },
  'slack.queue': {
    handler: (body) => handleSlackBridgeAction('slack.queue', body),
    requiredScope: 'read',
    description: 'Outbound message queue status and manual drain. subAction: "status" (default) or "drain"',
  },
  'slack.send-file': {
    handler: (body) => handleSlackBridgeAction('slack.send-file', body),
    requiredScope: 'write',
    description: 'Upload a file to a Slack channel',
  },

  // ============================================
  // Token Usage Actions
  // ============================================
  'usage.agents': {
    handler: usageActions.agents,
    requiredScope: 'read',
    description: 'Get per-agent token usage for a channel (reads JSONL session files)',
  },
  'usage.summary': {
    handler: usageActions.summary,
    requiredScope: 'read',
    description: 'Get global token usage summary for today',
  },
  'usage.scrape': {
    handler: usageActions.scrape,
    requiredScope: 'write',
    description: 'Trigger a scrape of claude.ai/settings/usage (requires session cookie)',
  },
  'usage.subscription': {
    handler: usageActions.subscription,
    requiredScope: 'read',
    description: 'Get cached subscription usage data from claude.ai scraper',
  },
  'usage.set_cookie': {
    handler: usageActions.setCookie,
    requiredScope: 'admin',
    description: 'Store session cookie for claude.ai usage scraper',
  },

  // ============================================
  // Computer Use Actions
  // ============================================

  // Approach B: Task execution (primary path)
  'computer-use.task.run': {
    handler: computerUseActions.runTask,
    requiredScope: 'write',
    description: 'Run a computer use task via Claude Sonnet 4.6 sampling loop',
  },
  'computer-use.task.stop': {
    handler: computerUseActions.stopTask,
    requiredScope: 'write',
    description: 'Stop a running computer use task',
  },
  'computer-use.task.status': {
    handler: computerUseActions.taskStatus,
    requiredScope: 'read',
    description: 'Get computer use task status and result',
  },
  'computer-use.task.list': {
    handler: computerUseActions.listTasks,
    requiredScope: 'read',
    description: 'List computer use tasks (optionally filter by status)',
  },

  // Approach A: Raw primitives + session management
  'computer-use.session.start': {
    handler: computerUseActions.startSession,
    requiredScope: 'write',
    description: 'Start a computer use session (connects to Windows bridge)',
  },
  'computer-use.session.stop': {
    handler: computerUseActions.stopSession,
    requiredScope: 'write',
    description: 'Stop a computer use session',
  },
  'computer-use.session.list': {
    handler: computerUseActions.listSessions,
    requiredScope: 'read',
    description: 'List computer use sessions',
  },
  'computer-use.session.get': {
    handler: computerUseActions.getSessionAction,
    requiredScope: 'read',
    description: 'Get a computer use session by ID',
  },
  'computer-use.screenshot': {
    handler: computerUseActions.screenshot,
    requiredScope: 'write',
    description: 'Take a screenshot of the Windows desktop',
  },
  'computer-use.chat.send': {
    handler: computerUseActions.chatSend,
    requiredScope: 'write',
    description: 'Paste exact UTF-8 text into a chat/text box on the Windows desktop, verify it landed, send (Enter or send button), and return one cropped confirmation. Params: sessionId, text, target {x,y}|{locator:{name}}|{focused:true}, send ("enter"|"none"|{method:"click",x,y}), verify (default true), dryRun, space:"screenshot"+screenshotId (coords in screenshot pixels), confirmRegion, maxEdge, format. Never sends unless the box content matched.',
  },
  'computer-use.click': {
    handler: computerUseActions.click,
    requiredScope: 'write',
    description: 'Left-click at desktop coordinates',
  },
  'computer-use.double_click': {
    handler: computerUseActions.doubleClick,
    requiredScope: 'write',
    description: 'Double-click at desktop coordinates',
  },
  'computer-use.right_click': {
    handler: computerUseActions.rightClick,
    requiredScope: 'write',
    description: 'Right-click at desktop coordinates',
  },
  'computer-use.move': {
    handler: computerUseActions.moveMouse,
    requiredScope: 'write',
    description: 'Move mouse to coordinates',
  },
  'computer-use.drag': {
    handler: computerUseActions.drag,
    requiredScope: 'write',
    description: 'Drag from one position to another',
  },
  'computer-use.scroll': {
    handler: computerUseActions.scroll,
    requiredScope: 'write',
    description: 'Scroll at coordinates',
  },
  'computer-use.type': {
    handler: computerUseActions.typeText,
    requiredScope: 'write',
    description: 'Type text at the current cursor position',
  },
  'computer-use.key': {
    handler: computerUseActions.sendKey,
    requiredScope: 'write',
    description: 'Send a keyboard shortcut or key combination',
  },
  'computer-use.sequence': {
    handler: computerUseActions.sequence,
    requiredScope: 'write',
    description: 'Execute a sequence of actions with delays (batch multiple steps in one call)',
  },
  'computer-use.bridge.status': {
    handler: computerUseActions.bridgeStatus,
    requiredScope: 'read',
    description: 'Check computer use bridge health',
  },
  'computer-use.windows.list': {
    handler: computerUseActions.windowsList,
    requiredScope: 'read',
    description: 'List all visible windows with title, handle, position, and size (requires pywin32)',
  },
  'computer-use.windows.focus': {
    handler: computerUseActions.windowsFocus,
    requiredScope: 'write',
    description: 'Bring a window to the foreground by handle or partial title match (requires pywin32)',
  },
  'computer-use.launch': {
    handler: computerUseActions.launch,
    requiredScope: 'write',
    description: 'Launch an executable directly (path, args, cwd) — deterministic alternative to Win+R type dance. Returns pid and hwnd if a window appears.',
  },
  'computer-use.scroll.smart': {
    handler: computerUseActions.scrollSmart,
    requiredScope: 'write',
    description: 'Scroll incrementally until content stops moving (hash-based change detection). Params: x, y, direction (up|down), stepAmount (default 5), maxSteps (default 20), monitor, preset',
  },

  // ============================================
  // Computer Use — DOM Actions (Browser Accessibility via Playwright CDP)
  // ============================================
  'computer-use.dom.snapshot': {
    handler: computerUseActions.domSnapshot,
    requiredScope: 'read',
    description: 'Get browser accessibility tree as YAML text with ref IDs. Requires Chrome with --remote-debugging-port=9222. Params: sessionId, cdpUrl (optional)',
  },
  'computer-use.dom.click': {
    handler: computerUseActions.domClick,
    requiredScope: 'write',
    description: 'Click a browser element by accessibility ref ID (from dom.snapshot). Params: sessionId, ref',
  },
  'computer-use.dom.type': {
    handler: computerUseActions.domType,
    requiredScope: 'write',
    description: 'Type text into a browser element by accessibility ref ID. Params: sessionId, ref, text, clear (optional, default false)',
  },
  'computer-use.dom.select': {
    handler: computerUseActions.domSelect,
    requiredScope: 'write',
    description: 'Select an option in a browser select element by ref ID. Params: sessionId, ref, value',
  },

  // ============================================
  // Computer Use — UIA Actions (Windows Desktop Accessibility via pywinauto)
  // ============================================
  'computer-use.uia.snapshot': {
    handler: computerUseActions.uiaSnapshot,
    requiredScope: 'read',
    description: 'Get Windows desktop accessibility tree for a target window. Params: sessionId, handle (optional HWND), title (optional partial match), depth (optional, default 4)',
  },
  'computer-use.uia.click': {
    handler: computerUseActions.uiaClick,
    requiredScope: 'write',
    description: 'Click a desktop element by ref ID (from uia.snapshot). Params: sessionId, ref, method (optional: auto|invoke|click_input)',
  },
  'computer-use.uia.type': {
    handler: computerUseActions.uiaType,
    requiredScope: 'write',
    description: 'Type text into a desktop element by ref ID (from uia.snapshot). Params: sessionId, ref, text',
  },

  // ============================================
  // Computer Use — Context Detection
  // ============================================
  'computer-use.context.detect': {
    handler: computerUseActions.contextDetect,
    requiredScope: 'read',
    description: 'Detect foreground window context: browser (CDP), desktop (UIA), or unknown (screenshot fallback). Params: sessionId',
  },

  // ============================================
  // Computer Use — Grounding Layer
  // Context-aware element extraction via CDP → UIA → OllamaVision cascade.
  // ============================================
  'computer-use.grounding.snapshot': {
    handler: computerUseActions.groundingSnapshot,
    requiredScope: 'read',
    description: 'Extract UI elements via the GroundingRouter cascade (CDP → UIA → OllamaVision). Returns structured element map; fallbackNeeded=true means caller should use screenshot. Params: sessionId, region (optional {x,y,w,h})',
  },
  'computer-use.grounding.click': {
    handler: computerUseActions.groundingClick,
    requiredScope: 'write',
    description: 'Click a UI element by grounding registry ID (from grounding.snapshot). Bridge resolves ID → screen coordinates — no pixel coords needed. Params: sessionId, elementId, button (optional: left|right|middle)',
  },
  'computer-use.grounding.type': {
    handler: computerUseActions.groundingType,
    requiredScope: 'write',
    description: 'Type text into a UI element by grounding registry ID. Focuses element first, then types. Params: sessionId, elementId, text, interval (optional)',
  },
  'computer-use.grounding.status': {
    handler: computerUseActions.groundingStatus,
    requiredScope: 'read',
    description: 'Get availability status of each GroundingProvider (cdp, uia, ollama_vision). Params: sessionId',
  },

  // ============================================
  // Tools Library Actions
  // ============================================
  'tools.list': {
    handler: toolsActions.list,
    requiredScope: 'read',
    description: 'List all tools in the library. Optional filters: category, tag',
  },
  'tools.get': {
    handler: toolsActions.get,
    requiredScope: 'read',
    description: 'Get a tool by slug including guide content. Params: slug',
  },
  'tools.search': {
    handler: toolsActions.search,
    requiredScope: 'read',
    description: 'Search tools by name, description, tags, or category. Params: query',
  },

  // ============================================
  // Error Monitoring Actions
  // ============================================
  'errors.list': {
    handler: errorsActions.list,
    requiredScope: 'read',
    description: 'List recent tracked errors. Optional filters: severity, source, type (error:api|error:collab|error:agent), since (ISO timestamp), limit, offset',
  },
  'errors.stats': {
    handler: errorsActions.stats,
    requiredScope: 'read',
    description: 'Get error counts by type and severity for last 1h and 24h',
  },

  // ============================================
  // Systems Catalog Actions
  // ============================================
  'catalog.list': {
    handler: catalogActions.list,
    requiredScope: 'read',
    description: 'List catalog features. Optional filters: category, status, complexity, q (search), limit, offset',
  },
  'catalog.get': {
    handler: catalogActions.get,
    requiredScope: 'read',
    description: 'Get a single catalog feature by slug. Params: slug',
  },
  'catalog.upsert': {
    handler: catalogActions.upsert,
    requiredScope: 'write',
    description: 'Create or update a catalog feature. Params: slug (required), name, category, description, apiRoutes, apiActions, sourceFiles, etc.',
  },
  'catalog.delete': {
    handler: catalogActions.deleteFeature,
    requiredScope: 'admin',
    description: 'Delete a catalog feature and all related records. Params: slug',
  },
  'catalog.audit': {
    handler: catalogActions.audit,
    requiredScope: 'write',
    description: 'Record an audit result for a feature. Params: slug, auditor, passed, findings[], notes',
  },
  'catalog.audits': {
    handler: catalogActions.audits,
    requiredScope: 'read',
    description: 'Get audit history for a feature. Params: slug',
  },
  'catalog.issue': {
    handler: catalogActions.issue,
    requiredScope: 'write',
    description: 'File a known issue against a feature. Params: slug, title, severity, description',
  },
  'catalog.issues': {
    handler: catalogActions.issues,
    requiredScope: 'read',
    description: 'List open issues. Optional: slug (filter by feature)',
  },
  'catalog.resolveIssue': {
    handler: catalogActions.resolveIssue,
    requiredScope: 'write',
    description: 'Mark an issue as resolved. Params: issueId',
  },
  'catalog.improvement': {
    handler: catalogActions.improvement,
    requiredScope: 'write',
    description: 'Record an improvement for a feature. Params: slug, description, agent',
  },
  'catalog.improvements': {
    handler: catalogActions.improvements,
    requiredScope: 'read',
    description: 'Get improvement history for a feature. Params: slug',
  },

  // ============================================
  // Supabase Instance Registry Actions
  // ============================================
  'supabase.instances.list': {
    handler: supabaseActions.instancesList,
    requiredScope: 'read',
    description: 'List all registered Supabase instances',
  },
  'supabase.instances.get': {
    handler: supabaseActions.instancesGet,
    requiredScope: 'read',
    description: 'Get a Supabase instance by ID. Params: id',
  },
  'supabase.instances.upsert': {
    handler: supabaseActions.instancesUpsert,
    requiredScope: 'write',
    description: 'Create or update a Supabase instance. Params: name, type (local|hosted), url, anonKeyEnvVar, serviceRoleKeyEnvVar, projectId, linkedProjects[], notes',
  },
  'supabase.instances.delete': {
    handler: supabaseActions.instancesDelete,
    requiredScope: 'admin',
    description: 'Delete a Supabase instance. Params: id',
  },
  'supabase.instances.test': {
    handler: supabaseActions.instancesTest,
    requiredScope: 'write',
    description: 'Test connectivity to a registered instance. Params: id',
  },
  'supabase.instances.link': {
    handler: supabaseActions.instancesLink,
    requiredScope: 'write',
    description: `Link a ${PRODUCT_NAME} project to a Supabase instance. Params: instanceId, projectId`,
  },
  'supabase.instances.unlink': {
    handler: supabaseActions.instancesUnlink,
    requiredScope: 'write',
    description: `Unlink a ${PRODUCT_NAME} project from a Supabase instance. Params: instanceId, projectId`,
  },
  'supabase.query': {
    handler: supabaseActions.query,
    requiredScope: 'write',
    description: 'Execute a read query via Supabase client. Params: table, select, limit, instanceId (optional)',
  },
  'supabase.instances.discover': {
    handler: supabaseActions.instancesDiscover,
    requiredScope: 'read',
    description: 'Scan filesystem for local Supabase projects. Params: scanPaths (string[], default: $HOME), maxDepth (number, default: 3, max: 5), autoRegister (boolean, default: false)',
  },

  // ============================================
  // Knowledge Harvester Actions
  // ============================================
  'consolidate.run': {
    handler: consolidateActions.run,
    requiredScope: 'write',
    description: 'Trigger Knowledge Harvester on demand. Optional: channel (channelId), hours (number), force (bypass cooldown)',
  },
  'consolidate.status': {
    handler: consolidateActions.status,
    requiredScope: 'read',
    description: 'Check last Knowledge Harvester run time and cooldown state',
  },

  // ============================================
  // Outlook Watch CRUD (Sprint 1, T7)
  // ============================================
  'outlook.watch.create': {
    handler: outlookWatchesActions.create,
    requiredScope: 'write',
    description: 'Register an Outlook Graph push-notification routing filter. Body: ownerParticipantId, channelId, filter, folderId?, userId?, enabled?, notifyTemplate?. intervalMs is legacy compatibility data and must not be used to enable mailbox polling.',
  },
  'outlook.watch.list': {
    handler: outlookWatchesActions.list,
    requiredScope: 'read',
    description: 'List Outlook watches. Optional filters: ownerParticipantId, channelId, includeDisabled (default false)',
  },
  'outlook.watch.update': {
    handler: outlookWatchesActions.update,
    requiredScope: 'write',
    description: 'Patch an Outlook watch. Body: watchId, ownerParticipantId, patch{filter?,folderId?,intervalMs?,enabled?,notifyTemplate?}. Owner-mismatch returns 403.',
  },
  'outlook.watch.delete': {
    handler: outlookWatchesActions.remove,
    requiredScope: 'write',
    description: 'Delete an Outlook watch. Body: watchId, ownerParticipantId. Owner-mismatch returns 403.',
  },
};

/**
 * Get action handler by name
 */
export function getActionHandler(action: string): AgentActionHandler | null {
  const entry = actionRegistry[action];
  return entry?.handler || null;
}

/**
 * Get required scope for an action
 */
export function getRequiredScope(action: string): ApiTokenScope {
  const entry = actionRegistry[action];
  return entry?.requiredScope || 'admin'; // Default to admin if not found
}

/**
 * List all available actions for a given scope
 */
export function listAvailableActions(
  scope: ApiTokenScope
): Array<{ action: string; description: string; requiredScope: ApiTokenScope }> {
  const scopeLevel: Record<ApiTokenScope, number> = {
    read: 1,
    write: 2,
    admin: 3,
  };

  const userLevel = scopeLevel[scope];

  return Object.entries(actionRegistry)
    .filter(([, entry]) => scopeLevel[entry.requiredScope] <= userLevel)
    .map(([action, entry]) => ({
      action,
      description: entry.description,
      requiredScope: entry.requiredScope,
    }))
    .sort((a, b) => a.action.localeCompare(b.action));
}

/**
 * Get all action names
 */
export function getAllActionNames(): string[] {
  return Object.keys(actionRegistry).sort();
}
