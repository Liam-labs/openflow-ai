/**
 * API Token Management Endpoints
 *
 * GET  /api/tokens - List all tokens (requires admin scope or vault unlocked)
 * POST /api/tokens - Create a new token
 */

import { NextRequest, NextResponse } from 'next/server';
import { tracked } from '@/lib/api-tracking';
import {
  createToken,
  listTokens,
  validateApiToken,
  hasPermission,
  errorResponse,
  requireAuthOrLocal,
} from '@/lib/api-auth';
import type {
  CreateTokenRequest,
  CreateTokenResponse,
  ListTokensResponse,
  ApiTokenScope,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * List all tokens
 * Returns token metadata without the actual token values
 */
export const GET = tracked('/api/tokens', async (request: NextRequest) => {
  try {
    // Require auth token for external requests; localhost (dashboard) passes through
    const authDenied = await requireAuthOrLocal(request, 'admin');
    if (authDenied) return authDenied;

    const tokens = await listTokens();

    const response: ListTokensResponse = {
      success: true,
      tokens: tokens.map(t => ({
        id: t.id,
        name: t.name,
        tokenPrefix: t.tokenPrefix,
        scope: t.scope,
        createdAt: t.createdAt,
        createdBy: t.createdBy,
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
        usageCount: t.usageCount,
        isRevoked: t.isRevoked,
        metadata: t.metadata,
      })),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[api/tokens] GET error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to list tokens',
      'INTERNAL_ERROR',
      500
    );
  }
});

/**
 * Create a new token
 * Returns the full token value ONCE - it cannot be retrieved again
 */
export const POST = tracked('/api/tokens', async (request: NextRequest) => {
  // Require auth token for external requests; localhost (dashboard/setup) passes through. First, before the body is even read.
  const authDenied = await requireAuthOrLocal(request, 'admin');
  if (authDenied) return authDenied;

  try {
    const body = await request.json() as CreateTokenRequest;

    // Validate required fields
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return errorResponse('Token name is required', 'MISSING_FIELD', 400);
    }

    if (!body.scope || !['read', 'write', 'admin'].includes(body.scope)) {
      return errorResponse(
        'Valid scope is required (read, write, or admin)',
        'INVALID_FIELD',
        400
      );
    }

    if (body.keepAlive !== undefined && typeof body.keepAlive !== 'boolean') {
      return errorResponse('keepAlive must be a boolean', 'INVALID_FIELD', 400);
    }

    // Determine creator identity from token if present
    const authResult = await validateApiToken(request);
    let createdBy = 'system';
    if (authResult.valid && authResult.token) {
      createdBy = authResult.token.name;
    }

    const { token, record } = await createToken(
      body.name.trim(),
      body.scope as ApiTokenScope,
      createdBy,
      {
        expiresInDays: body.expiresInDays,
        keepAlive: body.keepAlive,
        description: body.description,
        environment: body.environment,
        allowedIps: body.allowedIps,
      }
    );

    const response: CreateTokenResponse = {
      success: true,
      token, // IMPORTANT: This is the only time the full token is returned
      tokenId: record.id,
      name: record.name,
      scope: record.scope,
      expiresAt: record.expiresAt,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('[api/tokens] POST error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to create token',
      'INTERNAL_ERROR',
      500
    );
  }
});
