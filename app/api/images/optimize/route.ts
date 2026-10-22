import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { OptimizeSettings, OptimizeResult, CropDirection } from '@/lib/types';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { getProjectById } from '@/lib/config';
import { tracked } from '@/lib/api-tracking';
import { appRoot } from '@/lib/app-paths';
import { getHomeDir } from '@/lib/home-dir';

export const dynamic = 'force-dynamic';

const HOME = getHomeDir();

function isAllowedImagePath(p: string): boolean {
  const resolved = path.resolve(p);
  if (resolved.startsWith(appRoot() + path.sep)) return true;
  if (resolved.startsWith(HOME + path.sep)) {
    const topDir = resolved.slice(HOME.length + 1).split(path.sep)[0];
    return topDir !== '' && !topDir.startsWith('.');
  }
  return false;
}

export const GET = tracked('/api/images/optimize', async (request: NextRequest) => {
  const denied = await requireAuthOrLocal(request as NextRequest, 'read');
  if (denied) return denied;

  return NextResponse.json(
    { success: false, error: 'Method not allowed. This endpoint only supports POST.' },
    { status: 405, headers: { Allow: 'POST' } }
  );
});

interface OptimizeRequest {
  images: string[];
  settings: OptimizeSettings;
}

async function optimizeImage(
  imagePath: string,
  settings: OptimizeSettings
): Promise<OptimizeResult> {
    const originalStats = await fs.stat(imagePath);
    const originalSize = originalStats.size;

    let image = sharp(imagePath);
    const metadata = await image.metadata();
    const originalWidth = metadata.width || 0;
    const originalHeight = metadata.height || 0;

    // Apply crop first
    if (settings.crop && settings.crop.amount > 0) {
      const cropAmount = settings.crop.unit === '%'
        ? Math.round((settings.crop.amount / 100) * (
            settings.crop.direction === 'left' || settings.crop.direction === 'right'
              ? originalWidth
              : originalHeight
          ))
        : settings.crop.amount;

      const cropRegion = getCropRegion(
        settings.crop.direction,
        cropAmount,
        originalWidth,
        originalHeight
      );

      if (cropRegion.width > 0 && cropRegion.height > 0) {
        image = image.extract(cropRegion);
      }
    }

    // Apply resize
    if (settings.resize && (settings.resize.width || settings.resize.height)) {
      const resizeOptions: sharp.ResizeOptions = {
        fit: settings.resize.maintainAspect ? 'inside' : 'fill',
      };
      if (settings.resize.width) resizeOptions.width = settings.resize.width;
      if (settings.resize.height) resizeOptions.height = settings.resize.height;
      image = image.resize(resizeOptions);
    }

    // Determine output format and path
    const ext = path.extname(imagePath);
    const baseName = path.basename(imagePath, ext);
    const dir = path.dirname(imagePath);

    let outputExt = ext;
    let outputPath: string;

    if (settings.format !== 'original') {
      outputExt = '.' + settings.format;
    }

    if (settings.overwrite && settings.format === 'original') {
      outputPath = imagePath;
    } else if (settings.overwrite && settings.format !== 'original') {
      // Different format, create new file with new extension
      outputPath = path.join(dir, baseName + outputExt);
    } else {
      // Create optimized version with suffix
      outputPath = path.join(dir, baseName + '.optimized' + outputExt);
    }

    // Apply format-specific optimization
    switch (settings.format) {
      case 'webp':
        image = image.webp({ quality: settings.quality });
        break;
      case 'jpeg':
        image = image.jpeg({ quality: settings.quality, mozjpeg: true });
        break;
      case 'png':
        image = image.png({ quality: settings.quality, compressionLevel: 9 });
        break;
      case 'original':
      default:
        // Apply quality based on original format
        if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
          image = image.jpeg({ quality: settings.quality, mozjpeg: true });
        } else if (metadata.format === 'png') {
          image = image.png({ quality: settings.quality });
        } else if (metadata.format === 'webp') {
          image = image.webp({ quality: settings.quality });
        }
        break;
    }

    // Write to temporary file first, then rename (safer)
    const tempPath = outputPath + `.tmp.${process.pid}.${Date.now()}`;
    let tempWritten = false;
    try {
      await image.toFile(tempPath);
      tempWritten = true;

      // Get new file size
      const newStats = await fs.stat(tempPath);
      const newSize = newStats.size;

      // Rename temp to final
      await fs.rename(tempPath, outputPath);
      tempWritten = false; // renamed successfully, no cleanup needed

      // If we created a new file and should delete original (when overwrite + format change)
      if (settings.overwrite && settings.format !== 'original' && outputPath !== imagePath) {
        try {
          await fs.unlink(imagePath);
        } catch {
          // Ignore deletion errors
        }
      }

      const savings = originalSize - newSize;
      const savingsPercent = Math.round((savings / originalSize) * 100);

      return {
        path: imagePath,
        originalSize,
        newSize,
        savings,
        savingsPercent,
        newPath: outputPath,
        success: true,
      };
    } catch (error) {
      // Clean up orphaned temp file on error
      if (tempWritten) {
        await fs.unlink(tempPath).catch(() => {});
      }
      console.error(`Error optimizing ${imagePath}:`, error);
      return {
        path: imagePath,
        originalSize: 0,
        newSize: 0,
        savings: 0,
        savingsPercent: 0,
        newPath: imagePath,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
}

function getCropRegion(
  direction: CropDirection,
  amount: number,
  width: number,
  height: number
): { left: number; top: number; width: number; height: number } {
  switch (direction) {
    case 'left':
      // Remove from left side
      return { left: amount, top: 0, width: Math.max(1, width - amount), height };
    case 'right':
      // Remove from right side
      return { left: 0, top: 0, width: Math.max(1, width - amount), height };
    case 'top':
      // Remove from top
      return { left: 0, top: amount, width, height: Math.max(1, height - amount) };
    case 'bottom':
      // Remove from bottom
      return { left: 0, top: 0, width, height: Math.max(1, height - amount) };
    case 'center':
      // Crop equally from all sides
      const halfAmount = Math.floor(amount / 2);
      return {
        left: halfAmount,
        top: halfAmount,
        width: Math.max(1, width - amount),
        height: Math.max(1, height - amount),
      };
    default:
      return { left: 0, top: 0, width, height };
  }
}

export const POST = tracked('/api/images/optimize', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    let body: OptimizeRequest;
    try {
      body = await request.json() as OptimizeRequest;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON in request body. Expected: { images: string[], settings: OptimizeSettings }' },
        { status: 400 }
      );
    }
    const { images, settings } = body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ success: false, error: 'No images provided' }, { status: 400 });
    }

    if (images.length > 100) {
      return NextResponse.json({ success: false, error: 'Too many images — max 100 per request' }, { status: 400 });
    }

    if (!settings) {
      return NextResponse.json({ success: false, error: 'Settings are required' }, { status: 400 });
    }

    // Path traversal guard: all image paths must be under $HOME or project root
    for (const imagePath of images) {
      if (!isAllowedImagePath(imagePath)) {
        return NextResponse.json(
          { success: false, error: `Access to path not allowed: ${imagePath}` },
          { status: 403 }
        );
      }
    }

    const results: OptimizeResult[] = [];
    let totalOriginalSize = 0;
    let totalNewSize = 0;

    for (const imagePath of images) {
      const result = await optimizeImage(imagePath, settings);
      results.push(result);
      if (result.success) {
        totalOriginalSize += result.originalSize;
        totalNewSize += result.newSize;
      }
    }

    const totalSavings = totalOriginalSize - totalNewSize;
    const totalSavingsPercent = totalOriginalSize > 0
      ? Math.round((totalSavings / totalOriginalSize) * 100)
      : 0;

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    return NextResponse.json({
      success: true,
      results,
      summary: {
        processed: images.length,
        succeeded: successCount,
        failed: failedCount,
        totalOriginalSize,
        totalNewSize,
        totalSavings,
        totalSavingsPercent,
        totalOriginalSizeFormatted: formatBytes(totalOriginalSize),
        totalNewSizeFormatted: formatBytes(totalNewSize),
        totalSavingsFormatted: formatBytes(totalSavings),
      },
    });
  } catch (error) {
    console.error('Image optimization error:', error);
    return NextResponse.json(
      { success: false, error: `Image optimization failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
