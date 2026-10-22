import type { VaultFile } from './types';

export interface VaultDerived {
  passkeys: Array<{
    id: string;
    deviceName: string;
    createdAt: string;
    lastUsed?: string;
  }>;
  remainingBackupCodes: number;
  totalBackupCodes: number;
}

/**
 * Derives display-safe vault values from the raw vault file.
 * Guards against partial vault files where arrays may be undefined.
 */
export function computeVaultDerived(vaultFile: VaultFile | null): VaultDerived {
  const passkeys = vaultFile?.passkeys?.map(p => ({
    id: p.id,
    deviceName: p.deviceName,
    createdAt: p.createdAt,
    lastUsed: p.lastUsed,
  })) ?? [];

  const remainingBackupCodes = vaultFile?.backupCodes?.filter(bc => !bc.used).length ?? 0;
  const totalBackupCodes = vaultFile?.backupCodes?.length ?? 0;

  return { passkeys, remainingBackupCodes, totalBackupCodes };
}
