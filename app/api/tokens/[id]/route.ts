/**
 * Individual Token Management Endpoints
 *
 * GET    /api/tokens/[id] - Get token details
 * DELETE /api/tokens/[id] - Revoke a token
 * PATCH  /api/tokens/[id] - Update token metadata
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  revokeToken,
  listTokens,
  loadTokensData,
  saveTokensData,
  validateApiToken,
  errorResponse,
  requireAuthOrLocal,
} from '@/lib/api-auth';
import { withFileLock } from '@/lib/data-io';
import { DataPaths } from '@/lib/data-paths';
import type { RevokeTokenResponse } from '@/lib/types';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Get token details by ID
 */
export const GET = tracked('/api/tokens/:id', async (
  request: NextRequest,
  { params }: RouteParams
) => {
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;
  try {
    const { id } = await params;

    const tokens = await listTokens();
    const token = tokens.find(t => t.id === id);

    if (!token) {
      return errorResponse('Token not found', 'NOT_FOUND', 404);
    }

    return NextResponse.json({
      success: true,
      token: {
        id: token.id,
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        scope: token.scope,
        createdAt: token.createdAt,
        createdBy: token.createdBy,
        expiresAt: token.expiresAt,
        lastUsedAt: token.lastUsedAt,
        lastUsedIp: token.lastUsedIp,
        usageCount: token.usageCount,
        isRevoked: token.isRevoked,
        revokedAt: token.revokedAt,
        revokedBy: token.revokedBy,
        metadata: token.metadata,
      },
    });
  } catch (error) {
    console.error('[api/tokens/[id]] GET error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get token',
      'INTERNAL_ERROR',
      500
    );
  }
});

/**
 * Revoke a token
 */
export const DELETE = tracked('/api/tokens/:id', async (
  request: NextRequest,
  { params }: RouteParams
) => {
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;
  try {
    const { id } = await params;

    // Determine revoker identity from token if present
    const authResult = await validateApiToken(request);
    const revokedBy = authResult.valid && authResult.token ? authResult.token.name : 'system';

    const result = await revokeToken(id, revokedBy);

    if (!result.success) {
      return errorResponse(
        result.error || 'Failed to revoke token',
        'NOT_FOUND',
        404
      );
    }

    const response: RevokeTokenResponse = {
      success: true,
      message: 'Token revoked successfully',
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[api/tokens/[id]] DELETE error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to revoke token',
      'INTERNAL_ERROR',
      500
    );
  }
});

/**
 * Update token metadata
 */
export const PATCH = tracked('/api/tokens/:id', async (
  request: NextRequest,
  { params }: RouteParams
) => {
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;
  try {
    const { id } = await params;
    const body = await request.json();
    if (body.keepAlive !== undefined && typeof body.keepAlive !== 'boolean') {
      return errorResponse('keepAlive must be a boolean', 'INVALID_FIELD', 400);
    }

    return await withFileLock(DataPaths.apiTokens, async () => {
      const data = await loadTokensData();
      const token = data.tokens.find(t => t.id === id);

      if (!token) {
        return errorResponse('Token not found', 'NOT_FOUND', 404);
      }

      if (token.revokedAt) {
        return errorResponse('Cannot update revoked token', 'CONFLICT', 409);
      }

      if (body.keepAlive !== undefined) {
        token.metadata = token.metadata || {};
        token.metadata.keepAlive = body.keepAlive;
      }

      // Update allowed fields
      if (body.name !== undefined) {
        token.name = String(body.name).trim();
      }

      if (body.description !== undefined) {
        token.metadata = token.metadata || {};
        token.metadata.description = body.description;
      }

      if (body.allowedIps !== undefined) {
        token.metadata = token.metadata || {};
        token.metadata.allowedIps = Array.isArray(body.allowedIps)
          ? body.allowedIps.filter((ip: unknown) => typeof ip === 'string')
          : undefined;
      }

      await saveTokensData(data);

      return NextResponse.json({
        success: true,
        message: 'Token updated successfully',
        token: {
          id: token.id,
          name: token.name,
          metadata: token.metadata,
        },
      });
    });
  } catch (error) {
    console.error('[api/tokens/[id]] PATCH error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to update token',
      'INTERNAL_ERROR',
      500
    );
  }
});
