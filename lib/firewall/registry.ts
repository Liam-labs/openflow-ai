/**
 * The port registry: names, purposes and intended exposure for the ports each machine listens on, and friendly names for addresses we know.
 * It lives in data/firewall/registry.json so a person (or an agent that has just built a service) can add a line, which is step one of
 * "granting access" (platform/granting-access.md). A listening port that is not in it still shows up, flagged as unregistered.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { NamedAddress } from './exposure';
import { parseAddress } from './net';

/** desktop-only and server-only mean "the other DevFlow machine and nothing else": the desktop for a port on the server, the server for a port on the desktop. */
export type Intended = 'this-machine' | 'desktop-only' | 'server-only' | 'tailnet' | 'home-network' | 'public' | 'nobody';
export const INTENDED: Intended[] = ['this-machine', 'desktop-only', 'server-only', 'tailnet', 'home-network', 'public', 'nobody'];

export type RunsIn = 'windows' | 'wsl';

export interface RegistryEntry {
  port: number;
  proto: 'tcp' | 'udp';
  /** The desktop has two network stacks, Windows and WSL, whose port numbers are independent. Leave out when the entry fits either. */
  runsIn?: RunsIn;
  /** Only a program whose name starts with this (case ignored, ".exe" ignored) is meant. Leave out when the port number alone identifies it. */
  process?: string;
  name: string;
  kind: 'service' | 'tool' | 'system';
  purpose: string;
  intended: Intended;
}

export type MachineId = 'server' | 'desktop';
export interface Registry {
  /** The name the desktop goes by on the tailnet; a port meant for "the desktop only" may be reached by this device and no other. */
  desktopName: string;
  /** The same for the Remote server. */
  serverName: string;
  addresses: NamedAddress[];
  machines: Record<MachineId, RegistryEntry[]>;
}

export const DEFAULT_DESKTOP_NAME = process.env.DEVFLOW_DESKTOP_NAME || 'Desktop';
export const DEFAULT_SERVER_NAME = 'Remote server';

export const emptyRegistry = (): Registry => ({ desktopName: DEFAULT_DESKTOP_NAME, serverName: DEFAULT_SERVER_NAME, addresses: [], machines: { server: [], desktop: [] } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict on shape, lenient on mistakes: a bad entry is skipped, never a reason to lose the whole registry. */
export function parseRegistry(json: unknown): Registry {
  const out = emptyRegistry();
  if (!isObj(json)) return out;
  if (typeof json.desktopName === 'string' && json.desktopName.trim()) out.desktopName = json.desktopName.trim().slice(0, 80);
  if (typeof json.serverName === 'string' && json.serverName.trim()) out.serverName = json.serverName.trim().slice(0, 80);
  if (Array.isArray(json.addresses)) {
    for (const a of json.addresses) {
      if (isObj(a) && typeof a.address === 'string' && parseAddress(a.address) && typeof a.name === 'string' && a.name.trim()) {
        out.addresses.push({ address: a.address, name: a.name.trim().slice(0, 80) });
      }
    }
  }
  const machines = isObj(json.machines) ? json.machines : {};
  for (const id of ['server', 'desktop'] as MachineId[]) {
    const list = isObj(machines[id]) && Array.isArray((machines[id] as { listeners?: unknown }).listeners) ? (machines[id] as { listeners: unknown[] }).listeners : [];
    for (const e of list) {
      if (!isObj(e)) continue;
      const port = e.port;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (e.proto !== 'tcp' && e.proto !== 'udp') continue;
      if (typeof e.name !== 'string' || !e.name.trim()) continue;
      out.machines[id].push({
        port, proto: e.proto, name: e.name.trim().slice(0, 80),
        ...(e.runsIn === 'windows' || e.runsIn === 'wsl' ? { runsIn: e.runsIn } : {}),
        ...(typeof e.process === 'string' && e.process.trim() ? { process: e.process.trim().toLowerCase().replace(/\.exe$/, '').slice(0, 80) } : {}),
        kind: e.kind === 'tool' || e.kind === 'system' ? e.kind : 'service',
        purpose: typeof e.purpose === 'string' ? e.purpose.trim().slice(0, 300) : '',
        intended: INTENDED.includes(e.intended as Intended) ? (e.intended as Intended) : 'nobody',
      });
    }
  }
  return out;
}

let cache: { path: string; mtimeMs: number; value: Registry } | null = null;

export function registryPath(): string {
  return process.env.DEVFLOW_FIREWALL_REGISTRY || path.join(process.cwd(), 'data', 'firewall', 'registry.json');
}

/** Reads the registry file, re-reading it when it changes. A missing or broken file gives an empty registry, so ports show up unregistered rather than not at all. */
export function loadRegistry(file = registryPath()): Registry {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (cache && cache.path === file && cache.mtimeMs === mtimeMs) return cache.value;
    const value = parseRegistry(JSON.parse(readFileSync(file, 'utf8')));
    cache = { path: file, mtimeMs, value };
    return value;
  } catch {
    return emptyRegistry();
  }
}

export function lookup(registry: Registry, machine: MachineId, proto: 'tcp' | 'udp', port: number, runsIn?: RunsIn, program?: string): RegistryEntry | undefined {
  const name = (program ?? '').toLowerCase().replace(/\.exe$/, '');
  const matching = registry.machines[machine].filter(e => e.proto === proto && e.port === port && (!e.process || name.startsWith(e.process)));
  return matching.find(e => e.runsIn === runsIn) ?? matching.find(e => !e.runsIn);
}
