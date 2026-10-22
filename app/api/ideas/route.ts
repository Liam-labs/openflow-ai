import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { mutateChannels, saveChannels } from '@/lib/collab-channel-store';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import { appendMessage } from '@/lib/collab-message-io';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';
import { validateBodySize } from '@/lib/fetch-utils';
import type {
  IdeaBoardData,
  Idea,
  IdeaImage,
  IdeaActionRequest,
  IdeaActionResponse,
  CollabChannel,
} from '@/lib/types';


const DATA_PATH = DataPaths.ideas;
const IMAGES_DIR = DataPaths.ideaImages;

const DEFAULT_DATA: IdeaBoardData = {
  ideas: [],
  lastUpdated: new Date().toISOString(),
};

/**
 * Save a base64 data URL image to disk and return an IdeaImage.
 */
async function saveIdeaImage(
  dataUrl: string,
  ideaId: string,
  index: number
): Promise<IdeaImage | null> {
  try {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return null;

    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const base64Data = match[2];

    // Block SVG (XSS risk) and only allow safe raster formats
    const ALLOWED_EXTS = ['png', 'jpg', 'gif', 'webp', 'avif'];
    if (!ALLOWED_EXTS.includes(ext)) return null;

    // Size limit: reject base64 data > 10MB (decoded ~7.5MB)
    if (base64Data.length > 10 * 1024 * 1024) return null;
    const imageId = uuidv4().slice(0, 8);
    const filename = `idea-${ideaId.slice(0, 8)}-${index}-${imageId}.${ext}`;
    const filePath = path.join(IMAGES_DIR, filename);

    await fs.mkdir(IMAGES_DIR, { recursive: true });
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));

    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    return {
      id: imageId,
      filename,
      originalName: `image-${index}.${ext}`,
      mimeType: mimeTypes[ext] || 'application/octet-stream',
      url: `/api/ideas/images/${filename}`,
    };
  } catch (error) {
    console.error('[Ideas] Failed to save image:', error);
    return null;
  }
}

/**
 * Delete an idea's images from disk.
 */
async function deleteIdeaImages(images: IdeaImage[]): Promise<void> {
  for (const img of images) {
    try {
      const filePath = path.join(IMAGES_DIR, img.filename);
      await fs.unlink(filePath);
    } catch {
      // File may already be deleted
    }
  }
}

/**
 * GET /api/ideas - List all ideas (global)
 */
export const GET = tracked('/api/ideas', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
    const activeIdeas = data.ideas.filter(i => !i.archived);
    activeIdeas.sort((a, b) => a.sortOrder - b.sortOrder);

    return NextResponse.json<IdeaActionResponse>({
      success: true,
      ideas: activeIdeas,
    });
  } catch (error) {
    console.error('[Ideas] GET error:', error);
    return NextResponse.json<IdeaActionResponse>(
      { success: false, error: 'Failed to load ideas' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/ideas - CRUD actions
 */
export const POST = tracked('/api/ideas', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  const sizeError = validateBodySize(request);
  if (sizeError) return sizeError;
  try {
    const body: IdeaActionRequest = await request.json();
    const { action } = body;

    switch (action) {
      case 'create': {
        if (!body.title?.trim()) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Title is required' },
            { status: 400 }
          );
        }

        const newIdea: Idea = {
          id: uuidv4(),
          title: body.title.trim(),
          description: body.description?.trim() || '',
          images: [],
          tags: body.tags || [],
          channelId: body.channelId,
          createdBy: 'browser-user',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sortOrder: 0,
        };

        // Handle image if provided
        if (body.image?.data) {
          const saved = await saveIdeaImage(body.image.data, newIdea.id, 0);
          if (saved) {
            newIdea.images.push(saved);
          }
        }

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
          // Put new idea at the top
          newIdea.sortOrder = 0;
          data.ideas.forEach(i => i.sortOrder++);
          data.ideas.unshift(newIdea);
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        return NextResponse.json<IdeaActionResponse>({
          success: true,
          idea: newIdea,
        });
      }

      case 'update': {
        if (!body.ideaId) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'ideaId is required' },
            { status: 400 }
          );
        }

        let updatedIdea: Idea | undefined;

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
          const idea = data.ideas.find(i => i.id === body.ideaId);
          if (!idea) return;

          if (body.title !== undefined) idea.title = body.title.trim();
          if (body.description !== undefined) idea.description = body.description.trim();
          if (body.tags !== undefined) idea.tags = body.tags;
          if (body.channelId !== undefined) idea.channelId = body.channelId;
          idea.updatedAt = new Date().toISOString();

          updatedIdea = idea;
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        if (!updatedIdea) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Idea not found' },
            { status: 404 }
          );
        }

        return NextResponse.json<IdeaActionResponse>({
          success: true,
          idea: updatedIdea,
        });
      }

      case 'get': {
        if (!body.ideaId) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'ideaId is required' },
            { status: 400 }
          );
        }

        const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
        const idea = data.ideas.find(i => i.id === body.ideaId);
        if (!idea) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Idea not found' },
            { status: 404 }
          );
        }

        return NextResponse.json<IdeaActionResponse>({
          success: true,
          idea,
        });
      }

      case 'delete': {
        if (!body.ideaId) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'ideaId is required' },
            { status: 400 }
          );
        }

        let deletedIdea: Idea | undefined;

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
          const idx = data.ideas.findIndex(i => i.id === body.ideaId);
          if (idx === -1) return;

          deletedIdea = data.ideas[idx];
          data.ideas.splice(idx, 1);
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        if (!deletedIdea) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Idea not found' },
            { status: 404 }
          );
        }

        // Clean up images from disk
        await deleteIdeaImages(deletedIdea.images);

        return NextResponse.json<IdeaActionResponse>({ success: true });
      }

      case 'archive': {
        if (!body.ideaId) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'ideaId is required' },
            { status: 400 }
          );
        }

        let archivedIdea: Idea | undefined;

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
          const idea = data.ideas.find(i => i.id === body.ideaId);
          if (!idea) return;

          idea.archived = true;
          idea.updatedAt = new Date().toISOString();
          archivedIdea = idea;
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        if (!archivedIdea) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Idea not found' },
            { status: 404 }
          );
        }

        return NextResponse.json<IdeaActionResponse>({
          success: true,
          idea: archivedIdea,
        });
      }

      case 'upload_image': {
        if (!body.ideaId) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'ideaId is required' },
            { status: 400 }
          );
        }
        if (!body.image?.data) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'image.data is required' },
            { status: 400 }
          );
        }

        let resultIdea: Idea | undefined;
        let imageUrl: string | undefined;

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
          const idea = data.ideas.find(i => i.id === body.ideaId);
          if (!idea) return;

          const saved = await saveIdeaImage(
            body.image!.data,
            idea.id,
            idea.images.length
          );
          if (saved) {
            if (body.image!.name) saved.originalName = body.image!.name;
            idea.images.push(saved);
            imageUrl = saved.url;
          }
          idea.updatedAt = new Date().toISOString();
          resultIdea = idea;
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        if (!resultIdea) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Idea not found' },
            { status: 404 }
          );
        }

        return NextResponse.json<IdeaActionResponse>({
          success: true,
          idea: resultIdea,
          imageUrl,
        });
      }

      case 'reorder': {
        if (!body.ideaId || body.sortOrder === undefined) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'ideaId and sortOrder are required' },
            { status: 400 }
          );
        }

        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
          const idea = data.ideas.find(i => i.id === body.ideaId);
          if (!idea) return;

          idea.sortOrder = body.sortOrder!;
          idea.updatedAt = new Date().toISOString();
          data.lastUpdated = new Date().toISOString();
          await writeJsonFile(DATA_PATH, data);
        });

        return NextResponse.json<IdeaActionResponse>({ success: true });
      }

      case 'link_channel': {
        if (!body.ideaId) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'ideaId is required' },
            { status: 400 }
          );
        }

        // Read the idea first
        const ideaData = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
        const idea = ideaData.ideas.find(i => i.id === body.ideaId);
        if (!idea) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Idea not found' },
            { status: 404 }
          );
        }

        // If already linked, return the existing channel
        if (idea.channelId) {
          return NextResponse.json<IdeaActionResponse>({
            success: true,
            idea,
          });
        }

        // Create a new collab channel for this idea
        let newChannelId: string | undefined;

        await mutateChannels('ideas:create-channel', async collabData => {
          const BROWSER_PARTICIPANT_ID = 'browser-user-participant';
          const now = new Date().toISOString();

          const newChannel: CollabChannel = {
            id: uuidv4(),
            name: `Idea: ${idea.title}`,
            description: `Discussion channel for idea: ${idea.title}`,
            createdAt: now,
            lastActivity: now,
            ownerId: BROWSER_PARTICIPANT_ID,
            participants: [
              {
                id: BROWSER_PARTICIPANT_ID,
                type: 'user',
                name: HUMAN_ROUTING_NAME,
                source: 'DevFlow UI',
                joinedAt: now,
                lastSeen: now,
              },
            ],
            messages: [
              {
                id: uuidv4(),
                channelId: '', // will be set below
                from: {
                  id: 'system',
                  type: 'user',
                  name: 'Idea Board',
                  source: 'DevFlow',
                  joinedAt: now,
                  lastSeen: now,
                },
                content: `**Idea: ${idea.title}**\n\n${idea.description}${idea.tags.length > 0 ? `\n\nTags: ${idea.tags.join(', ')}` : ''}${idea.images.length > 0 ? `\n\n${idea.images.length} image(s) attached to this idea.` : ''}`,
                timestamp: now,
              },
            ],
            settings: {
              autoRespond: false,
            },
          };

          // Fix channelId in message
          newChannel.messages[0].channelId = newChannel.id;

          // Messages live in per-channel files; the store drops inline ones when it saves.
          const ideaMessage = newChannel.messages[0];
          collabData.channels.push(newChannel);
          await saveChannels(collabData);
          await appendMessage(newChannel.id, ideaMessage);

          newChannelId = newChannel.id;
        });

        if (!newChannelId) {
          return NextResponse.json<IdeaActionResponse>(
            { success: false, error: 'Failed to create channel' },
            { status: 500 }
          );
        }

        // Link the idea to the channel
        let linkedIdea: Idea | undefined;
        await withFileLock(DATA_PATH, async () => {
          const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
          const i = data.ideas.find(x => x.id === body.ideaId);
          if (i) {
            i.channelId = newChannelId;
            i.updatedAt = new Date().toISOString();
            linkedIdea = i;
            data.lastUpdated = new Date().toISOString();
            await writeJsonFile(DATA_PATH, data);
          }
        });

        return NextResponse.json<IdeaActionResponse>({
          success: true,
          idea: linkedIdea,
        });
      }

      case 'list': {
        const data = await readJsonFile<IdeaBoardData>(DATA_PATH, DEFAULT_DATA);
        const activeIdeas = data.ideas.filter(i => !i.archived);
        activeIdeas.sort((a, b) => a.sortOrder - b.sortOrder);

        return NextResponse.json<IdeaActionResponse>({
          success: true,
          ideas: activeIdeas,
        });
      }

      default:
        return NextResponse.json<IdeaActionResponse>(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[Ideas] POST error:', error);
    return NextResponse.json<IdeaActionResponse>(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});
