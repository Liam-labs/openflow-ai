/** Builds the Firewall report: one entry per machine, cached for 30 seconds (the work shells out to sudo, asks the PC's helper, and reads whole rule sets). */
import { collectDesktop, type DesktopCollection } from './collect-desktop';
import { collectServer, type ServerCollection } from './collect-server';
import { serverControls } from './controls';
import { buildWindowsPorts, buildWslPorts, desktopControls, windowsRuleRows, wslIsBehindNat } from './desktop-model';
import { loadRegistry, type Registry } from './registry';
import { buildPorts, buildServerSnapshot, namedAddresses, ruleRows } from './server-model';
import type { FirewallPort, FirewallReport, MachineReport } from './types';
import { parseWinFacts } from './windows';

const SERVER_LABEL = 'Remote server';
const DESKTOP_LABEL = 'Desktop PC';
const TTL_MS = 30000;
const MIN_REFRESH_MS = 5000;

const ROUTER_NOTE = "\"Anyone on the internet\" means this machine's own firewall would let such a connection in if it ever arrived. Your router's firewall is a separate first layer that this report cannot see.";

function unreachable(id: MachineReport['id'], label: string, reason: string, tool: MachineReport['firewall']['tool']): MachineReport {
  return { id, label, reachable: false, reason, firewall: { tool, enabled: false, defaultIncoming: 'unknown', defaultOutgoing: 'unknown', error: reason }, ports: [], rules: [], controls: [] };
}

export function serverReportFrom(collected: ServerCollection, registry: Registry): MachineReport {
  if (collected.missing.length) {
    return unreachable('server', SERVER_LABEL, `Could not read ${collected.missing.join('; ')}`, 'ufw');
  }
  const snapshot = buildServerSnapshot(collected.raw, registry);
  const ports = buildPorts(snapshot, registry, 'server');
  return {
    id: 'server', label: SERVER_LABEL, reachable: true,
    firewall: { tool: 'ufw', enabled: snapshot.ufw.enabled, defaultIncoming: snapshot.ufw.defaultIncoming, defaultOutgoing: snapshot.ufw.defaultOutgoing },
    ports,
    rules: ruleRows(snapshot.ufw, snapshot.model.named),
    controls: serverControls({ ufw: snapshot.ufw, model: snapshot.model, ports, sshd: collected.sshd, fail2ban: collected.fail2ban, rebootRequired: collected.rebootRequired }),
    notes: [ROUTER_NOTE, 'Worked out from the live ufw, iptables and Docker rules, not from a list of what was meant to be open.'],
  };
}

const SEVERITY = { open: 0, unknown: 1, allowed: 2, blocked: 3, 'local-only': 4 } as const;
const bySeverity = (a: FirewallPort, b: FirewallPort): number =>
  SEVERITY[a.exposure] - SEVERITY[b.exposure] || (a.runsIn === b.runsIn ? 0 : a.runsIn === 'windows' ? -1 : 1) || a.port - b.port || a.proto.localeCompare(b.proto);

export function desktopReportFrom(collected: DesktopCollection, registry: Registry): MachineReport {
  const facts = parseWinFacts(collected.windows);
  if (!facts) return unreachable('desktop', DESKTOP_LABEL, 'The desktop helper sent a report this version cannot read.', 'windows-firewall');
  const named = namedAddresses(registry, facts.tailnet.flatMap(t => t.ips.map(address => ({ address, name: t.hostName }))));
  const windows = buildWindowsPorts(facts, registry, named);
  const wsl = buildWslPorts(facts, collected.wsl, registry);
  const ports = [...windows.ports, ...wsl.ports].sort(bySeverity);
  const omitted = windows.omitted + wsl.omitted;
  const enabled = facts.profiles.every(p => p.enabled);
  const word = (n: number): string => (n === 0 ? 'deny' : 'allow');
  const incoming = new Set(facts.profiles.map(p => word(p.defaultInbound)));
  const outgoing = new Set(facts.profiles.map(p => word(p.defaultOutbound)));
  return {
    id: 'desktop', label: DESKTOP_LABEL, reachable: true,
    firewall: { tool: 'windows-firewall', enabled, defaultIncoming: incoming.size === 1 ? Array.from(incoming)[0] : 'mixed', defaultOutgoing: outgoing.size === 1 ? Array.from(outgoing)[0] : 'mixed' },
    ports,
    rules: windowsRuleRows(facts, named),
    controls: desktopControls(facts, ports, wslIsBehindNat(facts, collected.wsl)),
    ...(omitted ? { omitted: { count: omitted, note: `${omitted} listening sockets are not listed: ones only this PC can reach (loopback addresses, or inside WSL) that nobody named, and short-lived UDP sockets on random ports that nothing can reach.` } } : {}),
    notes: [
      ROUTER_NOTE,
      'Worked out by applying the Windows Firewall rules as Windows lists them, and checked against live connection tests from WSL. Filters installed by other software (VPN kill switches, antivirus) are invisible to it.',
    ],
  };
}

export async function buildFirewallReport(
  collect: () => Promise<ServerCollection> = collectServer,
  registry: Registry = loadRegistry(),
  now: () => Date = () => new Date(),
  collectPc: () => Promise<DesktopCollection> = collectDesktop,
): Promise<FirewallReport> {
  const server = (async (): Promise<MachineReport> => {
    try {
      return serverReportFrom(await collect(), registry);
    } catch (error) {
      return unreachable('server', SERVER_LABEL, `The report failed: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 300), 'ufw');
    }
  })();
  const desktop = (async (): Promise<MachineReport> => {
    try {
      return desktopReportFrom(await collectPc(), registry);
    } catch (error) {
      return unreachable('desktop', DESKTOP_LABEL, (error instanceof Error ? error.message : 'The desktop could not be checked.').slice(0, 300), 'windows-firewall');
    }
  })();
  const [serverReport, desktopReport] = await Promise.all([server, desktop]);
  return { generatedAt: now().toISOString(), machines: [serverReport, desktopReport] };
}

interface Slot { at: number; report: FirewallReport }
const globals = globalThis as unknown as { __devflowFirewall?: { slot?: Slot; inflight?: Promise<FirewallReport> } };

/** Cached for 30 s; `refresh` skips the cache but not more often than every 5 s. Concurrent callers share one run. */
export async function getFirewallReport(options: { refresh?: boolean } = {}, build: () => Promise<FirewallReport> = buildFirewallReport): Promise<FirewallReport> {
  const state = (globals.__devflowFirewall ??= {});
  if (state.inflight) return state.inflight;
  const age = state.slot ? Date.now() - state.slot.at : Infinity;
  if (state.slot && age < (options.refresh ? MIN_REFRESH_MS : TTL_MS)) return state.slot.report;
  const run = build()
    .then(report => { state.slot = { at: Date.now(), report }; return report; })
    .finally(() => { state.inflight = undefined; });
  state.inflight = run;
  return run;
}
